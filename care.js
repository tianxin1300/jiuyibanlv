import { buildCareMessages, validCareJsonReply } from "./care-prompts.js";
import {
  CareHttpError, careId, careTenantId, careOptionIds, careCatalogVersion,
  loadCareCatalog, matchCareCatalog
} from "./care-catalog.js";

export { CareHttpError } from "./care-catalog.js";

// 患者内容只在 Worker 内脱敏；国内模型与原有海外兜底共用这一份清洗后的 messages。
export function redactCareText(value) {
  let text = String(value == null ? "" : value);
  text = text.replace(/(患者姓名|病人姓名|联系人姓名|姓名)(\s*[:：=]\s*)[\p{L}·•.\-]{1,32}/gu, "$1$2[姓名已脱敏]");
  text = text.replace(/(家庭住址|户籍地址|通讯地址|联系地址|现住址|住址|地址)(\s*[:：=]\s*)[^\r\n，,。；;]{1,120}/g, "$1$2[地址已脱敏]");
  text = text.replace(/(病床号|病床|床号|床位)(\s*[:：=]\s*)[^\s\r\n，,。；;]{1,30}/g, "$1$2[床位已脱敏]");
  text = text.replace(/(^|[^0-9A-Za-z])\d{6}(?:\d{8}\d{3}[0-9Xx]|\d{6}\d{3})(?![0-9A-Za-z])/g, "$1[身份证已脱敏]");
  text = text.replace(/(^|\D)1[3-9]\d{9}(?!\d)/g, "$1[手机号已脱敏]");
  text = text.replace(/(?:北京市|天津市|上海市|重庆市|[\u4e00-\u9fa5]{2,8}(?:省|自治区)|[\u4e00-\u9fa5]{2,12}(?:区|县))[\u4e00-\u9fa5A-Za-z0-9-]{2,100}?\d+(?:[-–—]\d+)*号(?:[\u4e00-\u9fa5A-Za-z0-9-]{0,20}(?:室|栋|单元|楼))?/g, "[地址已脱敏]");
  text = text.replace(/[A-Za-z]?\d{1,6}(?:[-–—]\d{1,4})?床(?:位|号)?/g, "[床位已脱敏]");
  return text;
}

export function redactCareMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    ...message,
    content: typeof message.content === "string"
      ? redactCareText(message.content)
      : Array.isArray(message.content)
        ? message.content.map((part) => part && typeof part.text === "string" ? { ...part, text: redactCareText(part.text) } : part)
        : message.content
  }));
}

async function careFetch(url, options, budget) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(30000, budget || 15000)));
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function careUpstreamMessage(label, status, data, code) {
  const nested = data && data.error && typeof data.error === "object" ? data.error : {};
  const raw = nested.message || (data && (data.error_msg || data.error_description || data.message || data.msg)) || (data && typeof data.error === "string" ? data.error : "");
  const detail = redactCareText(String(raw || "")).replace(/sk-[A-Za-z0-9_-]+/gi, "[密钥已隐藏]").slice(0, 180);
  return new CareHttpError(502, label + "返回 HTTP " + status + (detail ? "：" + detail : ""), code);
}

async function careUpstreamJson(response, label, code) {
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  if (!response.ok) throw careUpstreamMessage(label, response.status, data, code);
  if (!data || typeof data !== "object") throw new CareHttpError(502, label + "返回了无效 JSON", code);
  return data;
}

async function ernieAccessToken(env, budget) {
  const cacheKey = "ai:ernie-token";
  if (env.KV) {
    const cached = await env.KV.get(cacheKey, "json").catch(() => null);
    if (cached && cached.access_token && Number(cached.expires_at) > Date.now() + 60000) return cached.access_token;
  }
  const query = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: String(env.ERNIE_API_KEY || ""),
    client_secret: String(env.ERNIE_SECRET_KEY || "")
  });
  const response = await careFetch("https://aip.baidubce.com/oauth/2.0/token?" + query, { method: "POST" }, Math.min(10000, budget));
  const data = await careUpstreamJson(response, "百度千帆鉴权", "ERNIE_AUTH_ERROR");
  if (!data.access_token || data.error) throw careUpstreamMessage("百度千帆鉴权", response.status, data, "ERNIE_AUTH_ERROR");
  if (env.KV) {
    const expiresAt = Date.now() + Math.max(300, Number(data.expires_in) || 2592000) * 1000;
    await env.KV.put(cacheKey, JSON.stringify({ access_token: data.access_token, expires_at: expiresAt }), { expirationTtl: Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)) }).catch(() => {});
  }
  return data.access_token;
}

