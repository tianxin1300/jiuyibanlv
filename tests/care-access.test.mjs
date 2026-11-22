import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import { careEnv } from "./care-test-helpers.mjs";

const ctx = { waitUntil() {} };

function call(env, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return worker.fetch(new Request("https://worker.test/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  }), env, ctx);
}

const okLLM = () => new Response(JSON.stringify({ choices: [{ message: { content: "回复" } }] }), {
  status: 200,
  headers: { "Content-Type": "application/json" }
});

test("角色请求必须登录，院方角色需要 staff 权限", async () => {
  const env = { ...careEnv(), GROQ_KEYS: "test-key" };
  const original = globalThis.fetch;
  globalThis.fetch = async () => okLLM();
  try {
    assert.equal((await call(env, { role: "R1", text: "你好" })).status, 401);
    assert.equal((await call(env, { role: "R2", text: "你好" }, "alice-token")).status, 403);
    assert.equal((await call(env, { role: "R1", text: "你好" }, "alice-token")).status, 200);
    env.KV.seed("user:alice", { care_scopes: [{ tenant_id: "tenant1", profile_id: "profile1" }], staff: true });
    assert.equal((await call(env, { role: "R2", text: "你好" }, "alice-token")).status, 200);
  } finally {
    globalThis.fetch = original;
  }
});

test("患者网页聊天带 M2 红线，且不返回工具与内部步骤", async () => {
  const env = { ...careEnv(), GROQ_KEYS: "test-key" };
  const original = globalThis.fetch;
  let system = "";
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    system = body.messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: "请立即就医或拨打120" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await call(env, { text: "我胸痛", chat: "web:alice" });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.match(system, /M2 医疗与广告红线/);
    assert.match(system, /请立即就医或拨打120/);
    assert.match(data.reply, /^请立即就医或拨打120/);
    assert.deepEqual(data.tools, []);
    assert.deepEqual(data.steps, []);
  } finally {
    globalThis.fetch = original;
  }
});

test("非急症提问不会被强行加上 120 首句", async () => {
  const env = { ...careEnv(), GROQ_KEYS: "test-key" };
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "先整理复诊要问的问题。" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  try {
    const response = await call(env, { text: "帮我整理复诊问题", chat: "web:alice" });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.reply, "先整理复诊要问的问题。");
  } finally {
    globalThis.fetch = original;
  }
});
