import test from "node:test";
import assert from "node:assert/strict";
import { CareTask, prepareCareTask, careActorFromReq, careTaskDo } from "../care.js";
import {
  MemoryStorage, careEnv, actor, multiActor, otherActor,
  taskBody, doJson, advanceInput
} from "./care-test-helpers.mjs";

async function expectCareError(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

async function fixture() {
  const env = careEnv();
  const task = await prepareCareTask(taskBody(), env, actor);
  const storage = new MemoryStorage();
  const object = new CareTask({ storage });
  const created = await doJson(object, "/create", { task });
  assert.equal(created.response.status, 201);
  return { env, task, storage, object, created };
}

const advance = (object, input, key, who = multiActor) => doJson(object, "/advance", { actor: who, input, idempotency_key: key });

test("创建任务要求患者确认、匹配候选与目录版本，并保存七步快照", async () => {
  const env = careEnv();
  await expectCareError(prepareCareTask(taskBody({ confirmed: false }), env, actor), 422, "PATIENT_CONFIRMATION_REQUIRED");
  await expectCareError(prepareCareTask(taskBody({ catalog_version: "old" }), env, actor), 409, "CATALOG_VERSION_CONFLICT");
  await expectCareError(prepareCareTask(taskBody({ service_id: "svcB" }), env, actor), 422, "SERVICE_NOT_MATCHED");

  const { object, task, created } = await fixture();
  assert.equal(task.status, "not_started");
  assert.equal(task.current_step, 1);
  assert.equal(task.completed_steps, 0);
  assert.equal(created.body.task.steps.length, 7);
  assert.equal(created.body.task.step.step, 1);
  assert.equal(created.body.task.owner, undefined);
  assert.equal(created.body.task.service.price, "价格口径待确认");
  assert.equal((await doJson(object, "/create", { task })).response.status, 409);

  const changedEnv = careEnv();
  await changedEnv.KV.put("care:catalog:tenant1", JSON.stringify({ ...JSON.parse(await changedEnv.KV.get("care:catalog:tenant1")), services: {} }));
  const read = await doJson(object, "/read", { actor: multiActor });
  assert.equal(read.response.status, 200);
  assert.deepEqual(read.body.task.steps, task.steps);
  assert.equal(read.body.task.catalog_version, "v1");
});

test("读取与推进校验任务存在和所有权，未绑定存储返回 503", async () => {
  const { object } = await fixture();
  assert.equal((await doJson(object, "/read", { actor: otherActor })).response.status, 403);
  assert.equal((await advance(object, advanceInput(), "other-user-key", otherActor)).response.status, 403);
  const empty = new CareTask({ storage: new MemoryStorage() });
  assert.equal((await doJson(empty, "/read", { actor: multiActor })).response.status, 404);
  assert.equal((await advance(empty, advanceInput(), "missing-task-key")).response.status, 404);
  await expectCareError(careTaskDo({}, "task_missing", "read", {}), 503, "CARE_TASKS_NOT_BOUND");
});

test("七步状态机、第七步精确重放及完成后冲突", async () => {
  const { object } = await fixture();
  let seventh;
  for (let step = 1; step <= 7; step++) {
    const result = await advance(object, advanceInput(step), "step-key-" + step);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.task.completed_steps, step);
    if (step < 7) {
      assert.equal(result.body.task.status, "in_progress");
      assert.equal(result.body.task.current_step, step + 1);
      assert.equal(result.body.task.step.step, step + 1);
    } else {
      seventh = { input: advanceInput(step), result };
      assert.equal(result.body.task.status, "completed");
      assert.equal(result.body.task.current_step, 7);
      assert.equal(result.body.task.step, null);
    }
  }
  const replay = await advance(object, seventh.input, "step-key-7");
  assert.equal(replay.response.status, 200);
  assert.equal(replay.text, seventh.result.text);
  const conflict = await advance(object, advanceInput(99), "after-complete");
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, "TASK_STATE_CONFLICT");
  const reused = await advance(object, advanceInput(7, { completion: "changed" }), "step-key-7");
  assert.equal(reused.response.status, 409);
  assert.equal(reused.body.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal((await advance(object, seventh.input, "step-key-7", otherActor)).response.status, 403);
});

