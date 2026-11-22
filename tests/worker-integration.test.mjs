import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import worker from "../worker.js";
import { CareTask } from "../care.js";
import { MemoryStorage, careEnv, makeCatalog, taskBody, advanceInput } from "./care-test-helpers.mjs";

class MemoryDoNamespace {
  constructor() { this.objects = new Map(); }
  idFromName(name) { return name; }
  get(name) {
    if (!this.objects.has(name)) {
      const object = new CareTask({ storage: new MemoryStorage() });
      this.objects.set(name, { fetch: (input, init) => object.fetch(input instanceof Request ? input : new Request(input, init)) });
    }
    return this.objects.get(name);
  }
}

const ctx = { waitUntil() {} };
function callWorker(env, path, { method = "POST", body, token = "alice-token", headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  if (token) requestHeaders.Authorization = "Bearer " + token;
  return worker.fetch(new Request("https://worker.test" + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, ctx);
}

async function responseBody(response) { return { response, body: await response.json() }; }

test("CORS 允许 Idempotency-Key，显式非法角色为 400，模型全失败为 502", async () => {
  const env = careEnv();
  const options = await callWorker(env, "/api/chat", { method: "OPTIONS", token: "" });
  assert.match(options.headers.get("Access-Control-Allow-Headers"), /Idempotency-Key/);
  const configOptions = await callWorker(env, "/api/staff/config", { method: "OPTIONS", token: "" });
  assert.match(configOptions.headers.get("Access-Control-Allow-Methods"), /PUT/);
  const invalid = await callWorker(env, "/api/chat", { body: { text: "你好", role: "BAD" } });
  assert.equal(invalid.status, 400);
  const unavailable = await responseBody(await callWorker(env, "/api/chat", { body: { text: "你好", role: "R1" } }));
  assert.equal(unavailable.response.status, 502);
  assert.equal(unavailable.body.code, "CARE_MODEL_UNAVAILABLE");
});

test("角色路由保留响应字段，无角色请求继续走旧聊天结构", async () => {
  const env = { ...careEnv(), GROQ_KEYS: "test-only-key" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "角色回复" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  try {
    const role = await responseBody(await callWorker(env, "/api/chat", { body: { text: "整理复诊问题", role: "R1" } }));
    assert.equal(role.response.status, 200);
    assert.equal(role.body.ok, true);
    assert.equal(role.body.role, "P-ASSIST");
    assert.equal(role.body.reply, "角色回复");
    assert.deepEqual(role.body.tools, []);
    assert.deepEqual(role.body.steps, []);
    assert.equal(role.body.awaiting, false);
    assert.ok(role.body.build);
  } finally { globalThis.fetch = originalFetch; }

  const old = await responseBody(await callWorker(careEnv(), "/api/chat", { body: { text: "你好", budget_ms: 20000 }, token: "" }));
  assert.equal(old.response.status, 200);
  assert.equal(old.body.ok, true);
  assert.equal(old.body.role, undefined);
  assert.ok(Array.isArray(old.body.tools));
  assert.ok(Array.isArray(old.body.steps));
  assert.equal(typeof old.body.reply, "string");
});

test("本地 match 使用 Bearer 与租户授权，精确合并且拒绝未知 ID", async () => {
  const env = careEnv();
  const matched = await responseBody(await callWorker(env, "/api/intel/match", {
    body: { tenant_id: "tenant1", option_ids: ["optA", "optA2", "optA"] }
  }));
  assert.equal(matched.response.status, 200);
  assert.equal(matched.body.source, "local");
  assert.deepEqual(matched.body.option_ids, ["optA", "optA2"]);
  assert.equal(matched.body.matches.length, 1);
  assert.deepEqual(matched.body.matches[0].option_ids, ["optA", "optA2"]);

  assert.equal((await callWorker(env, "/api/intel/match", { body: { tenant_id: "tenant1", option_ids: ["unknown"] } })).status, 422);
  assert.equal((await callWorker(env, "/api/intel/match", { body: { tenant_id: "tenant1", option_ids: ["optA"] }, token: "" })).status, 401);
  const forbidden = careEnv();
  forbidden.KV.seed("user:alice", { care_scopes: [{ tenant_id: "other", profile_id: "profile1" }] });
  assert.equal((await callWorker(forbidden, "/api/intel/match", { body: { tenant_id: "tenant1", option_ids: ["optA"] } })).status, 403);
  assert.equal((await callWorker({}, "/api/intel/match", { body: { tenant_id: "tenant1", option_ids: ["optA"] }, token: "" })).status, 503);
});

test("FastGPT 路由只转发约定字段并透明返回上游状态、正文和类型", async () => {
  const env = { ...careEnv(), FASTGPT_URL: "https://fastgpt.test/match", FASTGPT_KEY: "not-a-real-secret" };
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return new Response("upstream-raw-body", { status: 201, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  };
  try {
    const response = await callWorker(env, "/api/intel/match", { body: { tenant_id: "tenant1", option_ids: ["optA"] } });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "upstream-raw-body");
    assert.equal(seen.url, env.FASTGPT_URL);
    assert.deepEqual(JSON.parse(seen.options.body), { tenant_id: "tenant1", option_ids: ["optA"] });
    assert.equal(seen.options.headers.Authorization, "Bearer not-a-real-secret");
    assert.ok(seen.options.signal);
  } finally { globalThis.fetch = originalFetch; }
});

test("医院任务 Worker 路由完成创建、读取、推进、精确重放与跨用户隔离", async () => {
  const env = { ...careEnv(), CARE_TASKS: new MemoryDoNamespace() };
  const created = await responseBody(await callWorker(env, "/api/care/tasks", { body: taskBody() }));
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.task.current_step, 1);
  const taskId = created.body.task.task_id;

  const read = await responseBody(await callWorker(env, "/api/care/tasks/" + taskId, { method: "GET" }));
  assert.equal(read.response.status, 200);
  assert.equal(read.body.task.task_id, taskId);
  const forbidden = await callWorker(env, "/api/care/tasks/" + taskId, { method: "GET", token: "bob-token" });
  assert.equal(forbidden.status, 403);

  const path = "/api/care/tasks/" + taskId;
  const first = await callWorker(env, path, { method: "PATCH", body: advanceInput(1), headers: { "Idempotency-Key": "route-replay-key" } });
  const firstText = await first.text();
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(firstText).task.current_step, 2);
  const replay = await callWorker(env, path, { method: "PATCH", body: advanceInput(1), headers: { "Idempotency-Key": "route-replay-key" } });
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), firstText);
  const unauthenticated = await callWorker(env, path, { method: "GET", token: "" });
  assert.equal(unauthenticated.status, 401);
});

