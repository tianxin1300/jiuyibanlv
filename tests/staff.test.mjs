import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import { careEnv, makeCatalog, makeService } from "./care-test-helpers.mjs";

const ctx = { waitUntil() {} };
const ADMIN = "test-admin-key-not-real";

function call(env, path, { method = "GET", body, token = "", ip = "10.1.0.1", headers: extraHeaders = {} } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...extraHeaders };
  if (token) headers.Authorization = "Bearer " + token;
  return worker.fetch(new Request("https://worker.test" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, ctx);
}
const adminLogin = async (env, ip = "10.1.0.2") => {
  const r = await call(env, "/api/admin/login", { method: "POST", body: { key: ADMIN }, ip });
  return (await r.json()).token;
};

test("院方接口只认已开通的院方账号", async () => {
  const env = careEnv();
  assert.equal((await call(env, "/api/staff/me")).status, 401);
  assert.equal((await call(env, "/api/staff/me", { token: "alice-token" })).status, 403);
  env.KV.seed("user:carol", { staff: true, staff_roles: ["R5", "R3"], care_scopes: [{ tenant_id: "tenant1", profile_id: "staff1" }] });
  env.KV.seed("token:carol-token", "carol");
  const ok = await call(env, "/api/staff/me", { token: "carol-token" });
  assert.equal(ok.status, 200);
  const d = await ok.json();
  assert.deepEqual(d.roles, ["R3", "R5"]);
  assert.deepEqual(d.tenant_ids, ["tenant1"]);
});

test("院方只能读自己医院的配置", async () => {
  const env = careEnv();
  env.KV.seed("user:carol", { staff: true, staff_roles: ["R5"], care_scopes: [{ tenant_id: "tenant1", profile_id: "staff1" }] });
  env.KV.seed("token:carol-token", "carol");
  const own = await call(env, "/api/staff/config?tenant_id=tenant1", { token: "carol-token" });
  assert.equal(own.status, 200);
  const d = await own.json();
  assert.equal(d.tenant_id, "tenant1");
  assert.equal(d.valid, true);
  assert.equal(d.catalog.catalog_version, "v1");
  assert.equal((await call(env, "/api/staff/config?tenant_id=tenant2", { token: "carol-token" })).status, 403);
  assert.equal((await call(env, "/api/staff/config?tenant_id=tenant1", { token: "alice-token" })).status, 403);
});

test("管理员开通院方账号后，角色权限按分配生效，停用后立即失效", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  const token = await adminLogin(env);
  const saved = await call(env, "/api/admin/staff", { method: "POST", token, body: { user: "alice", tenant_id: "tenant1", roles: ["R5", "r5", "R6"] } });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.deepEqual(savedBody.roles, ["R5", "R6"]);

  const me = await (await call(env, "/api/staff/me", { token: "alice-token" })).json();
  assert.deepEqual(me.roles, ["R5", "R6"]);

  const forbidden = await call(env, "/api/chat", { method: "POST", token: "alice-token", body: { role: "R3", text: "测试" } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, "CARE_ROLE_FORBIDDEN");

  const list = await (await call(env, "/api/admin/staff", { token })).json();
  assert.equal(list.staff.some((s) => s.username === "alice" && s.staff), true);

  const off = await call(env, "/api/admin/staff", { method: "POST", token, body: { user: "alice", enabled: false } });
  assert.equal(off.status, 200);
  assert.equal((await call(env, "/api/staff/me", { token: "alice-token" })).status, 403);
});