test("同 Key 同指纹跨状态精确重放，不同指纹和不同 Key 被拒绝", async () => {
  const { object } = await fixture();
  const input = advanceInput(1);
  const first = await advance(object, input, "replay-key-1");
  assert.equal(first.response.status, 200);
  const replay = await advance(object, input, "replay-key-1");
  assert.equal(replay.response.status, 200);
  assert.equal(replay.text, first.text);
  const changed = await advance(object, advanceInput(2), "replay-key-1");
  assert.equal(changed.response.status, 409);
  assert.equal(changed.body.code, "IDEMPOTENCY_KEY_REUSED");
  const oldStep = await advance(object, input, "different-key-1");
  assert.equal(oldStep.response.status, 409);
  assert.equal(oldStep.body.code, "TASK_STEP_CONFLICT");
});

test("失败请求不预留幂等 Key，并校验确认、版本、步骤和 Key", async () => {
  const { object } = await fixture();
  const opened = await advance(object, advanceInput(1, { completion: "opened_link" }), "retry-after-error");
  assert.equal(opened.response.status, 422);
  assert.equal(opened.body.code, "PATIENT_CONFIRMATION_REQUIRED");
  assert.equal((await advance(object, advanceInput(1), "retry-after-error")).response.status, 200);

  const { object: second } = await fixture();
  assert.equal((await advance(second, advanceInput(1), "short")).body.code, "INVALID_IDEMPOTENCY_KEY");
  assert.equal((await advance(second, advanceInput(9), "wrong-step-key")).body.code, "TASK_STEP_CONFLICT");
  assert.equal((await advance(second, advanceInput(1, { catalog_version: "v2" }), "version-retry")).body.code, "CATALOG_VERSION_CONFLICT");
  assert.equal((await advance(second, advanceInput(1), "version-retry")).response.status, 200);
});

test("串行事务下不同 Key 并发同一步只有一次成功", async () => {
  const { object } = await fixture();
  const results = await Promise.all([
    advance(object, advanceInput(1), "concurrent-key-a"),
    advance(object, advanceInput(1), "concurrent-key-b")
  ]);
  assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 409]);
  const read = await doJson(object, "/read", { actor: multiActor });
  assert.equal(read.body.task.current_step, 2);
  assert.equal(read.body.task.completed_steps, 1);
});

test("事务写入失败时任务与幂等记录一起回滚", async () => {
  const { object, storage } = await fixture();
  storage.failKey = "idem:rollback-key";
  await assert.rejects(advance(object, advanceInput(1), "rollback-key"), /injected storage failure/);
  assert.equal((await storage.get("task")).current_step, 1);
  assert.equal(await storage.get("idem:rollback-key"), undefined);
  storage.failKey = "";
  assert.equal((await advance(object, advanceInput(1), "rollback-key")).response.status, 200);
});

test("租户鉴权处理无 KV、无效 token、越权与多范围读取", async () => {
  const request = new Request("https://example.test/api/intel/match");
  const url = new URL(request.url);
  await expectCareError(careActorFromReq(request, {}, url, "tenant1", async () => "alice"), 503, "KV_NOT_BOUND");
  await expectCareError(careActorFromReq(request, careEnv(), url, "tenant1", async () => null), 401, "UNAUTHORIZED");
  await expectCareError(careActorFromReq(request, careEnv(), url, "tenant2", async () => "alice"), 403, "CARE_SCOPE_FORBIDDEN");
  const exact = await careActorFromReq(request, careEnv(), url, "tenant1", async () => "alice");
  assert.deepEqual(exact, actor);
  const multiple = await careActorFromReq(request, careEnv(), url, null, async () => "alice");
  assert.deepEqual(multiple, multiActor);
  const duplicate = careEnv();
  duplicate.KV.seed("user:alice", { care_scopes: [actor, actor] });
  await expectCareError(careActorFromReq(request, duplicate, url, "tenant1", async () => "alice"), 403, "CARE_SCOPE_FORBIDDEN");
});