test("新注册账号自动获得默认 care_scopes 并可匹配医院服务", async () => {
  const env = careEnv();
  env.KV.seed("care:catalog:hosp-demo-001", makeCatalog("2026.11.22"));
  const registered = await responseBody(await callWorker(env, "/api/register", {
    body: { user: "demo2", pw: "secret1" },
    token: ""
  }));
  assert.equal(registered.response.status, 200);
  assert.equal(registered.body.ok, true);
  assert.ok(registered.body.token);

  const record = await env.KV.get("user:demo2", "json");
  assert.deepEqual(record.care_scopes, [{ tenant_id: "hosp-demo-001", profile_id: "profile-demo-001" }]);
  assert.ok(record.salt);
  assert.ok(record.hash);
  assert.equal(Object.hasOwn(record, "pw"), false);

  const matched = await responseBody(await callWorker(env, "/api/intel/match", {
    body: { tenant_id: "hosp-demo-001", option_ids: ["optA"] },
    token: registered.body.token
  }));
  assert.equal(matched.response.status, 200, JSON.stringify(matched.body));
  assert.equal(matched.body.matches[0].service_id, "svcA");
});

test("旧账号密码升级保留 care_scopes 与其他记录字段", async () => {
  const env = careEnv();
  const password = "legacy-password";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password + "openmanus-salt"));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  env.KV.seed("user:legacy", {
    hash,
    created: 123,
    custom: "keep",
    care_scopes: [{ tenant_id: "tenant1", profile_id: "legacy-profile" }]
  });
  const login = await responseBody(await callWorker(env, "/api/login", { body: { user: "legacy", pw: password }, token: "" }));
  assert.equal(login.response.status, 200);
  assert.equal(login.body.ok, true);
  assert.ok(login.body.token);
  const upgraded = await env.KV.get("user:legacy", "json");
  assert.ok(upgraded.salt);
  assert.notEqual(upgraded.hash, hash);
  assert.equal(upgraded.created, 123);
  assert.equal(upgraded.custom, "keep");
  assert.deepEqual(upgraded.care_scopes, [{ tenant_id: "tenant1", profile_id: "legacy-profile" }]);
});

