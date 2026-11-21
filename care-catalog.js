// 就医任务目录。真实目录由运维写入 KV：care:catalog:{tenant_id}。
export class CareHttpError extends Error {
  constructor(status, message, code = "CARE_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const CARE_SERVICE_FIELDS = [
  "name", "department", "price", "clinic_hours", "materials", "booking_channel", "image_url", "service_type"
];
export const CARE_STEP_FIELDS = ["materials", "time", "location", "official_url"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const plainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

export function careId(value, label = "ID") {
  const id = String(value == null ? "" : value).trim();
  if (!ID_RE.test(id)) throw new CareHttpError(422, `${label} 格式不正确`, "INVALID_ID");
  return id;
}

export function careTenantId(value) {
  return careId(value, "tenant_id");
}

export function careOptionIds(value, status = 422) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new CareHttpError(status, "option_ids 必须包含1–50个字符串", "INVALID_OPTION_IDS");
  }
  const out = [], seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) throw new CareHttpError(status, "option_ids 必须包含1–50个字符串", "INVALID_OPTION_IDS");
    const id = careId(raw, "option_id");
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

export function careCatalogVersion(value) {
  const version = String(value == null ? "" : value).trim();
  if (!version || version.length > 128 || /[\u0000-\u001f]/.test(version)) {
    throw new CareHttpError(422, "catalog_version 格式不正确", "INVALID_CATALOG_VERSION");
  }
  return version;
}

function hasValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return !!value.trim();
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return typeof value === "boolean";
}

function catalogError(message) {
  return new CareHttpError(503, "服务目录未发布或内容不完整：" + message, "CATALOG_UNAVAILABLE");
}

function normalizeStep(step, index) {
  if (!plainObject(step) || step.step !== index + 1 || !hasValue(step.text)) throw catalogError(`第${index + 1}步缺少序号或说明`);
  const out = { step: index + 1, text: step.text };
  for (const key of CARE_STEP_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(step, key)) throw catalogError(`第${index + 1}步缺少${key}`);
    out[key] = step[key];
  }
  return out;
}

function normalizeService(service, serviceId) {
  if (!plainObject(service) || service.service_id !== serviceId) throw catalogError(`服务${serviceId}的service_id不一致`);
  const out = { service_id: serviceId };
  for (const key of CARE_SERVICE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(service, key) || !hasValue(service[key])) throw catalogError(`服务${serviceId}缺少${key}`);
    out[key] = service[key];
  }
  if (!["project", "benefit"].includes(service.service_type)) throw catalogError(`服务${serviceId}的service_type必须是project或benefit`);
  if (!Array.isArray(service.steps) || service.steps.length !== 7) throw catalogError(`服务${serviceId}必须恰好包含7步`);
  out.steps = service.steps.map(normalizeStep);
  return out;
}

export function validateCareCatalog(catalog) {
  if (!plainObject(catalog)) throw catalogError("目录为空");
  let catalog_version;
  try { catalog_version = careCatalogVersion(catalog.catalog_version); }
  catch { throw catalogError("catalog_version缺失或格式不正确"); }
  if (!plainObject(catalog.options) || !plainObject(catalog.services) || !Object.keys(catalog.services).length) throw catalogError("options/services为空");
  const services = {};
  for (const [id, service] of Object.entries(catalog.services)) {
    if (!ID_RE.test(id)) throw catalogError("service_id格式不正确");
    services[id] = normalizeService(service, id);
  }
  const options = {};
  for (const [id, serviceId] of Object.entries(catalog.options)) {
    if (!ID_RE.test(id) || typeof serviceId !== "string" || !ID_RE.test(serviceId)) throw catalogError("option映射格式不正确");
    if (!services[serviceId]) throw catalogError(`选项${id}指向了不存在的服务`);
    options[id] = serviceId;
  }
  return { catalog_version, options, services };
}

export async function loadCareCatalog(env, tenantId) {
  if (!env.KV) throw new CareHttpError(503, "KV 没有绑定，无法读取服务目录", "KV_NOT_BOUND");
  let catalog;
  try { catalog = await env.KV.get("care:catalog:" + tenantId, "json"); }
  catch { throw new CareHttpError(503, "服务目录读取失败", "CATALOG_UNAVAILABLE"); }
  return validateCareCatalog(catalog);
}

export function matchCareCatalog(catalog, optionIds) {
  const matches = [], byService = new Map();
  for (const optionId of optionIds) {
    const serviceId = catalog.options[optionId];
    if (!serviceId) throw new CareHttpError(422, `未知选项ID：${optionId}`, "UNKNOWN_OPTION_ID");
    const service = catalog.services[serviceId];
    if (!service) throw catalogError(`选项${optionId}指向了不存在的服务`);
    if (!byService.has(serviceId)) {
      const match = { service_id: serviceId, option_ids: [], service };
      byService.set(serviceId, match);
      matches.push(match);
    }
    byService.get(serviceId).option_ids.push(optionId);
  }
  return { catalog_version: catalog.catalog_version, option_ids: optionIds, matches };
}

export async function proxyFastGptMatch(env, tenantId, optionIds, fetchImpl = fetch) {
  const url = String(env.FASTGPT_URL || "").trim(), key = String(env.FASTGPT_KEY || "").trim();
  if (!url && !key) return null;
  if (!url || !key) throw new CareHttpError(503, "FASTGPT_URL 和 FASTGPT_KEY 必须同时配置", "FASTGPT_CONFIG_INCOMPLETE");
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ tenant_id: tenantId, option_ids: optionIds }),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new CareHttpError(502, "FastGPT 匹配请求失败", "FASTGPT_UPSTREAM_FAILED");
  }
}
