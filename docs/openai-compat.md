# OpenAI 兼容入口（Codex / dsh）

这个入口让标准 OpenAI 客户端把 `cuko-api-quick` 当成模型服务：

- `GET  /openai/v1/models`
- `POST /openai/v1/responses`（Codex 使用）
- `POST /openai/v1/chat/completions`（dsh / 普通 OpenAI 客户端使用）
- `POST /openai/v1/chat/completions/stop`（按 `model + conversation_id` 停止正在生成的网页回合）

它和 Cuko 原有的 `/v1/models`、`/v1/responses` **互不影响**。老客户端继续走 `/v1`；新客户端走 `/openai/v1`。

## 最小配置

先启动服务，确认模型列表里有账号：

```bash
curl http://127.0.0.1:3000/openai/v1/models
```

列表返回的是**模型别名**。多个账号填同一个别名时会聚合成一个模型池，客户端只看到一个 ID。

### Codex

Codex 当前只支持 Responses API，`wire_api` 必须是 `responses`：

```toml
model = "quick"        # 管理台里的「模型别名」，不是内部账号 ID
model_provider = "cuko"

[model_providers.cuko]
name = "Cuko Gateway"
base_url = "http://127.0.0.1:3000/openai/v1"
env_key = "CUKO_API_KEY"
wire_api = "responses"
```

`CUKO_API_KEY` 可以填任意非空字符串；当前网关没有鉴权，建议只监听 `127.0.0.1`。

### dsh（DeepSeek Harness）

```yaml
agent-default-model:
  provider: openai-compatible
  model: quick

llm-pi-ai:
  providers:
    openai-compatible:
      displayName: Cuko Gateway
      apiKeyEnv: CUKO_API_KEY
      api: openai-responses   # 推荐；也可试 openai-completions
      baseURL: http://127.0.0.1:3000/openai/v1
      models:
        - id: quick
          name: Quick 账号池
          contextWindow: 128000
          maxTokens: 8192
```

dsh 的 `openai-completions` 路由是否透传 `tool_calls` 取决于它的适配器；要工具/MCP 优先用 `openai-responses`。

## 工具调用怎么工作

网页版 Quick 没有原生 `tool_calls`。网关会把客户端请求里的 `tools` 写进 Quick 提示词，要求 Quick 输出：

```xml
<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>
```

然后翻译成客户端要的格式：

- Responses：`function_call` / `custom_tool_call` 输出项；
- Chat Completions：`message.tool_calls`。

客户端执行工具后，把结果放在 `function_call_output` / `role:"tool"` 里回传；网关继续驱动 Quick，直到 Quick 输出普通文本。

注意：这是**模拟工具调用**，不是 Quick 原生 API。Quick 可能不按格式输出，网关会把它当普通文本处理；复杂工具调用需要重试或换更明确的提示词。

MCP 不在网关里执行：网关只负责 `function` / `custom` 工具调用的模拟与翻译；Cuckoo `cuckoo-js` 模式负责在本机执行 `mcpListServers` / `mcpGetTools` / `mcpCall`，网关不会读取 MCP 配置，也不会执行 cuckoo 代码块。

## 会话

- Responses：客户端传 `previous_response_id`，网关把它映射到 Quick 的 `providerSessionId`，下一轮只把工具结果/新消息发回去。
- Chat：优先用 `X-Session-Id`、`conversation_id`、`metadata.session_id`；会话键会带模型前缀，避免同一 ID 在不同模型间串话。没有显式会话键时，入口把完整 `messages` 当新对话发送，不复用 Quick 网页线程。多轮 Chat 客户端建议带 `X-Session-Id` 或 `conversation_id`（`user` 字段不作为会话 ID）。
- 会话映射同时保存 `providerSessionId` 和内部 `accountId`。续接请求会粘在同一账号；该账号被删或不可用时返回错误，不会把上下文发给池里的其它账号。
- 映射默认 24 小时滑动过期，并落盘到 `data/openai-sessions.json`；网关重启后 24 小时内仍能续接同一个 Quick 网页线程。过期或映射文件被删除后才返回 `previous_response_id_not_found`，不会静默新建线程。
- 可用 `CUKO_OPENAI_SESSION_TTL_MS` 调整滑动过期时间；`CUKO_OPENAI_SESSION_FILE` 指定落盘路径，设为空串则只保留内存映射（测试环境用后者隔离真实数据）。映射文件只保存会话 ID 和账号 ID，不保存 API 密钥。

## 能力与限制

