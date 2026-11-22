import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import { careEnv } from "./care-test-helpers.mjs";

const ctx = { waitUntil() {} };
const ADMIN = "test-admin-key-not-real";

function adminCall(env, path, { method = "GET", body, token = "", ip = "10.0.0.1" } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (token) headers.Authorization = "Bearer " + token;
  return worker.fetch(new Request("https://worker.test" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, ctx);
}

const login = (env, key, ip) => adminCall(env, "/api/admin/login", { method: "POST", body: { key }, ip });

test("未配置 ADMIN_KEY 时拒绝登录，密钥不出现在响应里", async () => {
  const env = careEnv();
  const r = await login(env, ADMIN);
  assert.equal(r.status, 503);
  const text = await r.text();
  assert.match(text, /ADMIN_KEY_MISSING/);
  assert.equal(text.includes(ADMIN), false);
});

test("连续输错 5 次锁定 10 分钟，正确密钥在锁定期也无法登录", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  const ip = "10.0.0.2";
  for (let i = 1; i <= 4; i++) {
    const r = await login(env, "wrong-" + i, ip);
    assert.equal(r.status, 401);
    const d = await r.json();
    assert.equal(d.remaining, 5 - i);
  }
  const fifth = await login(env, "wrong-5", ip);
  assert.equal(fifth.status, 429);
  assert.equal((await fifth.json()).retry_after, 600);
  const correct = await login(env, ADMIN, ip);
  assert.equal(correct.status, 429);
  const other = await login(env, ADMIN, "10.0.0.3");
  assert.equal(other.status, 200);
});

test("登录后可看概览、脱敏 Token、审计和备份，退出后会话失效", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  env.KV.seed("qr:hosp-1:abcd1234efgh", { state: "active", expires_at: 1900000000000, created_at: 1700000000000 });
  env.KV.seed("qr:hosp-1:zzzz9999yyyy", { state: "expired", expires_at: 1800000000000 });
  env.KV.seed("care:catalog:hosp-1", { catalog_version: "v1" });
  env.KV.seed("backup:hosp-1:2026-11-22", { at: 1700000000000, tenant_id: "hosp-1" });

  const ip = "10.0.0.4";
  const ok = await login(env, ADMIN, ip);
  assert.equal(ok.status, 200);
  const { token } = await ok.json();
  assert.ok(token && token.length >= 20);

  assert.equal((await adminCall(env, "/api/admin/session", { token, ip })).status, 200);

  const overview = await (await adminCall(env, "/api/admin/overview", { token, ip })).json();
  assert.equal(overview.counts.tokens, 2);
  assert.equal(overview.counts.tenants, 2);
  assert.equal(overview.counts.backups, 1);

  const tenants = await (await adminCall(env, "/api/admin/tenants", { token, ip })).json();
  const hosp = tenants.tenants.find((t) => t.tenant_id === "hosp-1");
  assert.equal(hosp.tokens, 2);
  assert.equal(hosp.catalog, true);

  const tokensRes = await adminCall(env, "/api/admin/tokens", { token, ip });
  const tokensText = await tokensRes.text();
  assert.equal(tokensText.includes("abcd1234efgh"), false);
  const tokens = JSON.parse(tokensText).tokens;
  assert.equal(tokens.length, 2);
  assert.equal(tokens.some((t) => t.masked === "abcd****"), true);
  const ref = tokens.find((t) => t.masked === "abcd****").ref;

  const audit = await (await adminCall(env, "/api/admin/audit", { token, ip })).json();
  assert.equal(audit.rows.some((r) => r.op === "login"), true);

  const backups = await (await adminCall(env, "/api/admin/backups", { token, ip })).json();
  assert.equal(backups.rows.length, 1);

  const badReveal = await adminCall(env, "/api/admin/reveal", { method: "POST", token, body: { key: "wrong", ref }, ip });
  assert.equal(badReveal.status, 401);
  const reveal = await adminCall(env, "/api/admin/reveal", { method: "POST", token, body: { key: ADMIN, ref }, ip });
  assert.equal(reveal.status, 200);
  const shown = await reveal.json();
  assert.equal(shown.key, "qr:hosp-1:abcd1234efgh");
  assert.equal(shown.token, "abcd1234efgh");

  const logout = await adminCall(env, "/api/admin/logout", { method: "POST", token, ip });
  assert.equal(logout.status, 200);
  assert.equal((await adminCall(env, "/api/admin/session", { token, ip })).status, 401);
  assert.equal((await adminCall(env, "/api/admin/tokens", { token, ip })).status, 401);
});
