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
export const CARE_CONTROL_FIELDS = ["tenant_id", "tier", "trial", "up", "tk", "ai", "icp", "gaba"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSET_RE = /^asset:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const STATIC_IMAGE_RE = /^img\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_.-]{1,100}\.(jpg|jpeg|png|webp)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const plainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function careId(value, label = "ID") {
  const id = String(value == null ? "" : value).trim();
  if (!ID_RE.test(id)) throw new CareHttpError(422, `${label} 格式不正确`, "INVALID_ID");
  return id;
}

export function careTenantId(value) {
  return careId(value, "tenant_id");
}

export function careAssetId(value) {
  const match = ASSET_RE.exec(String(value == null ? "" : value).trim());
  return match ? match[1] : "";
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

function text(value, label, max, required = false) {
  if (value != null && typeof value !== "string" && typeof value !== "number") throw catalogError(`${label}必须是文字`);
  const out = String(value == null ? "" : value).trim();
  if (required && !out) throw catalogError(`${label}不能为空`);
  if (out.length > max || /\u0000/.test(out)) throw catalogError(`${label}超过${max}字或含有非法字符`);
  return out;
}

function bool(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function safeUrl(value, label, required = false) {
  const out = text(value, label, 300, required);
  if (!out) return "";
  if (/^https:\/\/[^\s"'<>]+$/.test(out) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s"'<>]*)?$/.test(out)) return out;
  throw catalogError(`${label}只支持安全的 HTTPS 地址`);
}

function imageRef(value, label, required = false) {
  const out = text(value, label, 300, required);
  if (!out || careAssetId(out) || STATIC_IMAGE_RE.test(out)) return out;
  // 老目录可能仍有 HTTPS 配图；保留配置以兼容七步任务，但公开映射不会输出任意外链。
  if (/^https:\/\/[^\s"'<>]+$/.test(out)) return out;
  throw catalogError(`${label}必须是本院上传图片或旧版 img/ 图片`);
}

function materials(value, label) {
  if (Array.isArray(value)) {
    if (value.length > 30) throw catalogError(`${label}最多30项`);
    return value.map((item, index) => text(item, `${label}第${index + 1}项`, 160));
  }
  return text(value, label, 800);
}

function stringList(value, label, maxItems, maxLength) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw catalogError(`${label}最多${maxItems}项`);
  return value.map((item, index) => text(item, `${label}第${index + 1}项`, maxLength, true));
}

function publicItems(value, label, withDate = false) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) throw catalogError(`${label}最多100项`);
  return value.map((item, index) => {
    if (!plainObject(item)) throw catalogError(`${label}第${index + 1}项格式不正确`);
    const out = { t: text(item.t, `${label}标题`, 80, true), d: text(item.d, `${label}说明`, 1000) };
    if (withDate) {
      out.date = text(item.date, `${label}日期`, 10);
      if (out.date && !DATE_RE.test(out.date)) throw catalogError(`${label}日期格式不正确`);
    }
    return out;
  });
}

function normalizeStep(step, index) {
  if (!plainObject(step) || step.step !== index + 1 || !hasValue(step.text)) throw catalogError(`第${index + 1}步缺少序号或说明`);
  const out = { step: index + 1, text: text(step.text, `第${index + 1}步说明`, 500, true) };
  for (const key of CARE_STEP_FIELDS) {
    if (!own(step, key)) throw catalogError(`第${index + 1}步缺少${key}`);
    if (key === "materials") out[key] = materials(step[key], `第${index + 1}步材料`);
    else if (key === "official_url") out[key] = safeUrl(step[key], `第${index + 1}步官方入口`);
    else out[key] = text(step[key], `第${index + 1}步${key}`, 300);
  }
  return out;
}

function normalizeService(service, serviceId) {
  if (!plainObject(service) || service.service_id !== serviceId) throw catalogError(`服务${serviceId}的service_id不一致`);
  const out = { service_id: serviceId };
  for (const key of CARE_SERVICE_FIELDS) {
    if (!own(service, key) || !hasValue(service[key])) throw catalogError(`服务${serviceId}缺少${key}`);
    if (key === "materials") out[key] = materials(service[key], `服务${serviceId}材料`);
    else if (key === "image_url") out[key] = imageRef(service[key], `服务${serviceId}配图`, true);
    else if (key === "service_type") out[key] = text(service[key], `服务${serviceId}类型`, 20, true);
    else out[key] = text(service[key], `服务${serviceId}${key}`, key === "booking_channel" ? 500 : 300, true);
  }
  if (!["project", "benefit"].includes(out.service_type)) throw catalogError(`服务${serviceId}的service_type必须是project或benefit`);
  if (service.description != null) out.description = text(service.description, `服务${serviceId}简介`, 300);
  if (service.tag != null) out.tag = text(service.tag, `服务${serviceId}标签`, 40);
  if (!Array.isArray(service.steps) || service.steps.length !== 7) throw catalogError(`服务${serviceId}必须恰好包含7步`);
  out.steps = service.steps.map(normalizeStep);
  return out;
}

function normalizeActivity(activity, index, services) {
  if (!plainObject(activity)) throw catalogError(`第${index + 1}个惠民活动格式不正确`);
  const serviceId = text(activity.service_id, `第${index + 1}个活动service_id`, 128, true);
  const service = services[serviceId];
  if (!service || service.service_type !== "benefit") throw catalogError(`活动${serviceId}必须关联已上架的惠民服务`);
  const id = text(activity.id || `act-${serviceId}`, `活动${serviceId}ID`, 30, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/.test(id)) throw catalogError(`活动${id}ID格式不正确`);
  const kind = text(activity.kind || "draw", `活动${id}类型`, 20);
  if (!["draw", "lottery", "wheel"].includes(kind)) throw catalogError(`活动${id}类型不正确`);
  const per = text(activity.per || "day", `活动${id}参与频率`, 20);
  if (!["day", "once", "free"].includes(per)) throw catalogError(`活动${id}参与频率不正确`);
  const need = per === "free" ? 0 : Number(activity.need == null ? 0 : activity.need);
  if (!Number.isInteger(need) || need < 0 || need > 10) throw catalogError(`活动${id}打卡次数必须是0–10的整数`);
  const start = text(activity.start, `活动${id}开始日期`, 10), end = text(activity.end, `活动${id}结束日期`, 10);
  if ((start && !DATE_RE.test(start)) || (end && !DATE_RE.test(end)) || (start && end && end < start)) throw catalogError(`活动${id}日期不正确`);
  const valid = Number(activity.valid == null ? 30 : activity.valid);
  if (!Number.isInteger(valid) || valid < 1 || valid > 365) throw catalogError(`活动${id}凭证有效天数必须是1–365`);
  const pin = text(activity.pin, `活动${id}确认码`, 6, true);
  if (!/^\d{4,6}$/.test(pin)) throw catalogError(`活动${id}确认码必须是4–6位数字`);
  if (!Array.isArray(activity.items) || activity.items.length < 2 || activity.items.length > 12) throw catalogError(`活动${id}必须包含2–12个奖项`);
  const items = activity.items.map((item, itemIndex) => {
    if (typeof item === "string") item = { t: item };
    if (!plainObject(item)) throw catalogError(`活动${id}第${itemIndex + 1}个奖项格式不正确`);
    const t = text(item.t, `活动${id}奖项名称`, 24, true);
    const w = Number(item.w == null || item.w === "" ? 0 : item.w);
    if (!Number.isFinite(w) || w < 0 || w > 100) throw catalogError(`活动${id}奖项权重必须是0–100`);
    return {
      t, d: text(item.d, `活动${id}奖项说明`, 300), g: text(item.g, `活动${id}奖项等级`, 12),
      q: text(item.q, `活动${id}数量说明`, 60), w, n: bool(item.n, /^谢谢参与/.test(t))
    };
  });
  return {
    id, service_id: serviceId, t: text(activity.t || service.name, `活动${id}名称`, 60, true), kind, per, need,
    start, end, valid, pin, rule: text(activity.rule, `活动${id}规则`, 1000), note: text(activity.note, `活动${id}说明`, 1000), items
  };
}

function normalizeControlFields(catalog, out) {
  for (const key of CARE_CONTROL_FIELDS) {
    if (!own(catalog, key)) continue;
    if (key === "trial") out[key] = bool(catalog[key]);
    else if (key === "tenant_id") out[key] = text(catalog[key], key, 128, true);
    else if (key === "up" || key === "ai") out[key] = safeUrl(catalog[key], key);
    else if (key === "tk") {
      out[key] = text(catalog[key], key, 64);
      if (out[key] && !/^[a-f0-9]{64}$/.test(out[key])) throw catalogError("tk格式不正确");
    } else out[key] = text(catalog[key], key, key === "tier" ? 20 : 80);
  }
}

export function validateCareCatalog(catalog) {
  if (!plainObject(catalog)) throw catalogError("目录为空");
  let catalog_version;
  try { catalog_version = careCatalogVersion(catalog.catalog_version); }
  catch { throw catalogError("catalog_version缺失或格式不正确"); }
  if (!plainObject(catalog.options) || !plainObject(catalog.services) || !Object.keys(catalog.services).length) throw catalogError("options/services为空");
  if (Object.keys(catalog.services).length > 100 || Object.keys(catalog.options).length > 500) throw catalogError("服务最多100项、匹配选项最多500项");
  const out = {
    catalog_version,
    n: text(catalog.n == null ? catalog.hospital_name : catalog.n, "医院名称", 80),
    w: text(catalog.w == null ? catalog.welcome : catalog.w, "欢迎语", 500),
    c: text(catalog.c == null ? catalog.theme : catalog.c, "主题色", 7) || "#2563eb",
    l: imageRef(catalog.l == null ? catalog.logo : catalog.l, "院徽"),
    splash: text(catalog.splash, "启动页一句话", 100),
    dept: stringList(catalog.dept, "开放科室", 50, 40),
    tel: { n: "服务电话", num: "" }, book: { n: "医院预约入口", url: "" },
    vip: publicItems(catalog.vip, "VIP权益"), ann: publicItems(catalog.ann, "通知与科普", true),
    pre: publicItems(catalog.pre, "检查前准备"),
    campus: [], sched: [], dis: stringList(catalog.dis, "病种档案开放范围", 50, 40), rg: {},
    showRef: bool(catalog.showRef), hideRef: bool(catalog.hideRef, true),
    options: {}, services: {}, act: []
  };
  if (!/^#[0-9a-fA-F]{6}$/.test(out.c)) throw catalogError("主题色格式不正确");
  if (catalog.tel != null) {
    if (!plainObject(catalog.tel)) throw catalogError("联系电话格式不正确");
    out.tel = { n: text(catalog.tel.n || "服务电话", "电话名称", 40), num: text(catalog.tel.num, "联系电话", 30) };
  }
  if (catalog.book != null) {
    if (!plainObject(catalog.book)) throw catalogError("预约入口格式不正确");
    out.book = { n: text(catalog.book.n || "医院预约入口", "预约入口名称", 60), url: safeUrl(catalog.book.url, "预约入口") };
  }
  if (catalog.campus != null) {
    if (!Array.isArray(catalog.campus) || catalog.campus.length > 20) throw catalogError("院区最多20个");
    out.campus = catalog.campus.map((item, index) => {
      if (!plainObject(item)) throw catalogError(`第${index + 1}个院区格式不正确`);
      return { n: text(item.n, "院区名称", 60, true), addr: text(item.addr, "院区地址", 200), tel: text(item.tel, "院区电话", 30) };
    });
  }
  if (catalog.sched != null) {
    if (!Array.isArray(catalog.sched) || catalog.sched.length > 100) throw catalogError("排班最多100条");
    out.sched = catalog.sched.map((item, index) => {
      if (!plainObject(item)) throw catalogError(`第${index + 1}条排班格式不正确`);
      const row = {
        wd: text(item.wd, "排班星期", 8, true), ap: text(item.ap, "排班时段", 12), dp: text(item.dp, "排班科室", 60),
        dr: text(item.dr, "排班医生", 60), nt: text(item.nt, "排班备注", 100), st: text(item.st, "开始时间", 5), et: text(item.et, "结束时间", 5)
      };
      if ((row.st && !/^\d{2}:\d{2}$/.test(row.st)) || (row.et && !/^\d{2}:\d{2}$/.test(row.et))) throw catalogError("排班时间格式不正确");
      return row;
    });
  }
  if (catalog.rg != null) {
    if (!plainObject(catalog.rg) || Object.keys(catalog.rg).length > 100) throw catalogError("医院参考范围最多100项");
    for (const [key, range] of Object.entries(catalog.rg)) {
      const name = text(key, "参考范围名称", 40, true);
      if (!Array.isArray(range) || range.length !== 2) throw catalogError(`参考范围${name}必须包含上下限`);
      out.rg[name] = range.map((value) => {
        if (value === "" || value == null) return "";
        const number = Number(value);
        if (!Number.isFinite(number)) throw catalogError(`参考范围${name}不是数字`);
        return number;
      });
    }
  }
  for (const [id, service] of Object.entries(catalog.services)) {
    if (!ID_RE.test(id)) throw catalogError("service_id格式不正确");
    out.services[id] = normalizeService(service, id);
  }
  for (const [id, serviceId] of Object.entries(catalog.options)) {
    if (!ID_RE.test(id) || typeof serviceId !== "string" || !ID_RE.test(serviceId)) throw catalogError("option映射格式不正确");
    if (!out.services[serviceId]) throw catalogError(`选项${id}指向了不存在的服务`);
    out.options[id] = serviceId;
  }
  if (catalog.act != null) {
    if (!Array.isArray(catalog.act) || catalog.act.length > 20) throw catalogError("惠民互动最多20个");
    const ids = new Set();
    out.act = catalog.act.map((activity, index) => {
      const normalized = normalizeActivity(activity, index, out.services);
      if (ids.has(normalized.id)) throw catalogError(`活动${normalized.id}ID重复`);
      ids.add(normalized.id);
      return normalized;
    });
  }
  normalizeControlFields(catalog, out);
  return out;
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

// 旧版 gen/show/jny/act 模板 → 新版 catalog 草稿。只做结构转换，不伪造医疗内容。
// 返回 { draft, blockers, warnings, unmapped }；blockers 非空时不得直接发布。
export function migrateLegacyCatalog(legacy) {
  if (!plainObject(legacy)) throw new CareHttpError(422, "旧模板必须是 JSON 对象", "INVALID_LEGACY_CATALOG");
  const blockers = [], warnings = [], unmapped = [];
  const src = plainObject(legacy.gen) ? legacy.gen : legacy;
  const list = Array.isArray(src.show) ? src.show : Array.isArray(src.jny) ? src.jny : [];
  if (!list.length) throw new CareHttpError(422, "没有找到旧的 show/jny 服务列表", "LEGACY_SERVICES_MISSING");
  const benefitIds = new Set((Array.isArray(src.act) ? src.act : []).map((a) => a && a.service_id).filter(Boolean));
  const draftServices = {}, draftOptions = {};
  const asText = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
  const logoRef = (v, label) => {
    const raw = asText(v, 300);
    if (!raw) return "";
    if (/^data:/i.test(raw)) { blockers.push(label + "是内嵌图片（data URI），请在院方工作台重新上传后再发布"); return ""; }
    if (careAssetId(raw) || STATIC_IMAGE_RE.test(raw) || /^https:\/\/[^\s"'<>]+$/.test(raw)) return raw;
    blockers.push(label + "不是可发布的图片地址，请重新上传");
    return "";
  };
  list.forEach((item, index) => {
    if (!plainObject(item)) { blockers.push(`第${index + 1}项服务格式不正确`); return; }
    const serviceId = asText(item.service_id || item.id || ("svc-" + (index + 1)), 128);
    if (!ID_RE.test(serviceId)) { blockers.push(`第${index + 1}项服务 service_id 格式不正确`); return; }
    if (draftServices[serviceId]) { blockers.push(`服务 ${serviceId} 重复`); return; }
    const oldSteps = Array.isArray(item.steps) ? item.steps : [];
    const steps = oldSteps.slice(0, 7).map((step, i) => {
      const raw = plainObject(step) ? step : { t: step };
      const out = { step: i + 1, text: asText(raw.t || raw.text || raw.title, 500) };
      out.materials = Array.isArray(raw.materials) ? raw.materials.map((m) => asText(m, 160)).filter(Boolean).slice(0, 30)
        : (Array.isArray(raw.d) ? [] : asText(raw.materials, 800));
      if (!out.materials.length) out.materials = "";
      out.time = asText(raw.time, 300);
      out.location = asText(raw.location, 300);
      out.official_url = asText(raw.official_url, 300);
      return out;
    });
    if (oldSteps.length > 7) {
      unmapped.push({ service_id: serviceId, extra_steps: oldSteps.slice(7) });
      warnings.push(`服务 ${serviceId} 原有 ${oldSteps.length} 步，多出的 ${oldSteps.length - 7} 步未删除，请在迁移报告里人工合并`);
    }
    while (steps.length < 7) {
      const n = steps.length + 1;
      steps.push({ step: n, text: "", materials: "", time: "", location: "", official_url: "" });
    }
    const draft = {
      service_id: serviceId,
      name: asText(item.name || item.t || item.n, 80),
      department: asText(item.department || (Array.isArray(src.dept) ? src.dept[0] : ""), 80),
      price: asText(item.price, 80),
      clinic_hours: asText(item.clinic_hours, 120),
      materials: Array.isArray(item.materials) ? item.materials.map((m) => asText(m, 160)).filter(Boolean).slice(0, 30) : asText(item.materials, 800),
      booking_channel: asText(item.booking_channel || item.note, 500),
      image_url: logoRef(item.image_url || item.img, `服务 ${serviceId} 配图`),
      service_type: benefitIds.has(serviceId) || item.service_type === "benefit" ? "benefit" : "project",
      description: asText(item.description || item.d, 300),
      tag: asText(item.tag, 40),
      steps
    };
    for (const key of ["name", "department", "price", "clinic_hours", "booking_channel", "image_url"]) {
      if (!draft[key]) blockers.push(`服务 ${serviceId} 缺少 ${key}`);
    }
    for (const step of steps) {
      if (!step.text) blockers.push(`服务 ${serviceId} 第${step.step}步缺少说明`);
    }
    draftServices[serviceId] = draft;
    const optionId = asText(item.option_id || (Array.isArray(item.option_ids) ? item.option_ids[0] : ""), 128) || ("opt-" + serviceId);
    if (!ID_RE.test(optionId)) blockers.push(`服务 ${serviceId} 的 option_id 格式不正确`);
    else draftOptions[optionId] = serviceId;
  });
  const draft = {
    catalog_version: asText(src.catalog_version, 128) || ("migrated-" + Date.now().toString(36)),
    n: asText(src.n || src.hospital_name, 80),
    w: asText(src.w || src.welcome, 500),
    c: /^#[0-9a-fA-F]{6}$/.test(String(src.c || src.theme || "")) ? String(src.c || src.theme) : "#2563eb",
    l: logoRef(src.l || src.logo, "院徽"),
    splash: asText(src.splash, 100),
    dept: Array.isArray(src.dept) ? src.dept.map((d) => asText(d, 40)).filter(Boolean).slice(0, 50) : [],
    tel: plainObject(src.tel) ? { n: asText(src.tel.n, 40) || "服务电话", num: asText(src.tel.num, 30) } : undefined,
    book: plainObject(src.book) ? { n: asText(src.book.n, 60) || "医院预约入口", url: asText(src.book.url, 300) } : undefined,
    vip: Array.isArray(src.vip) ? src.vip : [],
    ann: Array.isArray(src.ann) ? src.ann : [],
    pre: Array.isArray(src.pre) ? src.pre : [],
    campus: Array.isArray(src.campus) ? src.campus : [],
    sched: Array.isArray(src.sched) ? src.sched : [],
    dis: Array.isArray(src.dis) ? src.dis : [],
    rg: plainObject(src.rg) ? src.rg : {},
    showRef: src.showRef === true,
    hideRef: src.hideRef !== false,
    options: draftOptions,
    services: draftServices,
    act: Array.isArray(src.act) ? src.act : []
  };
  if (!draftServices || !Object.keys(draftServices).length) blockers.push("没有可迁移的服务");
  if (!draft.n) blockers.push("缺少医院名称");
  return { draft, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], unmapped };
}
