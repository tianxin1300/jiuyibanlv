import test from "node:test";
import assert from "node:assert/strict";
import {
  CARE_SERVICE_FIELDS,
  CARE_STEP_FIELDS,
  CareHttpError,
  careOptionIds,
  validateCareCatalog,
  loadCareCatalog,
  matchCareCatalog,
  proxyFastGptMatch
} from "../care-catalog.js";

const makeSteps = (count = 7) => Array.from({ length: count }, (_, index) => ({
  step: index + 1,
  text: `第${index + 1}步说明`,
  materials: [`材料${index + 1}`],
  time: "工作日 09:00",
  location: "一楼服务台",
  official_url: "https://hospital.example/official"
}));

const makeService = (serviceId) => ({
  service_id: serviceId,
  name: "就诊陪伴",
  department: "全科",
  price: "价格口径待确认",
  clinic_hours: "周一至周五",
  materials: ["就诊卡"],
  booking_channel: "医院服务台",
  image_url: "img/tenant/service.jpg",
  service_type: "project",
  steps: makeSteps()
});

const makeCatalog = () => {
  const serviceA = makeService("svc-a");
  const serviceB = makeService("svc-b");
  return {
    catalog_version: "2026.11.22",
    options: {
      "opt-a1": "svc-a",
      "opt-b1": "svc-b",
      "opt-a2": "svc-a",
      "opt-b2": "svc-b"
    },
    services: {
      "svc-a": serviceA,
      "svc-b": serviceB
    }
  };
};

const careError = (status, code) => (error) => {
  assert.ok(error instanceof CareHttpError);
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  return true;
};

const catalogError = careError(503, "CATALOG_UNAVAILABLE");

test("内存 KV 中的合法目录保留八项服务字段并通过七步校验", async () => {
  const source = makeCatalog();
  const env = {
    KV: {
      async get(key, type) {
        assert.equal(key, "care:catalog:tenant-1");
        assert.equal(type, "json");
        return source;
      }
    }
  };
  const catalog = await loadCareCatalog(env, "tenant-1");

  assert.equal(catalog.catalog_version, source.catalog_version);
  assert.equal(CARE_SERVICE_FIELDS.length, 8);
  for (const [id, service] of Object.entries(catalog.services)) {
    assert.equal(service.service_id, id);
    for (const field of CARE_SERVICE_FIELDS) {
      assert.ok(Object.hasOwn(service, field), `${id} 应保留 ${field}`);
      assert.deepEqual(service[field], source.services[id][field]);
    }
    assert.equal(service.steps.length, 7);
    service.steps.forEach((step, index) => {
      assert.equal(step.step, index + 1);
      assert.ok(step.text);
      for (const field of CARE_STEP_FIELDS) assert.ok(Object.hasOwn(step, field));
    });
  }
});

test("八项服务字段缺任一项均为目录 503", () => {
  for (const field of CARE_SERVICE_FIELDS) {
    const catalog = makeCatalog();
    delete catalog.services["svc-a"][field];
    assert.throws(
      () => validateCareCatalog(catalog),
      (error) => {
        assert.equal(catalogError(error), true);
        assert.match(error.message, new RegExp(field));
        return true;
      }
    );
  }
});

test("七步必须数量精确、序号连续、说明有效且四个步骤字段齐全", () => {
  const invalidSteps = [
    (service) => { service.steps = service.steps.slice(0, 6); },
    (service) => { service.steps = makeSteps(8); },
    (service) => { [service.steps[0], service.steps[1]] = [service.steps[1], service.steps[0]]; },
    (service) => { delete service.steps[2].step; },
    (service) => { delete service.steps[2].text; },
    (service) => { service.steps[2].text = "  "; }
  ];
  for (const field of CARE_STEP_FIELDS) {
    invalidSteps.push((service) => { delete service.steps[3][field]; });
  }

  for (const invalidate of invalidSteps) {
    const catalog = makeCatalog();
    invalidate(catalog.services["svc-a"]);
    assert.throws(() => validateCareCatalog(catalog), catalogError);
  }
});

