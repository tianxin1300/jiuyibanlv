import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import { migrateLegacyCatalog } from "../care-catalog.js";
import { careEnv, makeCatalog } from "./care-test-helpers.mjs";

const pending = [];
const ctx = { waitUntil(p) { pending.push(p); } };
const ADMIN = "test-admin-key-not-real";
const MEDICAL_KEY = "a".repeat(64);

function call(env, path, { method = "GET", body, token = "", ip = "10.9.0.1", headers: extraHeaders = {} } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...extraHeaders };
  if (token) headers.Authorization = "Bearer " + token;
  return worker.fetch(new Request("https://worker.test" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, ctx);
}
const adminLogin = async (env) => (await (await call(env, "/api/admin/login", { method: "POST", body: { key: ADMIN } })).json()).token;
async function createAccess(env, admin, plan = "year", tenant = "tenant1") {
  const r = await call(env, "/api/admin/access", { method: "POST", token: admin, body: { tenant_id: tenant, plan } });
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.json()).record;
}
function staffUser(env) {
  env.KV.seed("user:carol", { staff: true, staff_roles: ["R5"], care_scopes: [{ tenant_id: "tenant1", profile_id: "staff1" }] });
  env.KV.seed("token:carol-token", "carol");
}

test("二维码新档位为 7 天 / 3 个月 / 365 天，同院新码撤销旧码", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  env.KV.seed("sub:tenant1", { plan: "trial7", status: "active", expires_at: Date.now() + 86400000 });
  const admin = await adminLogin(env);
  const first = await createAccess(env, admin, "trial7");
  const second = await createAccess(env, admin, "quarter");
  assert.equal(second.plan_label, "3 个月");
  const old = await env.KV.get("access:" + first.id, "json");
  assert.equal(old.status, "revoked");
  assert.equal(old.replaced_by, second.id);
  const q = await createAccess(env, admin, "year");
  assert.equal(q.plan, "year");
  const days = (q.expires_at - q.created_at) / 86400000;
  assert.ok(days > 364 && days < 366, "年约应为 365 天");
  assert.equal((await call(env, "/api/admin/access", { method: "POST", token: admin, body: { tenant_id: "tenant1", plan: "trial30" } })).status, 422);
});

test("患者事件只收白名单字段，匿名/实名事件可查最近与月报", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  staffUser(env);
  const admin = await adminLogin(env);
  const access = await createAccess(env, admin, "year");
  const now = new Date().toISOString();
  const month = now.slice(0, 7);
  const ok = await call(env, "/api/public/events", { method: "POST", body: {
    tenant_id: "tenant1", access: access.id, events: [
      { id: "evt-0001-abcd", kind: "followup", occurred_at: now, profile_id: "profile1", visit_date: now.slice(0, 10), serial: "ABC123" },
      { id: "evt-0002-abcd", kind: "redeem", occurred_at: now, activity: "复诊打卡季", prize: "纪念品", patient_name: "张三", phone_tail: "1234" }
    ]
  } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.accepted.length, 2);
  const bad = await call(env, "/api/public/events", { method: "POST", body: {
    tenant_id: "tenant1", access: access.id, events: [{ id: "evt-0003-abcd", kind: "followup", occurred_at: now, diagnosis: "不得上传" }]
  } });
  assert.equal((await bad.json()).rejected[0].reason, "unknown_field");
  const tooMany = await call(env, "/api/public/events", { method: "POST", body: {
    tenant_id: "tenant1", access: access.id, events: Array.from({ length: 41 }, (_, i) => ({ id: "evt-batch-" + i, kind: "followup", occurred_at: now }))
  } });
  assert.equal(tooMany.status, 413);
  const recent = await call(env, "/api/staff/events?tenant_id=tenant1&limit=300", { token: "carol-token" });
  assert.equal(recent.status, 200);
  assert.equal((await recent.json()).rows.length, 2);
  const report = await call(env, "/api/staff/events?tenant_id=tenant1&month=" + month, { token: "carol-token" });
  const rep = (await report.json()).report;
  assert.equal(rep.total, 2);
  assert.equal(rep.named, 1);
  assert.equal(rep.anonymous, 1);
  const denied = await call(env, "/api/staff/events?tenant_id=tenant1", { token: "alice-token" });
  assert.equal(denied.status, 403);
});