test("目录版本更新不会修改已创建任务快照", async () => {
  const env = { ...careEnv(), CARE_TASKS: new MemoryDoNamespace() };
  const created = await responseBody(await callWorker(env, "/api/care/tasks", { body: taskBody() }));
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.task_id;
  env.KV.seed("care:catalog:tenant1", makeCatalog("v2"));
  const read = await responseBody(await callWorker(env, "/api/care/tasks/" + taskId, { method: "GET" }));
  assert.equal(read.body.task.catalog_version, "v1");
  assert.deepEqual(read.body.task.steps, created.body.task.steps);
});

const PATIENT_TOKEN = "patient-token-001";
function patientAiEnv(overrides = {}) {
  const env = { ...careEnv(), DASHSCOPE_KEY: "test-only-dashscope", ...overrides };
  env.KV.seed("access:" + PATIENT_TOKEN, { tenant_id: "tenant1", status: "active", expires_at: Date.now() + 3600000 });
  env.KV.seed("sub:tenant1", { status: "active", expires_at: Date.now() + 3600000 });
  return env;
}
function patientAiBody(overrides = {}) {
  return { access: PATIENT_TOKEN, tenant_id: "tenant1", role: "R1", text: "整理复诊资料", ...overrides };
}
async function withWorkerFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); }
  finally { globalThis.fetch = original; }
}
function qwenResponse(content = "本地模拟回复", status = 200) {
  if (status !== 200) return new Response(JSON.stringify({ error: { message: "mock upstream failure" } }), { status });
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { "Content-Type": "application/json" } });
}

test("患者 AI 路由复用患者码与医院订阅双锁并拒绝跨租户和非 R1 角色", async () => {
  let modelCalls = 0;
  await withWorkerFetch(async () => { modelCalls += 1; return qwenResponse(); }, async () => {
    const env = patientAiEnv();
    const cases = [
      [{ access: "" }, 400, "INVALID_ACCESS"],
      [{ access: "unknown-token" }, 404, "ACCESS_NOT_FOUND"],
      [{ tenant_id: "other" }, 404, "ACCESS_NOT_FOUND"],
      [{ role: "R2" }, 403, "CARE_ROLE_FORBIDDEN"]
    ];
    for (const [override, status, code] of cases) {
      const { response, body } = await responseBody(await callWorker(env, "/api/ai/chat", { body: patientAiBody(override), token: "" }));
      assert.equal(response.status, status);
      assert.equal(body.code, code);
    }
    const expiredAccess = patientAiEnv();
    expiredAccess.KV.seed("access:" + PATIENT_TOKEN, { tenant_id: "tenant1", status: "active", expires_at: Date.now() - 1 });
    const accessResult = await responseBody(await callWorker(expiredAccess, "/api/ai/chat", { body: patientAiBody(), token: "" }));
    assert.equal(accessResult.response.status, 403);
    assert.equal(accessResult.body.code, "ACCESS_EXPIRED");

    const expiredHospital = patientAiEnv();
    expiredHospital.KV.seed("sub:tenant1", { status: "active", expires_at: Date.now() - 1 });
    const hospitalResult = await responseBody(await callWorker(expiredHospital, "/api/ai/chat", { body: patientAiBody(), token: "" }));
    assert.equal(hospitalResult.response.status, 403);
    assert.equal(hospitalResult.body.code, "HOSPITAL_EXPIRED");
  });
  assert.equal(modelCalls, 0);
});