test("空目录、坏目录及 KV 读取失败均返回 503", () => {
  const badCatalogs = [null, undefined, [], "catalog", {}];
  const withoutVersion = makeCatalog();
  delete withoutVersion.catalog_version;
  badCatalogs.push(withoutVersion);

  const withoutServices = makeCatalog();
  withoutServices.services = {};
  badCatalogs.push(withoutServices);

  const mismatchedService = makeCatalog();
  mismatchedService.services["svc-a"].service_id = "svc-other";
  badCatalogs.push(mismatchedService);

  const badServiceType = makeCatalog();
  badServiceType.services["svc-a"].service_type = "unknown";
  badCatalogs.push(badServiceType);

  const missingTarget = makeCatalog();
  missingTarget.options["opt-a1"] = "svc-missing";
  badCatalogs.push(missingTarget);

  for (const catalog of badCatalogs) {
    assert.throws(() => validateCareCatalog(catalog), catalogError);
  }
});

test("loadCareCatalog 对空值、坏值、读取异常和未绑定 KV 均返回 503", async () => {
  for (const value of [null, {}, { catalog_version: "v", options: {}, services: {} }]) {
    await assert.rejects(
      loadCareCatalog({ KV: { get: async () => value } }, "tenant-1"),
      catalogError
    );
  }
  await assert.rejects(
    loadCareCatalog({ KV: { get: async () => { throw new Error("read failed"); } } }, "tenant-1"),
    catalogError
  );
  await assert.rejects(loadCareCatalog({}, "tenant-1"), careError(503, "KV_NOT_BOUND"));
});

test("全部院方公开资料与惠民活动均完整规范化，活动只能关联惠民服务", () => {
  const catalog = makeCatalog();
  catalog.services["svc-b"].service_type = "benefit";
  Object.assign(catalog, {
    n: "示例医院",
    w: "欢迎使用本院就诊服务",
    c: "#123abc",
    l: "asset:logo-1",
    splash: "就诊资料由患者自行整理",
    dept: ["全科", "儿科"],
    tel: { n: "总服务台", num: "010-12345678" },
    book: { n: "官方预约", url: "https://hospital.example/book" },
    vip: [{ t: "专人引导", d: "服务范围以院内公示为准" }],
    ann: [{ t: "门诊通知", d: "元旦排班已更新", date: "2026-11-23" }],
    pre: [{ t: "空腹检查", d: "是否空腹请听从医生安排" }],
    campus: [{ n: "东院区", addr: "示例路1号", tel: "010-12345678" }],
    sched: [{ wd: "周一", ap: "上午", dp: "全科", dr: "示例医生", nt: "以当日号源为准", st: "08:00", et: "12:00" }],
    dis: ["高血压", "糖尿病"],
    rg: { 收缩压: [90, 140], 空腹血糖: [3.9, 6.1] },
    showRef: true,
    hideRef: false
  });
  catalog.act = [{
    id: "health-draw", service_id: "svc-b", t: "惠民健康礼", kind: "wheel", per: "day", need: 2,
    start: "2026-11-01", end: "2026-12-31", valid: 30, pin: "1234",
    rule: "按活动规则参与", note: "不承诺中奖",
    items: [
      { t: "健康手册", d: "凭凭证领取", g: "参与奖", q: "100份", w: 80, n: false },
      { t: "谢谢参与", d: "欢迎下次参与", g: "", q: "", w: 20, n: true }
    ]
  }];

  const normalized = validateCareCatalog(catalog);
  for (const key of ["n", "w", "c", "l", "splash", "dept", "tel", "book", "vip", "ann", "pre", "campus", "sched", "dis", "rg", "showRef", "hideRef", "act"]) {
    assert.deepEqual(normalized[key], catalog[key], `${key} 应完整保留`);
  }
  assert.equal(normalized.act[0].service_id, "svc-b");
  assert.equal(normalized.act[0].items.length, 2);

  for (const serviceId of ["svc-a", "svc-missing"]) {
    const invalid = structuredClone(catalog);
    invalid.act[0].service_id = serviceId;
    assert.throws(() => validateCareCatalog(invalid), catalogError);
  }
});