test("医疗摘要拒绝敏感信息与未同意，删除会写墓碑", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN, MEDICAL_KEY };
  const admin = await adminLogin(env);
  const access = await createAccess(env, admin, "year");
  const base = { tenant_id: "tenant1", text: "明天复诊，带上上次的检查单", consent: true, access: access.id };
  const pii = await call(env, "/api/medical/summarize", { method: "POST", token: "alice-token", body: { ...base, text: "手机号 13800138000" } });
  assert.equal(pii.status, 400);
  assert.equal((await pii.json()).code, "MEDICAL_PII_REJECTED");
  const noConsent = await call(env, "/api/medical/summarize", { method: "POST", token: "alice-token", body: { ...base, consent: false } });
  assert.equal((await noConsent.json()).code, "MEDICAL_CONSENT_REQUIRED");
  const keyless = { ...env, MEDICAL_KEY: "" };
  const noKey = await call(keyless, "/api/medical/summarize", { method: "POST", token: "alice-token", body: base });
  assert.equal(noKey.status, 503);
  assert.equal((await noKey.json()).code, "MEDICAL_KEY_MISSING");
  const empty = await call(env, "/api/medical/summary?tenant_id=tenant1", { token: "alice-token" });
  assert.equal(empty.status, 200);
  const needConfirm = await call(env, "/api/medical/data?tenant_id=tenant1", { method: "DELETE", token: "alice-token", body: { tenant_id: "tenant1", access: access.id } });
  assert.equal((await needConfirm.json()).code, "DELETE_CONFIRM_REQUIRED");
  const done = await call(env, "/api/medical/data", { method: "DELETE", token: "alice-token", body: { tenant_id: "tenant1", access: access.id, confirm: true } });
  assert.equal(done.status, 200);
  assert.ok(await env.KV.get("tombstone:tenant1:profile1"));
});

test("未绑定 R2 时院方素材写入 KV 兜底，自动部署不再依赖预先创建 bucket", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  env.KV.seed("user:carol", { staff: true, staff_roles: ["R3"], care_scopes: [{ tenant_id: "tenant1", profile_id: "s1" }] });
  env.KV.seed("token:carol-token", "carol");
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(16).fill(0)]);
  const r = await worker.fetch(new Request("https://worker.test/api/staff/config/image?tenant_id=tenant1&service_id=svcA", {
    method: "POST",
    headers: { Authorization: "Bearer carol-token", "Content-Type": "image/png" },
    body: bytes
  }), env, ctx);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.store, "kv");
  assert.ok(await env.KV.get("care-asset:tenant1:" + body.asset_id));
});

test("每日 Cron 会下线过期患者码、清理 30 天前记录并生成备份", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  const old = Date.now() - 40 * 86400000;
  env.KV.seed("access:expired-code", { tenant_id: "tenant1", status: "active", created_at: old - 86400000, expires_at: old });
  await worker.scheduled({ cron: "0 16 * * *" }, env, ctx);
  await Promise.all(pending.splice(0));
  assert.equal(await env.KV.get("access:expired-code"), null);
  const today = "auto-" + new Date().toISOString().slice(0, 10);
  assert.ok(await env.KV.get("backupmeta:" + today));
});

test("旧模板迁移保留简介与标签，超过七步进入迁移报告", () => {
  const legacy = {
    n: "测试医院",
    show: [{
      id: "svcA", t: "复诊服务", d: "原简介", tag: "热门", price: "以医院公示为准",
      department: "内科", clinic_hours: "周一至周五", booking_channel: "公众号",
      image_url: "asset:old-logo",
      steps: Array.from({ length: 8 }, (_, i) => ({ t: "第" + (i + 1) + "步" }))
    }],
    act: [{ service_id: "svcA" }]
  };
  const report = migrateLegacyCatalog(legacy);
  assert.equal(report.draft.services.svcA.description, "原简介");
  assert.equal(report.draft.services.svcA.tag, "热门");
  assert.equal(report.draft.services.svcA.service_type, "benefit");
  assert.equal(report.unmapped[0].extra_steps.length, 1);
  assert.ok(report.warnings.some((w) => w.includes("8 步")));
});

test("备份可生成、按院恢复并要求测试环境清除", async () => {
  const env = { ...careEnv(), ADMIN_KEY: ADMIN };
  const admin = await adminLogin(env);
  await createAccess(env, admin, "year");
  const created = await call(env, "/api/admin/backups/run", { method: "POST", token: admin, body: { tenant_id: "tenant1" } });
  assert.equal(created.status, 200);
  const backup = (await created.json()).backup;
  const listed = await (await call(env, "/api/admin/backups", { token: admin })).json();
  assert.ok(listed.rows.some((r) => r.id === backup.id));
  env.KV.seed("care:catalog:tenant1", makeCatalog("v2"));
  const restored = await call(env, "/api/admin/backups/restore", { method: "POST", token: admin, body: { backup_id: backup.id, tenant_id: "tenant1", confirm: "tenant1" } });
  assert.equal(restored.status, 200);
  assert.equal((await env.KV.get("care:catalog:tenant1", "json")).catalog_version, "v1");
  assert.equal((await call(env, "/api/admin/backups/restore", { method: "POST", token: admin, body: { backup_id: backup.id, tenant_id: "tenant1", confirm: "wrong" } })).status, 422);
  assert.equal((await call(env, "/api/admin/clear-test", { method: "POST", token: admin, body: { confirm: "CLEAR-TEST" } })).status, 403);
  const testEnv = { ...env, APP_ENV: "test" };
  assert.equal((await call(testEnv, "/api/admin/clear-test", { method: "POST", token: admin, body: { confirm: "CLEAR-TEST" } })).status, 200);
});
