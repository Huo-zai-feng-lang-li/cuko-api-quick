# cuko-api-quick

把 **Amazon Quick 网页版**（[quick.aws.com](https://quick.aws.com)）的聊天能力，通过 CDP 驱动独立 Chrome，
暴露成符合 **Cuko API** 契约的 HTTP/SSE 服务。

> 姊妹项目：[one-chrome-ex](https://github.com/wangtunan90)（DeepSeek 版）、`cuko-api-gpt`（ChatGPT 版）。
> 三者架构一致，差异在"怎么把网页版聊天的响应捞出来"。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [快速开始](#快速开始)
- [在客户端里配置](#在客户端里配置)
- [调用示例](#调用示例)
- [配置方案](#配置方案)
- [端点](#端点)
- [它是怎么工作的](#它是怎么工作的)
- [踩过的坑](#踩过的坑)
- [目录结构](#目录结构)
- [验证](#验证)
- [已知限制](#已知限制)
- [免责声明](#免责声明)

---

## 它解决什么问题

Cuko API 是给 **Stateful Provider** 设计的协议：客户端只发当前这一句提示词，
上下文由 Provider 自己维护（详见 [docs/cuko-api-v1.md](docs/cuko-api-v1.md)）。
而 Quick 网页版是个需要登录、需要点按、用 WebSocket 推流的前端应用，两者对不上。

本项目就是中间那层桥：

```
Cuko 客户端 ──HTTP/SSE──▶ bridge ──CDP──▶ 独立 Chrome ──▶ quick.aws.com
```

它做的事：

- 替你点开页面、填好输入框、点发送
- 在旁边监听聊天 WebSocket，把流式内容翻译成 Cuko 的 SSE 事件
- 把 Quick 的 `thread_id` 当作 `providerSessionId` 回给客户端，实现多轮续接
- 支持多账号（每个账号独立 Chrome profile + 独立调试端口，登录态互不干扰）

---

## 快速开始

### 环境要求

- Node.js >= 18
- Windows（Chrome 启动/剪贴板相关逻辑按 Windows 写；其它平台未验证）
- 一个能正常登录的 Amazon Quick 账号
- 本机已安装 Chrome

### 安装与启动

```bash
npm install
npm start
```

默认监听 `http://127.0.0.1:3000`，可用环境变量改：

```bash
CUKO_HTTP_PORT=3002 npm start
```

### 添加账号并登录

1. 浏览器打开管理台：<http://127.0.0.1:3000/>
2. 填「模型 ID」（英文/数字/下划线/中划线，例如 `quick-main`）和显示名称
3. 点 **添加并启动 Chrome**

会弹出一个独立的 Chrome 窗口（独立 `--user-data-dir` + 独立调试端口，从 9222 递增）。
**在这个窗口里登录 quick.aws.com**，登录完关掉窗口也没关系，登录态存在自己的 profile 目录里。

4. 回到管理台点「检查」，看到 `ok` 就说明输入区可用、可以用了。

> 首次启动 Chrome 后页面加载可能要十几秒，等输入框出来再点「检查」。

---

## 在客户端里配置

在支持 Cuko API 的客户端里打开设置：

| 项 | 值 |
|---|---|
| 中转地址 | `http://127.0.0.1:3000` |
| Token | 留空 |
| 模型 | 选管理台里添加的账号（模型 ID） |

---

## 调用示例

### 列模型

```bash
curl http://127.0.0.1:3000/v1/models
```

```json
{ "data": [{ "id": "quick-main", "name": "Quick 主账号" }] }
```

### 新建对话（流式）

```bash
curl -N http://127.0.0.1:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "quick-main",
    "requestId": "req-1",
    "cuckSessionId": "cuck-1",
    "input": [{ "type": "text", "text": "你好" }]
  }'
```

返回：

```
event: message
data: {"output":[],"providerSessionId":"ce03a5ae-b855-4cd4-9d89-48f20cefe0c0"}

event: message
data: {"output":["你好"]}

event: message
data: {"output":["！有什么"]}

event: done
data: {"finishReason":"stop","usage":{"input_tokens":4,"output_tokens":11,"total_tokens":69929}}
```

### 续接对话（第二轮）

把上一轮拿到的 `providerSessionId` 带上：

```bash
curl -N http://127.0.0.1:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "quick-main",
    "requestId": "req-2",
    "cuckSessionId": "cuck-1",
    "providerSessionId": "ce03a5ae-b855-4cd4-9d89-48f20cefe0c0",
    "input": [{ "type": "text", "text": "我刚才问了什么？" }]
  }'
```

### 历史压缩（切换模型时）

```bash
curl -N http://127.0.0.1:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "quick-main",
    "requestId": "req-3",
    "cuckSessionId": "cuck-1",
    "type": "compress",
    "input": [
      { "type": "text", "text": "# 角色\n你是一个助手。" },
      { "type": "text", "text": "用户:\n我叫小明，喜欢蓝色。" },
      { "type": "text", "text": "助手:\n好的，记住了。" }
    ]
  }'
```

---

## 配置方案

所有行为参数由**配置方案**驱动，管理台「配置方案」卡片可建多套、按账号绑定。

- **默认方案**：硬编码在 `bridge/default-config.js`，只读，不能改也不能删。
- **自定义方案**：新建时从默认方案深拷贝，之后默认方案变了也不影响已建的。
- **回退**：账号没指定方案、或指定被删了，自动回退默认方案。

时间类字段单位统一为**秒**，支持小数。等待类字段是区间，实际使用时在 `[min, max]` 内随机，模拟真人节奏。

常调的几个：

| 字段 | 默认 | 说明 |
|---|---|---|
| `chromePath` | 空 | 空 = 自动探测 Program Files 下的 Chrome |
| `extraArgs` | 空 | 额外 Chrome 启动参数，如 `--proxy-server=...` |
| `targetUrl` | `https://quick.aws.com/sn` | 目标页面 |
| `pageReadyPollMaxSec` | 25 | 等输入框出现的最长秒数 |
| `requestTimeoutSec` | 900 | 单次请求硬超时（真正的卡死由 120s 空闲超时兜） |
| `preEnterWaitMinSec/MaxSec` | 0.8 / 2.5 | 填完词到点发送之间的随机等待 |
| `disableBackgroundThrottling` | 开 | 必须开，否则 Chrome 后台会节流导致点不动 |

---

## 端点

### Cuko API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 模型（账号）列表 |
| POST | `/v1/responses` | 发送消息（SSE 流式） |

### 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 管理台页面 |
| GET | `/api/accounts` | 账号列表（含在线状态、健康、生效方案） |
| POST | `/api/accounts` | 新增账号（自动启动 Chrome） |
| PUT | `/api/accounts/:id` | 改名 / 绑配置方案 |
| DELETE | `/api/accounts/:id` | 删除账号（含独立数据目录，不可恢复） |
| POST | `/api/accounts/:id/open` | 打开 Chrome |
| GET | `/api/accounts/:id/health` | 账号健康检查 |
| GET | `/api/profiles` | 配置方案列表 |
| POST | `/api/profiles` | 新建方案 |
| PUT | `/api/profiles/:id` | 修改方案 |
| DELETE | `/api/profiles/:id` | 删除方案 |

---

## 它是怎么工作的

### 发送：驱动页面，而不是模拟协议

Quick 网页版的输入框是 **React 受控的原生 textarea**。直接改 `value` 不会触发状态更新，
发送按钮会一直是 `disabled`。所以：

```js
// 用原生 setter + 派发 input 事件，React 才会感知
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setter.call(el, text);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

然后等 `button[aria-label="发送消息"]` 从 disabled 变可用，点它（回车作兜底），
再用「输入框清空 / 出现停止按钮」确认真的发出去了。

### 接收：监听页面的 WebSocket

Quick 网页端聊天走 WebSocket（**不是 HTTP SSE**）：

```
wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
  ?surfaceType=...&token=<id_token>&workingSessionId=...&channel=prod
```

我们不让 Node 自己连这条连接 —— URL 里的 `token` 是约 1 小时轮换的 id_token，
`ws_host` 按租户不同，还有`outpostId`/`workingSessionId` 等握手字段。
页面本来就维护着一条可用连接，凭据刷新、重连都由它负责。

所以改为：**经 CDP 的 `Network` 域旁听**，用 `Network.webSocketFrameReceived` 拿下行帧。

### 解码：AWS event-stream + CBOR

下行帧不是裸 JSON，而是两层包装：

```
AWS event-stream 帧
├── 12B prelude（totalLen / headersLen / preludeCRC）
├── headers（:event-type=rawOutputEvent, :content-type=application/cbor）
├── payload  ← 这里是一个 CBOR map
└── 4B messageCRC

CBOR map: { "payload": <bytes> }   ← bytes 里才是 inner JSON
inner JSON: {"type":"text_delta","payload":{"delta":"你好"},"thread_id":"..."}
```

`bridge/quick-protocol.js` 里手写了这套编解码（含 CBOR 子集解码器），
并把事件流归并成 Cuko 需要的 `{text, think, usage, finished, error, threadId}`。

一轮对话的结束判据：`message_complete` 且 `payload.continuation_expected !== true`。
agentic 多步任务会连续发多轮 `message_start … message_complete`，前几轮带 `continuation_expected: true`。

### 会话续接

Quick 的 `thread_id` 就是会话句柄。第一轮从下行事件里拿到（`message_start.thread_id`
或 `title_generated.payload.conversation_id`），作为 `providerSessionId` 回给客户端。

---

## 踩过的坑

这些都是实测撞出来的，写下来避免重蹈覆辙。

| 坑 | 结论 |
|---|---|
| **帧 payload 是 CBOR，不是 JSON** | 一开始按桌面端的 `JSON + base64` 实现，解出来全是 0 条事件。看 header 才发现 `:content-type=application/cbor`。 |
| **`Network.webSocketCreated` 不可依赖** | 页面在 CDP 客户端连上来**之前**就建好了聊天连接，该事件不会再触发；但 `webSocketFrameReceived` 照常到达。所以不能拿它做前置 gate，得按帧内容过滤。 |
| **直接改 textarea.value 无效** | React 受控组件，必须用原生 setter + 派发 `input` 事件，否则发送按钮永远 disabled。 |
| **输入框没有任何标识** | 原生 textarea，无 id / class / data-testid / aria-label，只有 placeholder「提问或键入 @ 以提醒代理...」。选择器只能靠 placeholder 或「最后一个可见 textarea」。 |
| **回车不一定能发送** | 页面可能把 Enter 当换行。优先点 `button[aria-label="发送消息"]`，回车作兜底。 |
| **`turn_usage.total_tokens` 是整个上下文** | 实测 70000+（含约 70k 的 prompt cache），**不是本轮增量**。别拿它算本轮花费。 |
| **必须停在 `/start/chat`** | 停在 `/sn` 落地页时页面上没有输入框。页面被用户导航走了，请求会明确报错。 |
| **Chrome 进程被父进程回收** | 用 `spawn(detached:true)` 或 PowerShell `Start-Process` 启动，否则父进程一退出调试窗口就没了。 |

---

## 目录结构

```
bridge/
  index.js            HTTP 服务、Cuko 路由、管理 API
  app-paths.js        运行目录解析
  default-config.js   默认配置方案、字段校验、区间随机
  store.js            账号/方案/健康检查持久化 + 日志落盘
  chrome.js           Chrome 启动与调试端口探测
  cdp-connection.js   每账号常驻 CDP 连接 + 事件作用域分发
  quick-protocol.js   ★ 协议层：event-stream 拆帧 + CBOR + 事件归并（纯函数，可单测）
  quick-transport.js  经 CDP 观测 / 注入聊天 WebSocket 帧
  page.js             ★ 页面选择器与求值表达式（全部基于实测 DOM）
  quick-sender.js     ★ 填词、点发送、判定已发出
  chat.js             单轮对话主流程
  compress.js         历史压缩请求
  health.js           账号健康检查
  input.js            输入项归一化（兼容各种 input 形态）
  clipboard.js        Windows 剪贴板操作（备用路径）
ui/
  index.html          管理台（单文件，无构建）
docs/
  cuko-api-v1.md      Cuko API 协议契约
  quick-protocol.md   ★ Quick 网页版聊天协议实测分析
  requirements/       需求档案
test/
  run.mjs             测试运行器
  protocol.test.mjs   协议层回归测试
  fixtures/           真实抓包样本（下行 / 上行）
scripts/
  build-docs-index.mjs  需求索引生成器
data/                   运行时数据（.gitignore）
  accounts.json         账号列表
  config-profiles.json  用户配置方案
  profiles/<modelId>/   各账号的 Chrome 用户数据（登录态）
  logs/                 运行日志
```

---

## 验证

```bash
npm test
```

协议层回归测试，**基于真实抓包样本**（`test/fixtures/` 里是线上真实的一轮对话帧），
覆盖：拆帧、CBOR 解码、分片重组（按 7 字节切片）、事件归并、上行帧编码往返。

```
  PASS  拆帧：单条下行消息结构正确
  PASS  CBOR 解码：第一条是 message_start
  PASS  完整一轮：正文 / 用量 / 结束 / threadId
  PASS  分片重组：按 7 字节切片结果一致且无残留
  PASS  上行帧：编码后能被自己解回
  PASS  上行帧：真实抓包样本可解析出 user_message
  PASS  状态机：agentic 多段用空行分隔
  PASS  状态机：错误事件被记录
  PASS  状态机：text_complete 全文兜底

9 通过 / 0 失败
```

真机验证：加账号 → 用上面的 `curl -N` 打 `/v1/responses` 看流式输出。

项目开发时已实测通过：新建对话、会话续接（上下文保持）、历史压缩、
并发锁 429、客户端中途断开清理、账号健康检查、管理台全部交互。

---

## 已知限制

- **单账号单并发**：同一账号同时只允许一轮对话（页面上只有一份输入区），并发请求返回 429。
- **只支持文本输入**：文件/图片未实现。Quick 的附件走独立的 `upload-attachment` → DLP 扫描 → `files/upload` 流程。
- **依赖页面结构**：选择器基于 2026-11-23 的实测 DOM，Quick 大改版可能导致失效。相关逻辑集中在 `bridge/page.js`，改动面很小。
- **仅 Windows 验证**：Chrome 启动和剪贴板部分按 Windows 写，其它平台未测试。
- **无账号组/转移对话**：one-chrome-ex 里的账号组功能未移植。

---

## 免责声明

本项目通过自动化驱动网页界面工作，**与 Amazon / AWS 无任何关联**，非官方实现。

请仅在你拥有或获得明确授权的账号上使用，并遵守相关服务条款。
使用自动化手段访问服务可能违反其条款，账号可能被限制或封禁，请自行评估风险。
