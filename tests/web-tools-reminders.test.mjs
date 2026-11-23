import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import { careEnv } from "./care-test-helpers.mjs";

const ORIGIN = "https://worker.test";
function callWorker(env, path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (opts.token !== undefined) headers["Authorization"] = "Bearer " + (opts.token || "");
  return worker.fetch(new Request(ORIGIN + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }), env, { waitUntil: async () => {}, passThroughOnException: () => {} });
}
async function jbody(res) { return { status: res.status, body: await res.json().catch(() => null) }; }

function llmEnv() {
  const env = { ...careEnv(), GROQ_KEYS: "test-only-key" };
  env.KV.seed("admin:sess:admin-token-1", { user: "admin1", expires: Date.now() + 86400000, ip: "127.0.0.1" });
  return env;
}
// 让模型依次返回 responses 里的内容；用尽后重复最后一条
function mockLlm(responses) {
  const queue = [...responses];
  const last = responses[responses.length - 1] || '{"reply":"好的"}';
  const orig = globalThis.fetch;
  globalThis.fetch = async function (_url) {
    const content = queue.length ? queue.shift() : last;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return () => { globalThis.fetch = orig; };
}
afterEach(() => { /* fetch restored individually */ });

// ---------- 提醒接口（不依赖 LLM）----------
test("提醒：创建/列表/完成/删除 + 缺少 uid 拒绝", async () => {
  const env = { ...careEnv() };
  // 缺 uid → 400
  let r = await jbody(await callWorker(env, "/api/reminders", { body: { text: "喝水" } }));
  assert.equal(r.status, 400); assert.equal(r.body.code, "UID_REQUIRED");

  // 创建
  r = await jbody(await callWorker(env, "/api/reminders", { body: { text: "记得喝水", when: "明天上午9点", uid: "uid-user-a-1234" } }));
  assert.equal(r.status, 200); assert.ok(r.body.ok); assert.ok(r.body.added && r.body.added.id);
  const id = r.body.added.id;

  // 列表能看到
  r = await jbody(await callWorker(env, "/api/reminders?uid=uid-user-a-1234"));
  assert.equal(r.status, 200); assert.ok(r.body.items.some((t) => t.id === id));

  // 标记完成
  r = await jbody(await callWorker(env, "/api/reminders/done", { body: { id, uid: "uid-user-a-1234" } }));
  assert.equal(r.status, 200); assert.ok(r.body.ok);

  // 完成后不在 open 列表
  r = await jbody(await callWorker(env, "/api/reminders?uid=uid-user-a-1234"));
  assert.equal(r.body.items.filter((t) => t.id === id).length, 0);

  // 删除
  r = await jbody(await callWorker(env, "/api/reminders", { body: { text: "临时", uid: "uid-user-a-1234" } }));
  const id2 = r.body.added.id;
  r = await jbody(await callWorker(env, "/api/reminders/delete", { body: { id: id2, uid: "uid-user-a-1234" } }));
  assert.equal(r.status, 200);
});

test("提醒：跨用户隔离 + /due 返回到期并标记 notified", async () => {
  const env = { ...careEnv() };
  // A 创建一条
  await jbody(await callWorker(env, "/api/reminders", { body: { text: "A 的事", when: "明天上午9点", uid: "uid-user-a-1234" } }));
  // B 看不到 A 的
  const listB = await jbody(await callWorker(env, "/api/reminders?uid=uid-user-b-5678"));
  assert.equal(listB.body.items.filter((t) => t.text === "A 的事").length, 0);

  // 直接造一条已到期的提醒给 C，验证 /due
  env.KV.seed("todos:web:anon:uid-user-c-9012", [
    { id: "past-1", text: "到期该吃药", due_at: Date.now() - 5000, notified: false, done: false, created_at: Date.now() - 6000 }
  ]);
  let due = await jbody(await callWorker(env, "/api/reminders/due?uid=uid-user-c-9012"));
  assert.equal(due.status, 200); assert.ok(due.body.ok);
  assert.equal(due.body.due.length, 1); assert.equal(due.body.due[0].text, "到期该吃药");
  // 已标记 notified，再轮询为空
  due = await jbody(await callWorker(env, "/api/reminders/due?uid=uid-user-c-9012"));
  assert.equal(due.body.due.length, 0);
});

// ---------- 工具循环（mock LLM）----------
test("工具循环：管理员可执行只读工具 list_tenants", async () => {
  const env = llmEnv();
  const restore = mockLlm(['{"tool":"list_tenants","args":{}}', '{"reply":"查到了，共 N 家"}']);
  try {
    const r = await jbody(await callWorker(env, "/api/chat", { body: { chat: "web:console-assistant", text: "看看有哪些医院", token: "admin-token-1", uid: "uid-console-1234" } }));
    assert.equal(r.status, 200); assert.ok(r.body.ok);
    assert.ok((r.body.tools || []).includes("list_tenants"));
    assert.ok(r.body.steps.some((s) => s.tool === "list_tenants" && s.ok === true));
  } finally { restore(); }
});

test("工具循环：管理员可创建提醒 create_reminder", async () => {
  const env = llmEnv();
  const restore = mockLlm(['{"tool":"create_reminder","args":{"text":"吃药","when":"明天上午9点"}}', '{"reply":"好的，已记下明天9点提醒你吃药"}']);
  try {
    const r = await jbody(await callWorker(env, "/api/chat", { body: { chat: "web:console-assistant", text: "提醒我明天上午9点吃药", token: "admin-token-1", uid: "uid-console-1234" } }));
    assert.equal(r.status, 200); assert.ok(r.body.ok);
    assert.ok((r.body.tools || []).includes("create_reminder"));
    // 提醒确实落库（同一 uid）
    const list = await jbody(await callWorker(env, "/api/reminders?uid=uid-console-1234"));
    assert.ok(list.body.items.some((t) => t.text === "吃药"));
  } finally { restore(); }
});

test("工具循环：普通网页用户（无管理员 sess）也能创建提醒，但不能调管理后台工具", async () => {
  const env = llmEnv();
  // 1) 普通用户能创建提醒
  let restore = mockLlm(['{"tool":"create_reminder","args":{"text":"复诊","when":"下周三10点"}}', '{"reply":"记下了"}']);
  try {
    let r = await jbody(await callWorker(env, "/api/chat", { body: { chat: "web:patient", text: "提醒我下周三10点去复诊", uid: "uid-patient-1234" } }));
    assert.ok(r.body.ok); assert.ok((r.body.tools || []).includes("create_reminder"));
  } finally { restore(); }
  // 2) 普通用户想生成患者码 → 工具不在白名单，不执行
  restore = mockLlm(['{"tool":"generate_patient_qr","args":{"tenant_id":"hosp-x","plan":"year"}}', '{"reply":"你没有管理权限，不能生成患者码"}']);
  try {
    const before = await env.KV.list({ prefix: "access:tokens:" });
    const r = await jbody(await callWorker(env, "/api/chat", { body: { chat: "web:patient", text: "给 hosp-x 生成年约患者码", uid: "uid-patient-1234" } }));
    assert.ok(r.body.ok); assert.equal((r.body.tools || []).includes("generate_patient_qr"), false);
    const after = await env.KV.list({ prefix: "access:tokens:" });
    assert.equal(after.keys.length, before.keys.length, "不应创建任何患者码");
  } finally { restore(); }
});

test("工具循环：危险操作 clear_tenant 先拦下待确认，用户确认后才执行", async () => {
  const env = llmEnv();
  env.KV.seed("sub:hosp-demo-001", { tenant_id: "hosp-demo-001", state: "active" });
  const PEND_KEY = "webpend:sess:admin-token-1";

  // 第一轮：模型要清医院 → 拦下
  let restore = mockLlm(['{"tool":"clear_tenant","args":{"tenant_id":"hosp-demo-001"}}']);
  let r;
  try {
    r = await jbody(await callWorker(env, "/api/chat", { body: { chat: "web:console-assistant", text: "把 hosp-demo-001 删了", token: "admin-token-1", uid: "uid-console-1234" } }));
  } finally { restore(); }
  assert.ok(r.body.ok);
  assert.ok(/确认|危险/.test(r.body.reply), "回复应要求确认：" + r.body.reply);
  const pend = await env.KV.get(PEND_KEY, "json");
  assert.ok(pend, "应写入待确认记录"); assert.equal(pend.tool, "clear_tenant");
  assert.ok(r.body.steps.some((s) => s.tool === "clear_tenant" && s.held === true));

  // 第二轮：用户回复「确认」→ 放行执行
  restore = mockLlm(['{"tool":"clear_tenant","args":{"tenant_id":"hosp-demo-001"},"confirmed":true}', '{"reply":"已清除"}']);
  try {
    r = await jbody(await callWorker(env, "/api/chat", { body: { chat: "web:console-assistant", text: "确认", token: "admin-token-1", uid: "uid-console-1234" } }));
  } finally { restore(); }
  assert.ok(r.body.ok);
  assert.equal(await env.KV.get(PEND_KEY, "json"), null, "待确认记录应已清除");
  assert.ok(r.body.steps.some((s) => s.tool === "clear_tenant" && s.held === false), "确认后应实际调度执行");
  // 路由被调用 → 写入审计
  const audit = await env.KV.list({ prefix: "audit:" });
  const auditVals = await Promise.all(audit.keys.map((k) => env.KV.get(k.name, "json")));
  assert.ok(auditVals.some((a) => a && a.op === "clear-tenant"), "应写入 clear-tenant 审计日志");
});

test("工具循环：未登录控制台（无 sess 无 uid）退回纯聊天不报错", async () => {
  const env = llmEnv();
  const restore = mockLlm(['{"reply":"你好，我可以帮你查数据"}']);
  try {
    const r = await jbody(await callWorker(env, "/api/chat", { body: { chat: "web:console-assistant", text: "你好" } }));
    assert.equal(r.status, 200); assert.ok(r.body.ok);
    assert.equal((r.body.tools || []).length, 0);
  } finally { restore(); }
});

test("工具循环：服务端急症兜底，console 回复首句强制 120", async () => {
  const env = llmEnv();
  const restore = mockLlm(['{"reply":"可能是胃的问题，建议观察"}']);
  try {
    const r = await jbody(await callWorker(env, "/api/chat", { body: { chat: "web:console-assistant", text: "我胸痛呼吸困难", token: "admin-token-1", uid: "uid-console-1234" } }));
    assert.ok(r.body.ok); assert.ok(/^请立即就医或拨打120/.test(r.body.reply));
  } finally { restore(); }
});