test("管理员读写医院配置：非法目录被拒绝，合法目录落 KV", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  const token = await adminLogin(env, "10.1.0.3");

  const got = await call(env, "/api/admin/config?tenant_id=tenant1", { token });
  assert.equal(got.status, 200);
  assert.equal((await got.json()).valid, true);

  const bad = await call(env, "/api/admin/config", { method: "PUT", token, body: { tenant_id: "tenant1", catalog: { catalog_version: "v2", options: {}, services: {} } } });
  assert.equal(bad.status, 422);

  const good = makeCatalog("v2");
  const put = await call(env, "/api/admin/config", { method: "PUT", token, body: { tenant_id: "tenant1", catalog: good } });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).catalog_version, "v2");

  const after = await (await call(env, "/api/admin/config?tenant_id=tenant1", { token })).json();
  assert.equal(after.catalog.catalog_version, "v2");

  assert.equal((await call(env, "/api/admin/config?tenant_id=tenant9", { token })).status, 404);
});

test("未登录不能调用院方或管理员接口", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  assert.equal((await call(env, "/api/admin/staff")).status, 401);
  assert.equal((await call(env, "/api/admin/config?tenant_id=tenant1")).status, 401);
  assert.equal((await call(env, "/api/staff/config?tenant_id=tenant1")).status, 401);
});

async function seedStaff(env, roles = ["R3"], tenant = "tenant1", username = "carol") {
  env.KV.seed("user:" + username, { staff: true, staff_roles: roles, care_scopes: [{ tenant_id: tenant, profile_id: "staff" }] });
  env.KV.seed("token:" + username + "-token", username);
}
async function createAccess(env, admin, plan = "year", tenant = "tenant1") {
  const r = await call(env, "/api/admin/access", { method: "POST", token: admin, body: { tenant_id: tenant, plan } });
  assert.equal(r.status, 200);
  return (await r.json()).record;
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(16).fill(0)]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
const WEBP_BYTES = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

function imageCall(env, path, { method = "POST", bytes, mime = "image/png", token = "carol-token", contentLength } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (method !== "GET") {
    headers["Content-Type"] = mime;
    if (contentLength != null) headers["Content-Length"] = String(contentLength);
  }
  return worker.fetch(new Request("https://worker.test" + path, {
    method, headers, body: method === "GET" ? undefined : bytes
  }), env, ctx);
}

function makePublicCatalog() {
  const catalog = makeCatalog("hospital-selected-version");
  Object.assign(catalog, {
    n: "完整同步医院", w: "医院公开配置欢迎语", c: "#123abc", l: "asset:logo-published",
    splash: "就诊资料仅由患者自行整理", dept: ["全科", "儿科", "妇产科"],
    tel: { n: "总服务台", num: "010-12345678" },
    book: { n: "官方预约", url: "https://hospital.example/book" },
    vip: [{ t: "就诊引导", d: "服务内容以院内公示为准" }],
    ann: [{ t: "门诊通知", d: "节假日排班已更新", date: "2026-11-23" }],
    pre: [{ t: "检查前准备", d: "具体要求请听从医生安排" }],
    campus: [{ n: "东院区", addr: "示例路1号", tel: "010-12345678" }],
    sched: [{ wd: "周一", ap: "上午", dp: "全科", dr: "示例医生", nt: "以当日号源为准", st: "08:00", et: "12:00" }],
    dis: ["高血压", "糖尿病"], rg: { 收缩压: [90, 140], 空腹血糖: [3.9, 6.1] },
    showRef: true, hideRef: false,
    tenant_id: "tenant2", tier: "hospital-forged", trial: true,
    up: "https://forged.example/upload", tk: "b".repeat(64), ai: "https://forged.example/ai",
    icp: "伪造备案", gaba: "伪造备案"
  });
  catalog.services = {};
  catalog.options = {};
  for (const [serviceType, count] of [["project", 12], ["benefit", 12]]) {
    for (let index = 0; index < count; index += 1) {
      const id = `${serviceType}-${index}`;
      const service = makeService(id);
      Object.assign(service, {
        name: `${serviceType === "project" ? "医院项目" : "惠民服务"}${index}`,
        department: `科室${index}`, price: `公示价格${index}`, clinic_hours: `门诊时间${index}`,
        materials: [`材料${index}`], booking_channel: `预约渠道${index}`,
        image_url: `asset:${id}-image`, service_type: serviceType
      });
      service.steps = service.steps.map((step, stepIndex) => ({
        ...step, text: `${service.name}第${stepIndex + 1}步`, materials: [`步骤材料${stepIndex + 1}`],
        time: `步骤时间${stepIndex + 1}`, location: `步骤地点${stepIndex + 1}`,
        official_url: `https://hospital.example/${id}/${stepIndex + 1}`
      }));
      catalog.services[id] = service;
      catalog.options[`option-${id}`] = id;
    }
  }
  catalog.act = [{
    id: "health-draw", service_id: "benefit-0", t: "惠民健康礼", kind: "wheel", per: "day", need: 2,
    start: "2026-11-01", end: "2026-12-31", valid: 30, pin: "1234",
    rule: "按活动规则参与", note: "不承诺中奖",
    items: [
      { t: "健康手册", d: "凭凭证领取", g: "参与奖", q: "100份", w: 80, n: false },
      { t: "谢谢参与", d: "欢迎下次参与", g: "", q: "", w: 20, n: true }
    ]
  }];
  return catalog;
}