| 能力 | 状态 |
|---|---|
| 纯文本对话 | 支持 |
| 流式 SSE | 支持（先发 `response.created` / `response.in_progress` 或 Chat role chunk 和 keepalive；Quick 正文增量到达即逐段下发，工具调用在整轮结束后解析补发） |
| 函数工具 `function` | 支持，模拟协议 |
| 自由文本工具 `custom` | 支持，模拟协议 |
| MCP（Cuckoo 侧） | 网关不执行；由 Cuckoo `cuckoo-js` 在本机调用 `mcpListServers` / `mcpGetTools` / `mcpCall` |
| 图片附件 | 支持最后一条 user 的 `image_url` / `input_image` data URL：落临时文件后走 Quick 附件通道；超过 8 张或单图 data URL 超过 12MB 会跳过 |
| 超长提示词 | 超过 32k 字符时会保留头尾、省略中间；暂未接入 Quick 附件通道 |
| 显式停止 | `POST /openai/v1/chat/completions/stop` 按 `model + conversation_id` 定位活动回合，直接点 Quick「停止生成」再断开流 |
| 客户端断开 | 未发送就断开立即释放槽位；消息已发出后先在页面上点「停止生成」，槽位进入过渡期（`detachedGraceSec`，默认 15s），旧回合收尾即释放，到点仍未结束由调度器强制释放 |
| Cuko 老协议 | 不变，继续用 `/v1` |
| 并发 | 同一账号同时只跑一轮，后续请求进入有界队列；同别名的不同账号并行 |
| 多账号真机验证 | 调度器与入口层已有单测；当前环境只有 `aws` 一个登录态，双真实账号并发尚未真机复测 |
| 浏览器 | Chrome 和 Quick 页签常驻，页签被关掉会自动补开并去重；闲置 Chrome 按阈值回收、常驻数量有 LRU 上限；首次请求或服务重启后会自动拉起 |
| 鉴权 | 无；默认只监听 127.0.0.1 |

## 常见错误

- `404 model_not_found`：`model` 不在账号池的别名列表里。
- `401 authentication_required`：Quick 账号未登录。
- `429 rate_limit_exceeded`：账号额度用完。
- `429 queue_full` / `429 queue_timeout`：该账号池排队已满，或等待超过 `queueMaxWaitSec`。
- `409 account_unavailable`：续接会话所属账号被删除或不可用；需要去掉 `previous_response_id` 重新开始。
- `502 provider_unavailable`：Quick 回合失败/被关闭。
- `504 timeout_error`：超过 `requestTimeoutSec`。

### 流式事件顺序

**Responses（`/openai/v1/responses`）**

1. 回合开始：`response.created` → `response.in_progress`（`output` 为空）；同时启动 keepalive 注释帧（内置 15 秒间隔）。
2. 首段**安全正文**到达时才打开正文项：`response.output_item.added`（`message`，`in_progress`）→ `response.content_part.added` → 多个 `response.output_text.delta`，随 Quick 的 `text_delta` 逐段下发。
3. 整轮结束：`response.output_text.done` → `response.content_part.done` → `response.output_item.done`；随后补发工具调用项（`response.output_item.added` + `function_call_arguments.delta` / `custom_tool_call_input.delta` + `*.done` + `response.output_item.done`）；最后按结果发 `response.completed`（异常为 `response.incomplete` / `response.failed`），响应里带 usage。

**Chat Completions（`/openai/v1/chat/completions`）**

1. 回合开始：role chunk（`delta.role=assistant`）；同时启动 keepalive 注释帧（内置 15 秒间隔）。
2. 正文随 Quick 的增量文本逐段写 `content` chunk。
3. 整轮结束：补发 `tool_calls` chunk → `finish_reason` chunk → 若请求带 `stream_options.include_usage`，再发一个 `choices: []` 的 usage chunk → `data: [DONE]`。

补充语义：

- 工具调用（`function_call` / `custom_tool_call`）仍要等整轮结束、解析出 `<tool_call>` 块后补发，正文不等它。
- 仅当缓冲尾部是工具块起点（完整 `<tool_call>` / ```` ```tool_call ````，或其合法前缀，如 `<tool`）时才暂存不下发；普通 `<`、HTML 标签、比较符号照常增量下发；被证伪的前缀（如 `<toolx`）在下一段到达时即解除暂存并补发。收尾事件里的最终正文以解析后的干净文本为准。
- usage 优先用 Quick 返回的用量；缺失时按文本长度兜底估算。
- Quick 思考阶段可能长时间静默，客户端如果设置了首 token 超时，请把它放到 `requestTimeoutSec + 30` 秒以上。

## 验证

```bash
npm test
```

测试覆盖工具解析、Responses/Chat 输出、SSE 分片、会话续接、账号调度、页签自愈和 HTTP 入口；不依赖 Chrome 登录。
