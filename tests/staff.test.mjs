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

async function seedStaff(env, roles = ["R3"], tenant = "tenant1", username = "carol") {
  env.KV.seed("user:" + username, { staff: true, staff_roles: roles, care_scopes: [{ tenant_id: tenant, profile_id: "staff" }] });
  env.KV.seed("token:" + username + "-token", username);
}
async function createAccess(env, admin, plan = "year", tenant = "tenant1") {
  const r = await call(env, "/api/admin/access", { method: "POST", token: admin, body: { tenant_id: tenant, plan } });
  assert.equal(r.status, 200);
  return (await r.json()).record;
}

test("两类二维码分开生成和计数，患者码不会给已有医院偷偷续期", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN }, admin = await adminLogin(env);
  const access = await createAccess(env, admin, "trial7");
  assert.match(access.url, /^https:\/\/jiuyibanlv\.pages\.dev\/\?hospital=tenant1&access=/);
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
  await seedStaff(env, ["R5"]);
  assert.equal((await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog: makeCatalog("v2") } })).status, 403);
  await seedStaff(env, ["R3"]);
  assert.equal((await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant2", catalog: makeCatalog("v2") } })).status, 403);
  assert.equal((await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog: {} } })).status, 422);
  const saved = await call(env, "/api/staff/config", { method: "PUT", token: "carol-token", body: { tenant_id: "tenant1", catalog: makeCatalog("v2") } });
  assert.equal(saved.status, 200);
  assert.equal((await env.KV.get("care:catalog:tenant1", "json")).catalog_version, "v2");
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
