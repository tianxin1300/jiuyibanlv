import test from "node:test";
import assert from "node:assert/strict";
import { buildXlsx, handleExport, splitParts, zipRead } from "../worker.js";

const codePoints = (value) => Array.from(value).length;

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function exportRequest(markdown, extra = {}) {
  return new Request("https://example.test/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, title: "导出标题", filename: "病历_总结", ...extra }),
  });
}

function cellXml(sheet, ref) {
  const match = sheet.match(new RegExp(`<c r="${ref}"[^>]*>[\\s\\S]*?</c>`));
  assert.ok(match, `缺少单元格 ${ref}`);
  return match[0];
}

function assertNumberCell(sheet, ref, style, value) {
  assert.equal(cellXml(sheet, ref), `<c r="${ref}" s="${style}"><v>${value}</v></c>`);
}

function assertTextCell(sheet, ref, value) {
  assert.equal(
    cellXml(sheet, ref),
    `<c r="${ref}" s="3" t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`,
  );
}

test("buildXlsx 保留金额单位、文本语义并写出完整数字格式", async () => {
  const values = [
    "¥300",
    "￥300",
    "5000元",
    "3万元",
    "8块",
    "$99.5",
    "¥1,234.50",
    "-2,500元",
    "12.5%",
    "-3％",
    "12kg",
    "12345678901",
    "-12345678901",
    "1,234.50",
    "-42.75",
    "600",
  ];
  const markdown = ["| 输入 |", "| --- |", ...values.map((value) => `| ${value} |`)].join("\n");
  const result = buildXlsx(markdown, "金额测试");
  const zip = await zipRead(exactArrayBuffer(result.bytes));
  const sheet = await zip.get("xl/worksheets/sheet1.xml");
  const styles = await zip.get("xl/styles.xml");

  assert.ok(sheet);
  assert.ok(styles);
  assert.equal(result.sheets, 1);

  const numericCases = [
    ["A2", 4, "300"],
    ["A3", 4, "300"],
    ["A4", 5, "5000"],
    ["A5", 6, "3"],
    ["A6", 7, "8"],
    ["A7", 8, "99.5"],
    ["A8", 4, "1234.5"],
    ["A9", 5, "-2500"],
    ["A15", 2, "1234.5"],
    ["A16", 2, "-42.75"],
    ["A17", 2, "600"],
  ];
  for (const [ref, style, value] of numericCases) assertNumberCell(sheet, ref, style, value);
  assert.ok(!cellXml(sheet, "A5").includes("<v>30000</v>"), "3万元不应隐式换算成 30000");

  assertTextCell(sheet, "A10", "12.5%");
  assertTextCell(sheet, "A11", "-3％");
  assertTextCell(sheet, "A12", "12kg");
  assertTextCell(sheet, "A13", "12345678901");
  assertTextCell(sheet, "A14", "-12345678901");

  assert.ok(result.notes.includes("表内存在不同货币或金额单位，求和前请先统一口径"));
  assert.ok(result.notes.some((note) => note.includes("8 个金额单元格已写成数值")));
  assert.ok(result.notes.some((note) => note.includes("带单位或符号的非金额单元格保留原文")));

  const formats = new Map([
    [164, "&quot;¥&quot;#,##0.##############"],
    [165, "#,##0.##############&quot;元&quot;"],
    [166, "#,##0.##############&quot;万元&quot;"],
    [167, "#,##0.##############&quot;块&quot;"],
    [168, "&quot;$&quot;#,##0.##############"],
  ]);
  assert.match(styles, /<numFmts count="5">/);
  for (const [id, formatCode] of formats) {
    assert.ok(
      styles.includes(`<numFmt numFmtId="${id}" formatCode="${formatCode}"/>`),
      `缺少 numFmt ${id}`,
    );
    assert.match(styles, new RegExp(`<xf numFmtId="${id}"[^>]*applyNumberFormat="1"`));
  }
  const cellXfs = styles.match(/<cellXfs count="9">([\s\S]*?)<\/cellXfs>/);
  assert.ok(cellXfs, "cellXfs 应声明 count=9");
  assert.equal(cellXfs[1].match(/<xf\b/g)?.length, 9);
});

