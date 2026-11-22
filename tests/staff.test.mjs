import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import { careEnv, makeCatalog } from "./care-test-helpers.mjs";

const ctx = { waitUntil() {} };
const ADMIN = "test-admin-key-not-real";

function call(env, path, { method = "GET", body, token = "", ip = "10.1.0.1" } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
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
