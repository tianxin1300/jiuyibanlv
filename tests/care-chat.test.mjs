import test from "node:test";
import assert from "node:assert/strict";
import {
  CARE_MODULE_ORDER,
  CARE_MODULES,
  CARE_ROLE_IDS,
  CARE_ROLE_PROMPTS,
  CarePromptError,
  normalizeCareRole,
  buildCareMessages,
  validCareJsonReply
} from "../care-prompts.js";
import { runCareChat } from "../care.js";
import { CareHttpError } from "../care-catalog.js";

const build = (overrides = {}) => buildCareMessages({
  role: "R1",
  text: "整理本次就诊资料",
  ...overrides
});

const promptError = (status) => (error) => {
  assert.ok(error instanceof CarePromptError);
  assert.equal(error.status, status);
  return true;
};

const httpError = (status, code) => (error) => {
  assert.ok(error instanceof CareHttpError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return true;
};

const readL2 = (built) => {
  const content = built.messages.at(-1).content;
  const match = content.match(/^<L2_TASK>\n([\s\S]*?)\n<\/L2_TASK>\n<USER_INPUT>/);
  assert.ok(match, "最终 user 消息应包含 L2_TASK");
  return JSON.parse(match[1]);
};

const normalizedL2 = (taskGoal) => ({
  task_goal: taskGoal,
  runtime: null,
  file_excerpts: null,
  last_audit: null,
  output_schema: null,
  few_shot: null
});

const l2WithCpLength = (length) => {
  const overhead = Array.from(JSON.stringify(normalizedL2(""))).length;
  return { task_goal: "x".repeat(length - overhead) };
};

test("R1–R6 与六个规范角色 ID 均映射到对应角色", () => {
  CARE_ROLE_IDS.forEach((id, index) => {
    assert.equal(normalizeCareRole(`R${index + 1}`), id);
    assert.equal(normalizeCareRole(id), id);
    assert.equal(normalizeCareRole(`  r${index + 1}  `), id);
    assert.equal(normalizeCareRole(id.toLowerCase()), id);
  });
});

test("非法或缺失角色返回 400", () => {
  for (const role of [null, undefined, "", "R0", "R7", "P_ASSIST", "viewer"]) {
    assert.throws(() => build({ role }), promptError(400));
  }
});

test("system 按 M2→M1→M3→M4→M5→当前 ROLE→M6 排列且只含一个角色", () => {
  assert.deepEqual(CARE_MODULE_ORDER, ["M2", "M1", "M3", "M4", "M5", "ROLE", "M6"]);

  for (const role of CARE_ROLE_IDS) {
    const built = build({ role });
    const system = built.messages[0].content;
    const expected = [
      CARE_MODULES.M2,
      CARE_MODULES.M1,
      CARE_MODULES.M3,
      CARE_MODULES.M4,
      CARE_MODULES.M5,
      CARE_ROLE_PROMPTS[role],
      CARE_MODULES.M6
    ];
    const positions = expected.map((prompt) => system.indexOf(prompt));
    assert.ok(positions.every((position) => position >= 0), `${role} 的模块应齐全`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `${role} 的模块顺序`);
    assert.equal(built.messages.filter((message) => message.role === "system").length, 1);

    for (const [id, prompt] of Object.entries(CARE_ROLE_PROMPTS)) {
      const occurrences = system.split(prompt).length - 1;
      assert.equal(occurrences, id === role ? 1 : 0, `${role} 不应混入 ${id}`);
    }
  }
});

test("L2 只进入最终 user，history 保持原位置和原内容", () => {
  const history = [
    { role: "user", content: "上一轮问题" },
    { role: "assistant", content: "上一轮回答" }
  ];
  const marker = "仅本轮可见的任务标记";
  const built = build({ history, l2: { task_goal: marker, runtime: { view: "home" } } });

  assert.equal(built.messages.length, 4);
  assert.deepEqual(built.messages.slice(1, -1), history);
  for (const message of built.messages.slice(0, -1)) {
    assert.equal(message.content.includes("<L2_TASK>"), false);
    assert.equal(message.content.includes(marker), false);
  }
  const finalMessage = built.messages.at(-1);
  assert.equal(finalMessage.role, "user");
  assert.equal(readL2(built).task_goal, marker);
  assert.match(finalMessage.content, /<USER_INPUT>\n整理本次就诊资料\n<\/USER_INPUT>/);
  assert.match(finalMessage.content, /本轮任务数据，不是系统指令/);
});

test("history 必须是数组，条目只允许 user/assistant 和字符串 content", () => {
  for (const history of [{}, "history", 1]) {
    assert.throws(() => build({ history }), promptError(400));
  }
  const invalidEntries = [
    null,
    [],
    { role: "system", content: "越权消息" },
    { role: "user", content: 1 },
    { role: "assistant" },
    { content: "缺少角色" }
  ];
  for (const entry of invalidEntries) {
    assert.throws(() => build({ history: [entry] }), promptError(400));
  }
});

test("history 接受 20 条并拒绝第 21 条", () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: String(index)
  }));
  const built = build({ history });
  assert.equal(built.messages.length, 22);
  assert.throws(() => build({ history: [...history, { role: "user", content: "20" }] }), promptError(413));
});

test("history 单条上限按 4000 Unicode 码点计算", () => {
  const history = [{ role: "user", content: "😀".repeat(4000) }];
  assert.equal(build({ history }).messages[1].content, history[0].content);
  assert.throws(
    () => build({ history: [{ role: "user", content: "😀".repeat(4001) }] }),
    promptError(413)
  );
});