test("两类二维码分开生成和计数，患者码不会给已有医院偷偷续期", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN }, admin = await adminLogin(env);
  const access = await createAccess(env, admin, "trial7");
  assert.match(access.url, /^https:\/\/worker\.test\/\?hospital=tenant1&access=/);
  assert.equal(access.plan_label, "试用 7 天");
  assert.equal(access.price_label, "价格口径待确认");
  const firstSub = await env.KV.get("sub:tenant1", "json");
  assert.equal(firstSub.expires_at, access.expires_at);

  const oldExpiry = firstSub.expires_at;
  await createAccess(env, admin, "year");
  assert.equal((await env.KV.get("sub:tenant1", "json")).expires_at, oldExpiry);
  const renewed = await call(env, "/api/admin/renewals", { method: "POST", token: admin, body: { tenant_id: "tenant1", plan: "year" } });
  assert.equal(renewed.status, 200);
  const renewal = (await renewed.json()).record;
  assert.equal(renewal.status, "pending_payment");
  assert.match(renewal.url, /\/staff\.html\?renew=/);
  assert.equal((await env.KV.get("sub:tenant1", "json")).expires_at, oldExpiry);

  const accesses = await (await call(env, "/api/admin/access", { token: admin })).json();
  const renewals = await (await call(env, "/api/admin/renewals", { token: admin })).json();
  assert.equal(accesses.rows.length, 2);
  assert.equal(renewals.rows.length, 1);
  assert.notEqual(accesses.rows[0].id, renewal.id);
  const overview = await (await call(env, "/api/admin/overview", { token: admin })).json();
  assert.equal(overview.counts.patient_qr, 2);
  assert.equal(overview.counts.renewal_qr, 1);
  assert.equal(overview.counts.pending_renewals, 0);
  assert.equal((await call(env, "/api/admin/renewals", { method: "POST", token: admin, body: { tenant_id: "tenant1", plan: "trial7" } })).status, 422);
});

