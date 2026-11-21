export class MemoryKV {
  constructor() { this.data = new Map(); }
  seed(key, value) { this.data.set(key, typeof value === "string" ? value : JSON.stringify(value)); }
  async get(key, type) {
    const value = this.data.has(key) ? this.data.get(key) : null;
    if (value == null) return null;
    if (type === "json") return JSON.parse(value);
    return value;
  }
  async put(key, value) { this.data.set(key, String(value)); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
  async getWithMetadata(key, type) { return { value: await this.get(key, type), metadata: null }; }
}

export class MemoryStorage {
  constructor() { this.data = new Map(); this.tail = Promise.resolve(); this.failKey = ""; }
  async get(key) { return this.data.has(key) ? structuredClone(this.data.get(key)) : undefined; }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async transaction(callback) {
    const run = async () => {
      const staged = new Map();
      const txn = {
        get: async (key) => staged.has(key) ? structuredClone(staged.get(key)) : this.get(key),
        put: async (key, value) => {
          if (this.failKey === key) throw new Error("injected storage failure");
          staged.set(key, structuredClone(value));
        }
      };
      const result = await callback(txn);
      for (const [key, value] of staged) this.data.set(key, structuredClone(value));
      return result;
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

export function makeService(serviceId) {
  return {
    service_id: serviceId,
    name: "服务" + serviceId,
    department: "科室待确认",
    price: "价格口径待确认",
    clinic_hours: "门诊时间待确认",
    materials: ["就诊材料待确认"],
    booking_channel: "预约渠道待确认",
    image_url: "https://example.invalid/image.png",
    service_type: "project",
    steps: Array.from({ length: 7 }, (_, index) => ({
      step: index + 1,
      text: "第" + (index + 1) + "步说明待确认",
      materials: [],
      time: "待确认",
      location: "待确认",
      official_url: ""
    }))
  };
}

export function makeCatalog(version = "v1") {
  return {
    catalog_version: version,
    options: { optA: "svcA", optA2: "svcA", optB: "svcB" },
    services: { svcA: makeService("svcA"), svcB: makeService("svcB") }
  };
}

export function careEnv(catalog = makeCatalog()) {
  const KV = new MemoryKV();
  KV.seed("care:catalog:tenant1", catalog);
  KV.seed("user:alice", { care_scopes: [{ tenant_id: "tenant1", profile_id: "profile1" }] });
  KV.seed("user:bob", { care_scopes: [{ tenant_id: "tenant1", profile_id: "profile2" }] });
  KV.seed("token:alice-token", "alice");
  KV.seed("token:bob-token", "bob");
  return { KV };
}

export const actor = { username: "alice", tenant_id: "tenant1", profile_id: "profile1" };
export const multiActor = { username: "alice", care_scopes: [{ tenant_id: "tenant1", profile_id: "profile1" }] };
export const otherActor = { username: "bob", care_scopes: [{ tenant_id: "tenant1", profile_id: "profile2" }] };

export function taskBody(overrides = {}) {
  return {
    tenant_id: "tenant1",
    option_ids: ["optA", "optA2"],
    service_id: "svcA",
    catalog_version: "v1",
    confirmed: true,
    ...overrides
  };
}

export async function doJson(object, path, body) {
  const response = await object.fetch(new Request("https://care-task.internal" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  }));
  const text = await response.text();
  return { response, body: JSON.parse(text), text };
}

export function advanceInput(step = 1, overrides = {}) {
  return { step, catalog_version: "v1", completion: "patient_confirmed", ...overrides };
}
