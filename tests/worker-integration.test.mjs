import test from "node:test";
import assert from "node:assert/strict";
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