test("公开患者访问同时校验患者码和医院订阅，并只返回院方服务配置", async () => {
  const catalog = makeCatalog();
  catalog.services.svcB.service_type = "benefit";
  catalog.hospital_name = "测试医院";
  const env = { ...careEnv(catalog), ADMIN_KEY: ADMIN }, admin = await adminLogin(env);
  const access = await createAccess(env, admin);
  const path = "/api/public/access?tenant_id=tenant1&token=" + access.id;
  const ok = await call(env, path);
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.config.n, "测试医院");
  assert.equal(data.config.show.length, 1);
  assert.equal(data.config.benefits.length, 1);
  assert.equal(data.config.jny.length, 2);
  assert.equal(data.config.act.length, 0);

  const rec = await env.KV.get("access:" + access.id, "json");
  env.KV.seed("access:" + access.id, { ...rec, expires_at: Date.now() - 1 });
  const ownExpired = await call(env, path);
  assert.equal(ownExpired.status, 403);
  assert.equal((await ownExpired.json()).code, "ACCESS_EXPIRED");

  env.KV.seed("access:" + access.id, { ...rec, expires_at: Date.now() + 86400000 });
  env.KV.seed("sub:tenant1", { status: "active", expires_at: Date.now() - 1 });
  const hospitalExpired = await call(env, path);
  assert.equal(hospitalExpired.status, 403);
  const locked = await hospitalExpired.json();
  assert.equal(locked.code, "HOSPITAL_EXPIRED");
  assert.equal(locked.msg, "医院服务已到期，请联系医院续期");
  assert.equal(locked.config, undefined);
});

test("续费必须院方扫码再由管理员确认，续期只解医院锁", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN }, admin = await adminLogin(env);
  await seedStaff(env);
  const access = await createAccess(env, admin);
  const originalAccessExpiry = access.expires_at;
  env.KV.seed("sub:tenant1", { tenant_id: "tenant1", status: "active", expires_at: Date.now() - 1000 });
  const made = await call(env, "/api/admin/renewals", { method: "POST", token: admin, body: { tenant_id: "tenant1", plan: "trial" } });
  const renewal = (await made.json()).record;
  assert.equal((await call(env, "/api/admin/renewals/confirm", { method: "POST", token: admin, body: { id: renewal.id } })).status, 409);

  await seedStaff(env, ["R3"], "tenant2", "other");
  assert.equal((await call(env, "/api/staff/renewals/scan", { method: "POST", token: "other-token", body: { tenant_id: "tenant2", token: renewal.id } })).status, 404);
  const scanned = await call(env, "/api/staff/renewals/scan", { method: "POST", token: "carol-token", body: { tenant_id: "tenant1", token: renewal.id } });
  assert.equal(scanned.status, 200);
  assert.equal((await scanned.json()).status, "pending_confirm");
  assert.equal((await call(env, "/api/public/access?token=" + access.id)).status, 403);

  const confirmed = await call(env, "/api/admin/renewals/confirm", { method: "POST", token: admin, body: { id: renewal.id } });
  assert.equal(confirmed.status, 200);
  const result = await confirmed.json();
  assert.equal(result.subscription.state, "active");
  assert.ok(result.subscription.expires_at > Date.now() + 29 * 86400000);
  assert.equal(result.record.scanned_by, "carol");
  assert.match(result.msg, /未发生真实扣款/);
  const publicAgain = await call(env, "/api/public/access?token=" + access.id);
  assert.equal(publicAgain.status, 200);
  assert.equal((await env.KV.get("access:" + access.id, "json")).expires_at, originalAccessExpiry);
  assert.equal((await call(env, "/api/admin/renewals/confirm", { method: "POST", token: admin, body: { id: renewal.id } })).status, 409);

  const rec = await env.KV.get("access:" + access.id, "json");
  env.KV.seed("access:" + access.id, { ...rec, expires_at: Date.now() - 1 });
  assert.equal((await (await call(env, "/api/public/access?token=" + access.id)).json()).code, "ACCESS_EXPIRED");
});

test("R3 只能修改本院配置，其他岗位和其他医院均被拒绝", async () => {
  const env = careEnv();
  for (const role of ["R1", "R2", "R4", "R5", "R6"]) {
    await seedStaff(env, [role]);
    assert.equal((await call(env, "/api/staff/config?tenant_id=tenant1", { token: "carol-token" })).status, 200);
    assert.equal((await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog: makeCatalog("v2") } })).status, 403);
  }
  await seedStaff(env, ["R3"]);
  assert.equal((await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant2", catalog: makeCatalog("v2") } })).status, 403);
  assert.equal((await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog: {} } })).status, 422);
  const saved = await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog: makeCatalog("v2") } });
  assert.equal(saved.status, 200);
  const version = (await env.KV.get("care:catalog:tenant1", "json")).catalog_version;
  assert.match(version, /^staff-/);
  assert.notEqual(version, "v2");
  assert.equal((await saved.json()).catalog_version, version);
});