test("splitParts 按 Unicode 码点执行 8000 分段与 32768 总量边界", () => {
  const atPartLimit = "😀".repeat(8000);
  assert.deepEqual(splitParts(atPartLimit), { ok: true, total: 8000, parts: [atPartLimit] });

  const overPartLimit = "😀".repeat(8001);
  const split = splitParts(overPartLimit);
  assert.equal(split.ok, true);
  assert.equal(split.total, 8001);
  assert.equal(split.parts.length, 2);
  assert.ok(split.parts.every((part) => codePoints(part) <= 8000));
  assert.equal(split.parts.join(""), overPartLimit);

  const atTotalLimit = "😀".repeat(32768);
  const maximum = splitParts(atTotalLimit);
  assert.equal(maximum.ok, true);
  assert.equal(maximum.total, 32768);
  assert.ok(maximum.parts.every((part) => codePoints(part) <= 8000));
  assert.equal(maximum.parts.join(""), atTotalLimit);

  const tooLarge = splitParts("😀".repeat(32769));
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.total, 32769);
  assert.match(tooLarge.msg, /32769.*32768/);
});

test("handleExport MD 返回对应分段正文、MIME、part/totalParts 与文件名", async () => {
  const markdown = "😀".repeat(8001);
  const expected = splitParts(markdown);
  const response = await handleExport(exportRequest(markdown, { part: 2 }), "md");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("part"), "2");
  assert.equal(response.headers.get("totalParts"), "2");
  assert.equal(response.headers.get("X-Export-Format"), "md");
  assert.equal(await response.text(), expected.parts[1]);

  const filename = encodeURIComponent("病历_总结-第2部分.md");
  assert.equal(response.headers.get("X-Filename"), filename);
  assert.equal(
    response.headers.get("Content-Disposition"),
    `attachment; filename="export.md"; filename*=UTF-8''${filename}`,
  );
});

test("handleExport MD 拒绝越界 part 和超过 32768 码点的内容", async () => {
  const markdown = "😀".repeat(8001);
  for (const part of [0, 3]) {
    const response = await handleExport(exportRequest(markdown, { part }), "md");
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.totalParts, 2);
    assert.match(body.msg, /part 越界：共 2 部分/);
  }

  const response = await handleExport(exportRequest("😀".repeat(32769)), "md");
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.msg, /32769.*32768/);
});

test("handleExport DOCX 返回 ZIP 签名、正确 MIME 与可解包文档", async () => {
  const response = await handleExport(exportRequest("# 标题\n\n正文"), "docx");
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const zip = await zipRead(exactArrayBuffer(bytes));
  assert.ok(zip.names.includes("word/document.xml"));
  const document = await zip.get("word/document.xml");
  assert.match(document, /标题/);
  assert.match(document, /正文/);
});

test("handleExport PPTX 返回 ZIP 签名、正确 MIME 与可解包演示文稿", async () => {
  const response = await handleExport(exportRequest("# 标题\n\n正文"), "pptx");
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const zip = await zipRead(exactArrayBuffer(bytes));
  assert.ok(zip.names.includes("ppt/presentation.xml"));
  assert.ok(zip.names.includes("ppt/slides/slide1.xml"));
});

test("handleExport CSV 保留单元格原文并输出带 BOM 的原始 CSV 文本", async () => {
  const markdown = [
    "| 项目 | 原文 |",
    "| --- | --- |",
    "| 金额 | 3万元 |",
    "| 符号 | <&> |",
    "| 千分位 | 1,234.50 |",
  ].join("\n");
  const response = await handleExport(exportRequest(markdown), "csv");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/csv; charset=utf-8");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    "\uFEFF项目,原文\r\n金额,3万元\r\n符号,<&>\r\n千分位,\"1,234.50\"\r\n",
  );
});

test("handleExport HTML 对标题、正文和代码中的特殊字符进行转义", async () => {
  const markdown = [
    "```html",
    "<script>alert(\"&'\")</script>",
    "```",
    "",
    "5 < 6 & \"quoted\" 'single' > 4",
  ].join("\n");
  const response = await handleExport(exportRequest(markdown, { title: "<标题>&\"'" }), "html");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.ok(html.includes("<title>&lt;标题&gt;&amp;&quot;&#39;</title>"));
  assert.ok(html.includes(
    "<pre><code>&lt;script&gt;alert(&quot;&amp;&#39;&quot;)&lt;/script&gt;</code></pre>",
  ));
  assert.ok(html.includes("<p>5 &lt; 6 &amp; &quot;quoted&quot; &#39;single&#39; &gt; 4</p>"));
  assert.ok(!html.includes("<script>"));
});