test("患者 AI SSE 在上游成功后输出，历史和当前病历均在 Worker 脱敏", async () => {
  const env = patientAiEnv();
  let upstreamBody;
  await withWorkerFetch(async (url, options) => {
    assert.equal(String(url), "https://dashscope.cn-beijing.aliyuncs.com/compatible-mode/v1/chat/completions");
    upstreamBody = JSON.parse(options.body);
    return qwenResponse("第一段\n第二段");
  }, async () => {
    const response = await callWorker(env, "/api/ai/chat", {
      body: patientAiBody({
        text: "姓名：赵六，手机号：13800138000，住12床",
        history: [{ role: "user", content: "地址：北京市海淀区中关村大街27号" }],
        stream: true
      }),
      token: ""
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /^text\/event-stream/);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const text = await response.text();
    assert.ok(text.endsWith("data: [DONE]\n\n"));
    const reply = text.split(/\r?\n\r?\n/).filter((event) => event.startsWith("data: {")).map((event) => {
      const chunk = JSON.parse(event.slice(6));
      return chunk.choices[0].delta.content;
    }).join("");
    assert.equal(reply, "第一段\n第二段");
  });
  const serialized = JSON.stringify(upstreamBody);
  for (const sensitive of ["赵六", "13800138000", "12床", "北京市海淀区中关村大街27号"]) assert.equal(serialized.includes(sensitive), false);
  assert.ok(serialized.includes("[姓名已脱敏]"));
  assert.ok(serialized.includes("[手机号已脱敏]"));
  assert.ok(serialized.includes("[床位已脱敏]"));
  assert.ok(serialized.includes("[地址已脱敏]"));
});

test("通义非 200 在患者 AI 路由返回 JSON 错误而不是成功 SSE", async () => {
  const env = patientAiEnv();
  await withWorkerFetch(async () => qwenResponse("", 503), async () => {
    const response = await callWorker(env, "/api/ai/chat", { body: patientAiBody({ stream: true }), token: "" });
    assert.equal(response.status, 502);
    assert.match(response.headers.get("Content-Type"), /^application\/json/);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "DASHSCOPE_UPSTREAM_ERROR");
    assert.match(body.msg, /HTTP 503/);
    assert.equal(JSON.stringify(body).includes("[DONE]"), false);
  });
});

test("患者 AI 使用 KV 限流每分钟 20 次，第 21 次不再调用模型", async () => {
  const env = patientAiEnv();
  let modelCalls = 0;
  await withWorkerFetch(async () => { modelCalls += 1; return qwenResponse("第" + modelCalls + "次"); }, async () => {
    for (let i = 0; i < 20; i++) {
      const { response, body } = await responseBody(await callWorker(env, "/api/ai/chat", { body: patientAiBody(), token: "" }));
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.role, "P-ASSIST");
      assert.equal(body.reply, "第" + (i + 1) + "次");
    }
    const limited = await responseBody(await callWorker(env, "/api/ai/chat", { body: patientAiBody({ stream: true }), token: "" }));
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.code, "AI_RATE_LIMITED");
  });
  assert.equal(modelCalls, 20);
  const rateKeys = (await env.KV.list({ prefix: "rl:care-ai:" + PATIENT_TOKEN + ":" })).keys;
  assert.equal(rateKeys.length, 1);
  assert.equal(await env.KV.get(rateKeys[0].name), "20");
});

test("前后端分离只维护一个公开后端地址，可切换阿里云或腾讯云函数入口", async () => {
  const read = (name) => readFile(new URL("../" + name, import.meta.url), "utf8");
  const config = await read("frontend/deploy-config.js");
  const pages = await Promise.all(["frontend/index.html", "frontend/staff.html", "frontend/console.html"].map(read));
  const templates = await Promise.all(["templates/配置模板_基础版.json", "templates/配置模板_升级版.json"].map(read));

  assert.equal((config.match(/https:\/\//g) || []).length, 1);
  for (const page of pages) {
    assert.ok(page.includes('<script src="deploy-config.js"></script>'));
    assert.doesNotMatch(page, /(?:pages|workers)\.dev/);
  }
  for (const template of templates) assert.equal(JSON.parse(template).ai, "");
  assert.ok(pages[0].includes("const AI_BASE = AI_DEFAULT;"));
  assert.ok(!pages[0].includes("|| AI_DEFAULT"));

  for (const target of [
    "https://demo.cn-beijing.fcapp.run",
    "https://demo.ap-beijing.tencentscf.com"
  ]) {
    const migrated = config.replace(/(window\.CARE_API_BASE_URL = ')[^']+(';)/, "$1" + target + "$2");
    const sandbox = { window: {} };
    runInNewContext(migrated, sandbox);
    assert.equal(sandbox.window.CARE_API_BASE_URL, target);
  }

  const sw = await read("frontend/sw.js");
  assert.ok(sw.includes("companion-sw-2026.11.41"));
  assert.ok(!sw.includes("deploy-config.js"));
});