test("R3 管理本院已有注册人员，不能接管其他医院的院方账号", async () => {
  const env = careEnv();
  await seedStaff(env, ["R3"]);
  env.KV.seed("user:dave", { care_scopes: [] });
  const assigned = await call(env, "/api/staff/members", { method: "POST", token: "carol-token", body: { tenant_id: "tenant1", user: "dave", roles: ["R1", "R5"] } });
  assert.equal(assigned.status, 200);
  assert.deepEqual((await assigned.json()).roles, ["R1", "R5"]);
  assert.equal((await call(env, "/api/staff/me", { token: "alice-token" })).status, 403);
  const list = await (await call(env, "/api/staff/members?tenant_id=tenant1", { token: "carol-token" })).json();
  assert.equal(list.staff.some((s) => s.username === "dave"), true);

  env.KV.seed("user:shared", { staff: true, staff_roles: ["R3"], care_scopes: [{ tenant_id: "tenant2" }] });
  assert.equal((await call(env, "/api/staff/members", { method: "POST", token: "carol-token", body: { tenant_id: "tenant1", user: "shared", roles: ["R1"] } })).status, 409);
  const disabled = await call(env, "/api/staff/members", { method: "POST", token: "carol-token", body: { tenant_id: "tenant1", user: "dave", enabled: false } });
  assert.equal(disabled.status, 200);
  assert.equal((await env.KV.get("user:dave", "json")).staff, false);
  await seedStaff(env, ["R5"], "tenant1", "limited");
  assert.equal((await call(env, "/api/staff/members?tenant_id=tenant1", { token: "limited-token" })).status, 403);
});

test("管理员会话、院方会话和患者公开码不能混用", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN }, admin = await adminLogin(env);
  await seedStaff(env);
  const access = await createAccess(env, admin);
  assert.equal((await call(env, "/api/staff/me", { token: admin })).status, 401);
  assert.equal((await call(env, "/api/admin/overview", { token: "carol-token" })).status, 401);
  assert.equal((await call(env, "/api/staff/billing?tenant_id=tenant1", { token: "alice-token" })).status, 403);
  assert.equal((await call(env, "/api/public/access?token=" + access.id)).status, 200);
  const billing = await (await call(env, "/api/staff/billing?tenant_id=tenant1", { token: "carol-token" })).json();
  assert.equal(billing.subscription.state, "active");
  assert.equal(billing.price_label, "价格口径待确认");
});