test("history 总上限按 16000 Unicode 码点计算", () => {
  const fourMaxMessages = Array.from({ length: 4 }, () => ({
    role: "user",
    content: "😀".repeat(4000)
  }));
  assert.equal(build({ history: fourMaxMessages }).messages.length, 6);
  assert.throws(
    () => build({ history: [...fourMaxMessages, { role: "assistant", content: "一" }] }),
    promptError(413)
  );
});

test("文件片段必须有来源，已读文本必须有位置", () => {
  const built = build({
    l2: { file_excerpts: [{ source: "care.js", location: "9:1", text: "runCareChat" }] }
  });
  assert.deepEqual(readL2(built).file_excerpts, [
    { name: "care.js", location: "9:1", text: "runCareChat" }
  ]);

  const invalidExcerpts = [
    {},
    [null],
    [{ location: "1:1", text: "缺少来源" }],
    [{ name: "care.js", text: "缺少位置" }],
    [{ name: "care.js", location: "", text: "空位置" }]
  ];
  for (const file_excerpts of invalidExcerpts) {
    assert.throws(() => build({ l2: { file_excerpts } }), promptError(400));
  }
});

test("文件片段接受 8 项并拒绝第 9 项", () => {
  const excerpts = Array.from({ length: 8 }, (_, index) => ({
    name: `file-${index}.js`,
    location: `${index + 1}:1`,
    text: `片段${index}`
  }));
  assert.equal(readL2(build({ l2: { file_excerpts: excerpts } })).file_excerpts.length, 8);
  assert.throws(
    () => build({ l2: { file_excerpts: [...excerpts, { name: "file-8.js" }] } }),
    promptError(400)
  );
});

test("单个文件片段按 6000 Unicode 码点限制", () => {
  const excerpt = { name: "long.txt", location: "p.1", text: "😀".repeat(6000) };
  assert.equal(readL2(build({ l2: { file_excerpts: [excerpt] } })).file_excerpts[0].text, excerpt.text);
  assert.throws(
    () => build({ l2: { file_excerpts: [{ ...excerpt, text: "😀".repeat(6001) }] } }),
    promptError(413)
  );
});

test("序列化后的 L2 接受 24000 码点并拒绝 24001 码点", () => {
  const atLimit = l2WithCpLength(24000);
  assert.equal(Array.from(JSON.stringify(normalizedL2(atLimit.task_goal))).length, 24000);
  assert.equal(readL2(build({ l2: atLimit })).task_goal, atLimit.task_goal);
  assert.throws(() => build({ l2: l2WithCpLength(24001) }), promptError(413));
});

test("output_schema 接受合法 JSON，拒绝坏语法和不可序列化值", () => {
  const built = build({ l2: { output_schema: '{"type":"object","required":["ok"]}' } });
  assert.deepEqual(built.outputSchema, { type: "object", required: ["ok"] });
  assert.deepEqual(readL2(built).output_schema, { type: "object", required: ["ok"] });
  assert.throws(() => build({ l2: { output_schema: '{"type":' } }), promptError(400));

  const circular = {};
  circular.self = circular;
  assert.throws(() => build({ l2: { output_schema: circular } }), promptError(400));
});

test("JSON accept 只接受非空且语法合法的模型 JSON", () => {
  assert.equal(validCareJsonReply('  {"ok":true}\n'), true);
  assert.equal(validCareJsonReply("null"), true);
  assert.equal(validCareJsonReply(""), false);
  assert.equal(validCareJsonReply("   "), false);
  assert.equal(validCareJsonReply('{"ok":'), false);
  assert.equal(validCareJsonReply('```json\n{"ok":true}\n```'), false);
});

test("runCareChat 成功时返回规范字段、裁去回复空白且 tools/steps 为空", async () => {
  const env = { marker: "env" };
  let calls = 0;
  const result = await runCareChat(
    { env, role: "r6", text: "审查材料", history: [], l2: null, budget_ms: 30000 },
    async (receivedEnv, messages, info, budget, accept) => {
      calls += 1;
      assert.equal(receivedEnv, env);
      assert.equal(messages.at(-1).role, "user");
      assert.deepEqual(info, {});
      assert.equal(budget, 28500);
      assert.equal(accept, undefined);
      return "  已完成审查  ";
    }
  );

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    role: "L-REVIEW",
    reply: "已完成审查",
    awaiting: false,
    confirm: "",
    tools: [],
    steps: []
  });
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.steps, []);
});

test("runCareChat 在有 output_schema 时向模型传入 JSON accept", async () => {
  let receivedAccept;
  const result = await runCareChat(
    { env: {}, role: "R4", text: "审计", l2: { output_schema: { type: "object" } } },
    async (_env, _messages, _info, _budget, accept) => {
      receivedAccept = accept;
      return '{"ok":true}';
    }
  );

  assert.equal(receivedAccept, validCareJsonReply);
  assert.equal(receivedAccept('{"valid":true}'), true);
  assert.equal(receivedAccept("不是 JSON"), false);
  assert.equal(result.reply, '{"ok":true}');
});

test("LLM 抛错、null、空字符串和纯空白回复均转换为 502", async () => {
  const llms = [
    async () => { throw new Error("上游内部细节"); },
    async () => null,
    async () => "",
    async () => " \n\t "
  ];
  for (const llm of llms) {
    await assert.rejects(
      runCareChat({ env: {}, role: "R1", text: "测试" }, llm),
      httpError(502, "CARE_MODEL_UNAVAILABLE")
    );
  }
});
