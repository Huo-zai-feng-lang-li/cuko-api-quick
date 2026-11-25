# OpenAI 兼容层（Codex / dsh 闭环）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 在不破坏 Cuko `/v1/responses` 的前提下，新增 `/openai/v1`，让 Codex（Responses API）和 dsh（Chat Completions / Responses）能接入 Quick，并支持文本、会话续接和模拟工具调用。

**架构：** 新增 `bridge/openai/` 作为协议转换层：纯函数负责请求/工具/提示词，`CukoSink` 把现有 `handleChat` 的 Cuko SSE 捕获成事件，入口层再翻译成 OpenAI Responses 或 Chat Completions 的 JSON/SSE。会话通过 `previous_response_id` 或显式 `X-Session-Id` / `conversation_id` / `metadata.session_id` 映射到 Quick `providerSessionId`，复用现有账号、健康检查、并发锁和 Chrome 生命周期；没有显式句柄时不做消息指纹复用，避免串话。

**技术栈：** Node.js 18+（`package.json` engines 为 `>=18`；本机验证用 22）、内置 `http`/`crypto`、现有 `handleChat` / `ensureConnection` / 账号存储。

**规格：** `docs/cuko-api-v1.md`、OpenAI Responses/Chat Completions 公开协议、Codex `model_providers` 配置。

## 全局约束

- 不改 Cuko `/v1/responses` 的请求/响应语义；新入口只加 `/openai/v1`。
- 默认只转发文本；图片/二进制附件先不伪装成已支持，遇到时用占位文本明确标注“未读取附件内容”。
- 工具调用采用网关内部提示词协议 `<tool_call>{...}</tool_call>`，对客户端翻译成 `function_call` / `custom_tool_call` / `tool_calls`，不把内部格式泄漏给客户端。
- 所有新增模块必须是 ES module，纯函数可单测；网络/Chrome 相关只在入口层。
- 并发仍按模型串行：同一模型同时只允许一轮；OpenAI 入口复用同一把锁。
- 不提交、不推送；实现完成后只报告工作区状态和验证结果。

## 审查重点

- Quick 输出没有按 `<tool_call>` 格式返回时，不能把半截标记流给客户端；必须回退成普通文本。
- `previous_response_id` 失效或网关重启后，不能把任何内容发进错误会话；统一返回 `previous_response_id_not_found`，不静默新建线程。
- 工具名不在客户端 `tools` 列表里时，不能执行/回传；忽略并保留文本，避免客户端收到未知调用。
- 客户端断开时必须释放模型锁；页面生成停止是当前已知缺口（Quick 侧没有可用的 stop 动作），不能在文档里伪装成已停止。
- 空输出、只有工具调用、只有思考、超时四种收尾都必须有明确的 OpenAI 结束状态，不能挂起。

---

### 任务 1：协议纯函数

**文件：**
- 创建：`bridge/openai/protocol.js`
- 测试：`test/openai.test.mjs`

- [x] 实现 `buildToolInstruction(tools, toolChoice)`、`parseToolCalls(text, tools)`、`formatResponsesPrompt(body, { continuation })`、`formatChatPrompt(body, { continuation })`。
- [x] 测试覆盖：function/custom 工具、未知工具、无工具、Responses 首次/续接、Chat 首次/续接、空输入。
- [x] 运行 `npm test`，确认新增测试先失败再通过。

### 任务 2：会话与 Cuko SSE 捕获

**文件：**
- 创建：`bridge/openai/session-store.js`、`bridge/openai/cuko-sink.js`
- 测试：`test/openai.test.mjs`

- [x] `session-store` 提供 TTL/LRU 的 `get/set`，响应 ID 与 Chat 会话键生成。
- [x] `CukoSink` 实现 `writeHead/flushHeaders/write/end/destroy/on`，解析 `event: message`、`event: done`、`event: error`，发出 `text/think/session/done/error/close` 事件。
- [x] 测试覆盖：分片写入、多行 data、done/error、client close。

### 任务 3：OpenAI 输出

**文件：**
- 创建：`bridge/openai/writers.js`
- 测试：`test/openai.test.mjs`

- [x] `writeResponsesJson` / `writeChatJson` 生成非流式对象。
- [x] `streamResponses` 生成 `response.created`、`output_item.added`、`output_text.delta/done`、`function_call_arguments.delta/done`、`custom_tool_call_input.delta/done`、`response.completed`。
- [x] `streamChat` 生成 `chat.completion.chunk`、tool_calls delta、finish_reason、`[DONE]`。
- [x] 测试覆盖：纯文本、单 function call、单 custom call、文本+工具、usage。

### 任务 4：入口与路由

**文件：**
- 创建：`bridge/openai/handler.js`
- 修改：`bridge/index.js`
- 测试：`test/openai.test.mjs`

- [x] `handler` 处理 `GET /openai/v1/models`、`POST /openai/v1/responses`、`POST /openai/v1/chat/completions`、`OPTIONS`。
- [x] 复用账号查找、健康闸门、`activeModels`/`activeResponses`、`ensureConnection`、`handleChat`。
- [x] 请求体大小限制、错误 JSON、客户端断开清理。
- [x] `index.js` 在 Cuko 路由前分派 `/openai/v1`。
- [x] 集成测试：假 deps + 假 `handleChat` 写 Cuko SSE，验证 Responses/Chat 的流式与非流式输出。

### 任务 5：文档与验证

**文件：**
- 修改：`README.md`
- 创建：`docs/openai-compat.md`

- [x] 写 Codex `config.toml` 与 dsh `settings.yaml` 示例。
- [x] 明确能力/限制：文本可用；工具为模拟协议；图片/二进制附件暂不支持；网页 AI 延迟与重试。
- [x] 运行 `npm test`、`node --check` 全部新增/修改 JS、HTTP 冒烟（`/openai/v1/models`、非法请求、并发锁）。
- [x] 记录验证结果到计划文件。

## 验证结果（2026-11-23）

- `npm test`：77 通过 / 0 失败（含既有 Cuko 协议测试 + 新增 OpenAI 层测试）。
- `node --check`：`protocol.js`、`session-store.js`、`cuko-sink.js`、`writers.js`、`handler.js`、`bridge/index.js` 全部通过。
- 真机 HTTP 冒烟（临时端口 39300，`autoOpenAdmin=false`）：`GET /openai/v1/models` 200；老 `/v1/models` 200；非法模型 `POST /openai/v1/responses` 404 `model_not_found`；`OPTIONS` 204；测试后已停止进程并删除临时 `data/config.json`。
- 未做真实 Codex / dsh 客户端测试：本机未安装这两个 CLI，留给用户用真实接口验证。
- 尚未 commit / push，全部改动仍在工作区。