test("R3 发布后完整同步公开资料且不截断，控制台字段和订阅只能保留原值", async () => {
  const protectedCatalog = makeCatalog("v1");
  const protectedFields = {
    tenant_id: "tenant1", tier: "contract-year", trial: false,
    up: "https://control.example/upload", tk: "a".repeat(64), ai: "https://control.example/ai",
    icp: "控制台备案号", gaba: "控制台公安备案号"
  };
  Object.assign(protectedCatalog, protectedFields);
  const env = { ...careEnv(protectedCatalog), ADMIN_KEY: ADMIN };
  const admin = await adminLogin(env);
  await seedStaff(env);
  const access = await createAccess(env, admin);
  const subscriptionBefore = await env.KV.get("sub:tenant1", "json");

  const saved = await call(env, "/api/staff/config", {
    method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog: makePublicCatalog() }
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  const stored = await env.KV.get("care:catalog:tenant1", "json");
  assert.match(stored.catalog_version, /^staff-/);
  assert.notEqual(stored.catalog_version, "hospital-selected-version");
  assert.equal(savedBody.catalog_version, stored.catalog_version);
  for (const [key, value] of Object.entries(protectedFields)) assert.deepEqual(stored[key], value, `${key} 不得被院方篡改`);
  assert.deepEqual(await env.KV.get("sub:tenant1", "json"), subscriptionBefore);

  const response = await call(env, "/api/public/access?tenant_id=tenant1&token=" + access.id);
  assert.equal(response.status, 200);
  const config = (await response.json()).config;
  assert.equal(config.ver, stored.catalog_version);
  assert.equal(config.tid, "tenant1");
  assert.equal(config.tenant_id, undefined);
  for (const key of ["n", "w", "c", "l", "splash", "dept", "tel", "book", "vip", "ann", "pre", "campus", "sched", "dis", "rg", "showRef", "hideRef"]) {
    assert.deepEqual(config[key], stored[key], `${key} 应同步到患者端`);
  }
  for (const key of ["tier", "trial", "up", "tk", "ai", "icp", "gaba"]) assert.deepEqual(config[key], protectedFields[key]);
  assert.equal(config.show.length, 12);
  assert.equal(config.benefits.length, 12);
  assert.equal(config.jny.length, 24);
  assert.deepEqual(config.act, stored.act);

  for (const card of [...config.show, ...config.benefits]) {
    const service = stored.services[card.service_id];
    assert.equal(card.t, service.name);
    assert.equal(card.department, service.department);
    assert.equal(card.clinic_hours, service.clinic_hours);
    assert.equal(card.price, service.price);
    assert.deepEqual(card.materials, service.materials);
    assert.equal(card.booking_channel, service.booking_channel);
    assert.equal(card.service_type, service.service_type);
    assert.equal(card.img, service.image_url);
    assert.deepEqual(card.option_ids, [`option-${service.service_id}`]);
  }
  for (const flow of config.jny) {
    const service = stored.services[flow.service_id];
    assert.equal(flow.steps.length, 7);
    assert.deepEqual(flow.option_ids, [`option-${service.service_id}`]);
    assert.equal(flow.img, service.image_url);
    flow.steps.forEach((step, index) => {
      const source = service.steps[index];
      assert.equal(step.step, index + 1);
      assert.equal(step.t, source.text);
      assert.deepEqual(step.materials, source.materials);
      assert.equal(step.time, source.time);
      assert.equal(step.location, source.location);
      assert.equal(step.official_url, source.official_url);
    });
  }
});

test("PNG/JPEG/WebP 可上传预览，患者只能读已发布图片且图片请求不增加扫码次数", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  const admin = await adminLogin(env);
  await seedStaff(env);
  const access = await createAccess(env, admin);
  const assets = {};

  for (const [mime, bytes] of [["image/png", PNG_BYTES], ["image/jpeg", JPEG_BYTES], ["image/webp", WEBP_BYTES]]) {
    const uploaded = await imageCall(env, "/api/staff/config/image?tenant_id=tenant1&service_id=svcA", { mime, bytes });
    assert.equal(uploaded.status, 200);
    const body = await uploaded.json();
    assert.equal(body.mime, mime);
    assert.equal(body.size, bytes.length);
    assert.match(body.image_url, /^asset:/);
    assets[mime] = { ...body, bytes };
    const object = await env.KV.getWithMetadata(`catalog/tenant1/${body.asset_id}`, "arrayBuffer");
    assert.equal(object.metadata.tenant_id, "tenant1");
    assert.equal(object.metadata.service_id, "svcA");
    assert.equal(object.metadata.contentType, mime);
    assert.deepEqual(new Uint8Array(object.value), bytes);
    const preview = await imageCall(env, `/api/staff/config/image?tenant_id=tenant1&asset_id=${body.asset_id}`, { method: "GET" });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("Content-Type"), mime);
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), bytes);
  }

  const png = assets["image/png"], webp = assets["image/webp"];
  const publicPath = (assetId, tenant = "tenant1") => `/api/public/catalog-image?access=${access.id}&tenant_id=${tenant}&asset_id=${assetId}`;
  assert.equal((await imageCall(env, publicPath(png.asset_id), { method: "GET", token: "" })).status, 404);
  assert.equal((await imageCall(env, publicPath(png.asset_id, "tenant2"), { method: "GET", token: "" })).status, 404);

  await seedStaff(env, ["R5"], "tenant1", "limited");
  assert.equal((await imageCall(env, "/api/staff/config/image?tenant_id=tenant1", { token: "limited-token", bytes: PNG_BYTES })).status, 403);
  assert.equal((await imageCall(env, `/api/staff/config/image?tenant_id=tenant1&asset_id=${png.asset_id}`, { method: "GET", token: "limited-token" })).status, 200);
  await seedStaff(env, ["R3"], "tenant2", "other");
  assert.equal((await imageCall(env, `/api/staff/config/image?tenant_id=tenant1&asset_id=${png.asset_id}`, { method: "GET", token: "other-token" })).status, 403);

  const catalog = makeCatalog("png-draft");
  catalog.services.svcA.image_url = png.image_url;
  assert.equal((await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog } })).status, 200);
  const published = await imageCall(env, publicPath(png.asset_id), { method: "GET", token: "" });
  assert.equal(published.status, 200);
  assert.equal(published.headers.get("Content-Type"), "image/png");
  assert.equal(published.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(published.headers.get("Content-Disposition"), "inline");
  assert.match(published.headers.get("Cache-Control"), /private/);
  assert.deepEqual(new Uint8Array(await published.arrayBuffer()), PNG_BYTES);
  assert.equal((await imageCall(env, publicPath(webp.asset_id), { method: "GET", token: "" })).status, 404);

  catalog.services.svcA.image_url = webp.image_url;
  assert.equal((await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog } })).status, 200);
  assert.equal((await imageCall(env, publicPath(webp.asset_id), { method: "GET", token: "" })).status, 200);
  assert.equal((await imageCall(env, publicPath(png.asset_id), { method: "GET", token: "" })).status, 404);
  assert.ok((await env.KV.getWithMetadata(`catalog/tenant1/${png.asset_id}`, "arrayBuffer")).value, "替换发布后旧文件仍应保留缓冲");

  const accessRecord = await env.KV.get("access:" + access.id, "json");
  const subscription = await env.KV.get("sub:tenant1", "json");
  env.KV.seed("access:" + access.id, { ...accessRecord, expires_at: Date.now() - 1 });
  assert.equal((await (await imageCall(env, publicPath(webp.asset_id), { method: "GET", token: "" })).json()).code, "ACCESS_EXPIRED");
  env.KV.seed("access:" + access.id, accessRecord);
  env.KV.seed("sub:tenant1", { ...subscription, expires_at: Date.now() - 1 });
  assert.equal((await (await imageCall(env, publicPath(webp.asset_id), { method: "GET", token: "" })).json()).code, "HOSPITAL_EXPIRED");
  assert.equal((await env.KV.get("access:" + access.id, "json")).scan_count, accessRecord.scan_count);
});

