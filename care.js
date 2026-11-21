import { buildCareMessages, validCareJsonReply } from "./care-prompts.js";
import {
  CareHttpError, careId, careTenantId, careOptionIds, careCatalogVersion,
  loadCareCatalog, matchCareCatalog
} from "./care-catalog.js";

export { CareHttpError } from "./care-catalog.js";

export async function runCareChat({ env, role, text, history, l2, budget_ms }, llm) {
  const built = buildCareMessages({ role, text, history, l2 });
  const requestedBudget = Number(budget_ms) || 45000;
  const budget = Math.max(6000, Math.min(45000, Math.max(20000, Math.min(120000, requestedBudget)) - 1500));
  const info = {};
  const accept = built.outputSchema == null ? undefined : validCareJsonReply;
  let raw;
  try { raw = await llm(env, built.messages, info, budget, accept); }
  catch { throw new CareHttpError(502, "所有模型均未返回有效的角色回答", "CARE_MODEL_UNAVAILABLE"); }
  const reply = String(raw || "").trim();
  if (!reply) throw new CareHttpError(502, "所有模型均未返回有效的角色回答", "CARE_MODEL_UNAVAILABLE");
  return { role: built.role, reply, awaiting: false, confirm: "", tools: [], steps: [] };
}

export async function careActorFromReq(request, env, url, tenantId, userLookup) {
  if (!env.KV) throw new CareHttpError(503, "KV 没有绑定", "KV_NOT_BOUND");
  const username = await userLookup(request, env, url, "");
  if (!username) throw new CareHttpError(401, "未登录，token失效", "UNAUTHORIZED");
  let record;
  try { record = await env.KV.get("user:" + username, "json"); }
  catch { throw new CareHttpError(503, "授权记录读取失败", "AUTH_RECORD_UNAVAILABLE"); }
  const allScopes = record && Array.isArray(record.care_scopes) ? record.care_scopes.filter((scope) => scope && typeof scope.tenant_id === "string" && typeof scope.profile_id === "string" && scope.profile_id.trim()) : [];
  if (tenantId == null) return { username, care_scopes: allScopes.map((scope) => ({ tenant_id: scope.tenant_id, profile_id: scope.profile_id })) };
  const scopes = allScopes.filter((scope) => scope.tenant_id === tenantId);
  if (scopes.length !== 1) throw new CareHttpError(403, "当前账号没有该租户的患者档案授权", "CARE_SCOPE_FORBIDDEN");
  return { username, tenant_id: tenantId, profile_id: scopes[0].profile_id };
}

function publicTask(task) {
  const { owner, steps, ...pub } = task;
  return {
    ...pub,
    steps,
    step: task.status === "completed" ? null : steps[task.current_step - 1] || null
  };
}

export async function prepareCareTask(body, env, actor) {
  const tenantId = careTenantId(body.tenant_id);
  if (actor.tenant_id !== tenantId) throw new CareHttpError(403, "不能为其他租户创建任务", "CARE_SCOPE_FORBIDDEN");
  const optionIds = careOptionIds(body.option_ids);
  const serviceId = careId(body.service_id, "service_id");
  const catalogVersion = careCatalogVersion(body.catalog_version);
  if (body.confirmed !== true) throw new CareHttpError(422, "患者必须明确确认后才能创建任务", "PATIENT_CONFIRMATION_REQUIRED");
  const catalog = await loadCareCatalog(env, tenantId);
  if (catalog.catalog_version !== catalogVersion) throw new CareHttpError(409, "catalog_version 与当前目录不一致，请重新匹配", "CATALOG_VERSION_CONFLICT");
  const matched = matchCareCatalog(catalog, optionIds);
  const candidate = matched.matches.find((item) => item.service_id === serviceId);
  if (!candidate) throw new CareHttpError(422, "service_id 不在本次选项匹配结果中", "SERVICE_NOT_MATCHED");
  const { steps, ...service } = candidate.service;
  const now = Date.now();
  return {
    task_id: "task_" + crypto.randomUUID(),
    tenant_id: tenantId,
    profile_id: actor.profile_id,
    owner: { username: actor.username, profile_id: actor.profile_id, tenant_id: tenantId },
    option_ids: optionIds,
    service_id: serviceId,
    service,
    steps,
    catalog_version: catalogVersion,
    status: "not_started",
    current_step: 1,
    completed_steps: 0,
    created_at: now,
    updated_at: now
  };
}

