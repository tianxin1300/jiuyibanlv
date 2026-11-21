# 就医伴侣 · 就医智能端（jiuyibanlv）

就医智能端 = **患者端静态单页（PWA + 配置生成器）** + **就医版 AI 网关后端（Cloudflare Worker）**。

- 患者档案数据默认只存患者本机浏览器（localStorage / IndexedDB），不上云。
- 患者端新增「**智能助手 · 问答**」入口（第 5 个页签），调用后端 `POST /api/chat`，界面明确标注为 **AI 智能端**。
- 后端 `worker.js` 由「聚合体」自用版裁剪而来，**只保留就医场景需要的路由**。

## 目录结构

```
frontend/        静态站点（患者端 + 配置生成器）
  index.html     患者端单页（含启动页、离线缓存、智能助手入口）
  sw.js          离线缓存 SW（必须与 index.html 同目录、版本号与 APP_VER 一致）
  gen.html       配置生成器（交付人员用，网址 /gen.html）
  config/        各医院配置：<医院代号>.json
  img/           医院图片：img/<医院代号>/xxx.jpg
worker.js        就医版后端（Cloudflare Worker，AI 网关 + 分享/翻译/提醒等）
wrangler.toml    后端部署配置模板（未执行任何部署）
templates/       配置录入模板（基础版 / 升级版）
docs/            项目说明与更新日志
dist/            交付 / 构建产物（不纳入版本管理）
```

## 后端（worker.js）保留的路由

- 对话：`POST /api/chat`（智能问答，非流式）、`POST /v1/chat/completions`（SSE 流式）
- 分享：`/api/shares`、短链 `/s/`
- 翻译：`/api/translate`、`/api/translate/baidu`、`/api/translate/youdao`
- 其他：`/api/models`、`/api/tasks/*`（定时任务）、`/api/memory`、`/api/kb*`（我的资料）、`/api/file/*`、`/api/export/*`、`/api/info/*`、`/api/fetch`（网页抓取）、`/api/tts`（语音）、`/api/generate/image`、`/api/map`、`/api/places`、`/api/feedback`、`/api/register`、`/api/login`
- 定时：Cron 只跑「到点提醒 + 定时任务」
- 已移除（与就医无关）：热榜、糖果指数、早报、连接器、招采、调试等

## 智能助手接入

1. 患者端第 5 个页签「智能助手」→ 输入问题 → `POST /api/chat`。
2. 后端返回 `{ ok, reply, awaiting, confirm, tools, steps }`，前端渲染为对话气泡。
3. 网关地址来源：医院配置里的 `ai` 字段（网关根地址，如 `https://xxx.workers.dev`）；
   **不填则调用同源 `/api/chat`**。配置示例：

```json
{ "n": "示例医院", "ai": "https://jiuyibanlv-ai.xxx.workers.dev" }
```

## 本地预览

```bash
cd frontend
python3 -m http.server 8080
# 患者端： http://localhost:8080/index.html?hospital=demo
# 生成器： http://localhost:8080/gen.html
```

后端本地调试（可选）：`wrangler dev`（需先按 `wrangler.toml` 绑定 KV）。

## 约定

- **医院代号**由我方统一分配；患者端按 `?hospital=<代号>` 读取 `config/<代号>.json`。
- 配置流程：生成器导出 → 发布前检查 → 只发布「已检查版」；生成器导出件**不可直接上线**。
- `index.html` 中的 `APP_VER` 与 `sw.js` 中 `companion-sw-` 后的版本号**必须一致**。
- 项目图片放 `frontend/img/<代号>/`，格式 jpg/png/webp，单张建议小于 150KB。
- 智能助手仅用于整理/解释患者自己记录的资料，**不提供诊疗建议、不能替代医生**。

## 部署

- **前端（Cloudflare Pages）**：输出目录设为 `frontend/`，构建命令留空（纯静态）。
- **后端（Cloudflare Worker）**：见 `wrangler.toml`，绑定 KV（命名空间变量名必须为 `KV`）。
- 后端 Worker 已连接：`juyiibanlvzhinengai`（`https://juyiibanlvzhinengai.tianxinyuan881.workers.dev`），
  与仓库 `tianxin1300/jiuyibanlv` 的 `main` 分支关联；前端「智能助手」默认调它，不再走同源 `/api/chat`。