test("上传拒绝超限、空文件、GIF/SVG、伪造 MIME 和异常魔数", async () => {
  const env = { ...careEnv() };
  await seedStaff(env);
  const path = "/api/staff/config/image?tenant_id=tenant1";
  assert.equal((await imageCall(env, path, { bytes: new Uint8Array(2 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await imageCall(env, path, { bytes: PNG_BYTES, contentLength: 2 * 1024 * 1024 + 1 })).status, 413);
  assert.equal((await imageCall(env, path, { bytes: new Uint8Array() })).status, 422);
  for (const [mime, bytes] of [
    ["image/jpeg", PNG_BYTES],
    ["image/png", JPEG_BYTES],
    ["image/gif", new TextEncoder().encode("GIF89a-not-an-upload")],
    ["image/svg+xml", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>")],
    ["image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47])]
  ]) {
    const response = await imageCall(env, path, { mime, bytes });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, "IMAGE_TYPE_INVALID");
  }
  assert.equal([...env.KV.data.keys()].filter((key) => key.startsWith("catalog/")).length, 0);
});

test("目录写入失败不假报发布成功，也不删除或替换旧公开图片", async () => {
  const current = makeCatalog("v1");
  current.services.svcA.image_url = "asset:old-public";
  const env = { ...careEnv(current), ADMIN_KEY: ADMIN };
  await env.KV.put("catalog/tenant1/old-public", PNG_BYTES, { metadata: { contentType: "image/png", size: PNG_BYTES.length } });
  const admin = await adminLogin(env);
  await seedStaff(env);
  const access = await createAccess(env, admin);
  const candidate = makeCatalog("new-draft");
  candidate.services.svcA.image_url = "asset:new-unpublished";

  env.KV.failKey = "care:catalog:tenant1";
  const failed = await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog: candidate } });
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).ok, false);
  env.KV.failKey = "";
  assert.equal((await env.KV.get("care:catalog:tenant1", "json")).services.svcA.image_url, "asset:old-public");
  assert.ok((await env.KV.getWithMetadata("catalog/tenant1/old-public", "arrayBuffer")).value);
  const oldImage = await imageCall(env, `/api/public/catalog-image?access=${access.id}&tenant_id=tenant1&asset_id=old-public`, { method: "GET", token: "" });
  assert.equal(oldImage.status, 200);
  const newImage = await imageCall(env, `/api/public/catalog-image?access=${access.id}&tenant_id=tenant1&asset_id=new-unpublished`, { method: "GET", token: "" });
  assert.equal(newImage.status, 404);
});