async function callErnie(env, messages, budget) {
  const token = await ernieAccessToken(env, budget);
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const dialogue = messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content }));
  const response = await careFetch("https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/ernie-speed-128k?access_token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: dialogue, ...(system ? { system } : {}), stream: false, temperature: 0.3, max_output_tokens: 4096 })
  }, budget);
  const data = await careUpstreamJson(response, "百度千帆", "ERNIE_UPSTREAM_ERROR");
  if (data.error_code || data.error) throw careUpstreamMessage("百度千帆", response.status, data, "ERNIE_UPSTREAM_ERROR");
  return String(data.result || "").trim();
}

async function callQwen(env, messages, budget) {
  const response = await careFetch("https://dashscope.cn-beijing.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + String(env.DASHSCOPE_KEY || "") },
    body: JSON.stringify({ model: "qwen-turbo", messages, stream: false, temperature: 0.3, max_tokens: 4096 })
  }, budget);
  const data = await careUpstreamJson(response, "通义千问", "DASHSCOPE_UPSTREAM_ERROR");
  if (data.error) throw careUpstreamMessage("通义千问", response.status, data, "DASHSCOPE_UPSTREAM_ERROR");
  return String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
}

export async function runCareLlm(env, messages, info, budget, accept, overseasLlm, provider = "auto") {
  const selected = String(provider || "auto").trim().toLowerCase();
  if (!["auto", "ernie", "qwen"].includes(selected)) throw new CareHttpError(400, "provider 只支持 auto、ernie、qwen", "AI_PROVIDER_INVALID");
  const safeMessages = redactCareMessages(messages);
  info = info || {}; info.tried = []; info.from = "";
  const deadline = Date.now() + Math.max(1000, Number(budget) || 15000);
  const hasErnie = !!(String(env.ERNIE_API_KEY || "").trim() && String(env.ERNIE_SECRET_KEY || "").trim());
  const hasQwen = !!String(env.DASHSCOPE_KEY || "").trim();
  if (selected === "ernie" && !hasErnie) throw new CareHttpError(503, "尚未配置 ERNIE_API_KEY / ERNIE_SECRET_KEY", "ERNIE_NOT_CONFIGURED");
  if (selected === "qwen" && !hasQwen) throw new CareHttpError(503, "尚未配置 DASHSCOPE_KEY", "DASHSCOPE_NOT_CONFIGURED");

  const candidates = selected === "ernie" ? ["ernie"] : selected === "qwen" ? ["qwen"] : [
    ...(hasErnie ? ["ernie"] : []), ...(hasQwen ? ["qwen"] : [])
  ];
  for (const name of candidates) {
    const left = deadline - Date.now();
    if (left < 500) break;
    try {
      const text = name === "ernie" ? await callErnie(env, safeMessages, left) : await callQwen(env, safeMessages, left);
      if (text && (!accept || accept(text))) {
        info.from = name === "ernie" ? "ERNIE" : "Qwen";
        return text;
      }
      info.tried.push((name === "ernie" ? "百度千帆" : "通义千问") + "：返回内容为空或不符合要求");
    } catch (error) {
      // 已收到上游明确 HTTP/业务错误时如实失败，绝不包装成成功流，也不悄悄换一家掩盖错误。
      if (error instanceof CareHttpError) throw error;
      info.tried.push((name === "ernie" ? "百度千帆" : "通义千问") + "：" + (error && error.name === "AbortError" ? "请求超时" : "网络连接失败"));
    }
  }
  if (selected !== "auto" || deadline - Date.now() < 500) return "";
  return overseasLlm(env, safeMessages, info, deadline - Date.now(), accept);
}

export async function runCareChat({ env, role, text, history, l2, budget_ms, assistant_hint }, llm) {
  const built = buildCareMessages({ role, text, history, l2, assistant_hint });
  const requestedBudget = Number(budget_ms) || 45000;
  const budget = Math.max(6000, Math.min(45000, Math.max(20000, Math.min(120000, requestedBudget)) - 1500));
  const info = {};
  const accept = built.outputSchema == null ? undefined : validCareJsonReply;
  let raw;
  try { raw = await llm(env, built.messages, info, budget, accept); }
  catch (error) {
    if (error instanceof CareHttpError) throw error;
    throw new CareHttpError(502, "所有模型均未返回有效的角色回答", "CARE_MODEL_UNAVAILABLE");
  }
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