export async function careTaskDo(env, taskId, action, payload) {
  const id = careId(taskId, "task_id");
  const binding = env.CARE_TASKS;
  if (!binding || typeof binding.idFromName !== "function" || typeof binding.get !== "function") {
    throw new CareHttpError(503, "CARE_TASKS Durable Object 没有绑定", "CARE_TASKS_NOT_BOUND");
  }
  let response;
  try {
    const stub = binding.get(binding.idFromName(id));
    response = await stub.fetch("https://care-task.internal/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
  } catch {
    throw new CareHttpError(503, "医院任务存储不可用", "CARE_TASK_STORAGE_UNAVAILABLE");
  }
  const body = await response.json().catch(() => null);
  if (!body) throw new CareHttpError(502, "医院任务存储返回了无效响应", "CARE_TASK_STORAGE_INVALID_RESPONSE");
  return { status: response.status, body };
}

const internalJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const ownsTask = (task, actor) => {
  if (!actor || !task.owner || task.owner.username !== actor.username) return false;
  if (actor.tenant_id != null) return task.owner.profile_id === actor.profile_id && task.owner.tenant_id === actor.tenant_id;
  return Array.isArray(actor.care_scopes) && actor.care_scopes.some((scope) => scope.profile_id === task.owner.profile_id && scope.tenant_id === task.owner.tenant_id);
};
const validIdemKey = (value) => /^[\x21-\x7e]{8,128}$/.test(String(value == null ? "" : value).trim());

async function requestFingerprint(input) {
  const canonical = JSON.stringify({
    step: input && Object.prototype.hasOwnProperty.call(input, "step") ? input.step : null,
    catalog_version: input && Object.prototype.hasOwnProperty.call(input, "catalog_version") ? input.catalog_version : null,
    completion: input && Object.prototype.hasOwnProperty.call(input, "completion") ? input.completion : null
  });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class CareTask {
  constructor(state) { this.state = state; }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    if (url.pathname === "/create" && request.method === "POST") return this.create(body.task);
    if (url.pathname === "/read" && request.method === "POST") return this.read(body.actor);
    if (url.pathname === "/advance" && request.method === "POST") return this.advance(body.actor, body.input, body.idempotency_key);
    return internalJson({ ok: false, msg: "任务存储接口不存在", code: "NOT_FOUND" }, 404);
  }

  async create(task) {
    if (!task || !task.task_id) return internalJson({ ok: false, msg: "任务内容不完整", code: "INVALID_TASK" }, 422);
    const result = await this.state.storage.transaction(async (txn) => {
      if (await txn.get("task")) return { status: 409, body: { ok: false, msg: "任务ID已存在", code: "TASK_EXISTS" } };
      await txn.put("task", task);
      return { status: 201, body: { ok: true, task: publicTask(task) } };
    });
    return internalJson(result.body, result.status);
  }

  async read(actor) {
    const task = await this.state.storage.get("task");
    if (!task) return internalJson({ ok: false, msg: "医院任务不存在", code: "TASK_NOT_FOUND" }, 404);
    if (!ownsTask(task, actor)) return internalJson({ ok: false, msg: "无权访问该医院任务", code: "TASK_FORBIDDEN" }, 403);
    return internalJson({ ok: true, task: publicTask(task) });
  }

  async advance(actor, input, rawKey) {
    const key = String(rawKey == null ? "" : rawKey).trim();
    const fingerprint = await requestFingerprint(input);
    const result = await this.state.storage.transaction(async (txn) => {
      const task = await txn.get("task");
      if (!task) return { status: 404, body: { ok: false, msg: "医院任务不存在", code: "TASK_NOT_FOUND" } };
      if (!ownsTask(task, actor)) return { status: 403, body: { ok: false, msg: "无权操作该医院任务", code: "TASK_FORBIDDEN" } };

      if (validIdemKey(key)) {
        const previous = await txn.get("idem:" + key);
        if (previous) {
          if (previous.fingerprint !== fingerprint) return { status: 409, body: { ok: false, msg: "同一 Idempotency-Key 不能用于不同请求", code: "IDEMPOTENCY_KEY_REUSED" } };
          return previous.response;
        }
      }

      if (!["not_started", "in_progress"].includes(task.status)) return { status: 409, body: { ok: false, msg: "任务已完成，不能继续推进", code: "TASK_STATE_CONFLICT" } };
      if (!Number.isInteger(input && input.step) || input.step !== task.current_step) return { status: 409, body: { ok: false, msg: "step 必须等于 current_step", code: "TASK_STEP_CONFLICT" } };
      if (!input || input.catalog_version !== task.catalog_version) return { status: 409, body: { ok: false, msg: "catalog_version 与任务快照不一致", code: "CATALOG_VERSION_CONFLICT" } };
      if (input.completion !== "patient_confirmed") return { status: 422, body: { ok: false, msg: "只有患者明确反馈已完成才能推进", code: "PATIENT_CONFIRMATION_REQUIRED" } };
      if (!validIdemKey(key)) return { status: 422, body: { ok: false, msg: "Idempotency-Key 必须为8–128个可见ASCII字符", code: "INVALID_IDEMPOTENCY_KEY" } };

      const step = input.step;
      task.status = step === 7 ? "completed" : "in_progress";
      task.current_step = step === 7 ? 7 : step + 1;
      task.completed_steps = step;
      task.updated_at = Date.now();
      const response = { status: 200, body: { ok: true, task: publicTask(task) } };
      await txn.put("task", task);
      await txn.put("idem:" + key, { fingerprint, response });
      return response;
    });
    return internalJson(result.body, result.status);
  }
}