test("患者与续费二维码跟随 OSS/COS 前端来源，并支持显式公开地址覆盖", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  const admin = await adminLogin(env);
  const ossOrigin = "https://demo-bucket.oss-cn-beijing.aliyuncs.com";
  const cosOrigin = "https://demo-bucket.cos.ap-beijing.myqcloud.com";

  const accessResponse = await call(env, "/api/admin/access", {
    method: "POST", token: admin, body: { tenant_id: "tenant1", plan: "trial7" },
    headers: { Origin: ossOrigin }
  });
  assert.equal(accessResponse.status, 200);
  const access = (await accessResponse.json()).record;
  assert.ok(access.url.startsWith(ossOrigin + "/?hospital=tenant1&access="));
  assert.equal(accessResponse.headers.get("Access-Control-Allow-Origin"), "*");

  const renewalResponse = await call(env, "/api/admin/renewals", {
    method: "POST", token: admin, body: { tenant_id: "tenant1", plan: "year" },
    headers: { Origin: cosOrigin }
  });
  assert.equal(renewalResponse.status, 200);
  const renewal = (await renewalResponse.json()).record;
  assert.ok(renewal.url.startsWith(cosOrigin + "/staff.html?renew="));

  const listed = await (await call(env, "/api/admin/access", {
    token: admin, headers: { Referer: cosOrigin + "/console.html" }
  })).json();
  assert.ok(listed.rows[0].url.startsWith(cosOrigin + "/?hospital=tenant1&access="));

  const configured = { ...env, PATIENT_BASE_URL: "https://demo-bucket.oss-cn-beijing.aliyuncs.com/patient/" };
  const overridden = await call(configured, "/api/admin/access", {
    method: "POST", token: admin, body: { tenant_id: "tenant1", plan: "trial7" },
    headers: { Origin: cosOrigin }
  });
  const overriddenRecord = (await overridden.json()).record;
  assert.ok(overriddenRecord.url.startsWith("https://demo-bucket.oss-cn-beijing.aliyuncs.com/patient/?hospital=tenant1&access="));
});