test("option_ids 去重后精确匹配，同服务选项合并且服务按首次出现排序", () => {
  const catalog = validateCareCatalog(makeCatalog());
  const optionIds = careOptionIds([
    " opt-b1 ",
    "opt-a1",
    "opt-b2",
    "opt-a2",
    "opt-b1",
    " opt-a1 "
  ]);
  assert.deepEqual(optionIds, ["opt-b1", "opt-a1", "opt-b2", "opt-a2"]);

  const matched = matchCareCatalog(catalog, optionIds);
  assert.equal(matched.catalog_version, catalog.catalog_version);
  assert.deepEqual(matched.option_ids, optionIds);
  assert.deepEqual(matched.matches.map(({ service_id, option_ids }) => ({ service_id, option_ids })), [
    { service_id: "svc-b", option_ids: ["opt-b1", "opt-b2"] },
    { service_id: "svc-a", option_ids: ["opt-a1", "opt-a2"] }
  ]);
  assert.equal(matched.matches[0].service, catalog.services["svc-b"]);
  assert.equal(matched.matches[1].service, catalog.services["svc-a"]);
});

test("大小写或完整 ID 不一致的未知选项均返回 422", () => {
  const catalog = validateCareCatalog(makeCatalog());
  for (const optionId of ["missing", "OPT-A1", "opt-a", "opt-a10"]) {
    assert.throws(
      () => matchCareCatalog(catalog, [optionId]),
      careError(422, "UNKNOWN_OPTION_ID")
    );
  }
});

test("FastGPT 未配置时跳过，任一变量缺失时返回 503 且不发起请求", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("不应请求"); };
  assert.equal(await proxyFastGptMatch({}, "tenant-1", ["opt-a1"], fetchImpl), null);

  const key = "fastgpt-secret-key";
  for (const env of [
    { FASTGPT_URL: "https://fastgpt.example/api", FASTGPT_KEY: "" },
    { FASTGPT_URL: "", FASTGPT_KEY: key }
  ]) {
    await assert.rejects(
      proxyFastGptMatch(env, "tenant-1", ["opt-a1"], fetchImpl),
      (error) => {
        assert.equal(careError(503, "FASTGPT_CONFIG_INCOMPLETE")(error), true);
        assert.equal(String(error).includes(key), false);
        return true;
      }
    );
  }
  assert.equal(calls, 0);
});

test("FastGPT 同时配置时仅转发 tenant_id/option_ids，带 Bearer 和 AbortSignal，并透明返回 Response", async () => {
  const key = "fastgpt-secret-key";
  const upstream = new Response('{"upstream":true}', {
    status: 409,
    headers: { "Content-Type": "application/json", "X-Upstream": "FastGPT" }
  });
  let calls = 0;
  const result = await proxyFastGptMatch(
    {
      FASTGPT_URL: "https://fastgpt.example/api",
      FASTGPT_KEY: key,
      INTERNAL_SECRET: "不得转发"
    },
    "tenant-1",
    ["opt-a1", "opt-b1"],
    async (...args) => {
      calls += 1;
      assert.equal(args.length, 2);
      const [url, options] = args;
      assert.equal(url, "https://fastgpt.example/api");
      assert.equal(options.method, "POST");
      assert.deepEqual(options.headers, {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      });
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body), ["tenant_id", "option_ids"]);
      assert.deepEqual(body, { tenant_id: "tenant-1", option_ids: ["opt-a1", "opt-b1"] });
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return upstream;
    }
  );

  assert.equal(calls, 1);
  assert.equal(result, upstream);
  assert.equal(result.status, 409);
  assert.equal(result.headers.get("X-Upstream"), "FastGPT");
});

test("FastGPT 网络失败转换为 502，错误文本和堆栈均不泄露密钥", async () => {
  const key = "fastgpt-secret-key";
  await assert.rejects(
    proxyFastGptMatch(
      { FASTGPT_URL: "https://fastgpt.example/api", FASTGPT_KEY: key },
      "tenant-1",
      ["opt-a1"],
      async () => { throw new Error(`socket failed while using ${key}`); }
    ),
    (error) => {
      assert.equal(careError(502, "FASTGPT_UPSTREAM_FAILED")(error), true);
      assert.equal(error.message.includes(key), false);
      assert.equal(String(error.stack).includes(key), false);
      return true;
    }
  );
});
