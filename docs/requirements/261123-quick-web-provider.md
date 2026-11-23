---
id: 261123-quick-web-provider
type: feature
title: Amazon Quick 网页版接入 Cuko API
status: doing
branch: feat/261123-quick-web-provider
created: 2026-11-23
updated: 2026-11-23
---

## 背景

已有 `one-chrome-ex`（DeepSeek）和 `cuko-api-gpt`（ChatGPT）两个 Cuko Provider，
都通过 CDP 控制独立 Chrome 驱动网页版聊天。现在需要把 **Amazon Quick 网页版**
（`https://quick.aws.com/sn/account/<awsAccountId>/start/chat`）也接进来。

与两个姊妹项目最大的不同：**Quick 网页端聊天走 WebSocket，不是 HTTP SSE**。
Cuko 的 `POST /v1/responses` 却是 SSE 契约，中间需要一个桥。

## 目标

1. `GET /v1/models`、`POST /v1/responses` 按 `docs/cuko-api-v1.md` 工作。
2. 新建对话、会话续接、历史压缩三种请求都能跑通。
3. 多账号（独立 Chrome profile + 独立调试端口）。
4. 管理台能加账号、看健康、配参数。

## 方案

### 传输选型

不自己从 Node 连 `wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream`，理由：

- URL 里的 `token` 是 1 小时轮换的 id_token，`ws_host` 按租户不同；
- 还有 `surfaceType`/`outpostId`/`workingSessionId`/`channel` 等握手字段；
- 页面本来就维护着一条可用连接，凭据刷新、重连都由它负责。

改为：**驱动页面 UI 发送 + 经 CDP 观测下行帧**。
发送时点页面自己的发送按钮，页面自己发上行帧；我们只在
`Network.webSocketFrameReceived` 上做解析。

### 协议解析

下行帧是 **AWS event-stream**（12B prelude + headers + payload + 4B CRC），
payload 是 **CBOR**（`application/cbor`）的 `{payload: <bytes>}`，里面才是 inner JSON。

`bridge/quick-protocol.js` 实现：

- `esDrain()`：字节流拆帧，支持半包/粘包；
- `cborDecode()`：手写 CBOR 子集解码（map/text/bytes/array/整数）；
- `decodeOuterPayload()`：同时兼容 CBOR 与桌面端的 JSON+base64；
- `QuickTurnExtractor`：把事件流归并成 `{text, think, usage, finished, error, threadId}`。

### 发送

页面输入框是原生 `<textarea>`（React 受控）。直接改 `value` 不更新状态，
发送按钮一直是 `disabled`。必须：

```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setter.call(el, text);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

发送优先点 `button[aria-label="发送消息"]`，回车作兜底。
判定「已发出」：输入框清空，或页面出现停止按钮。

### 会话续接

Quick 的 `thread_id` 就是会话句柄。第一轮从下行事件
（`message_start.thread_id` / `title_generated.payload.conversation_id`）里拿，
作为 `providerSessionId` 回给客户端；客户端下次带上它就续接。

## 验收标准

- [x] `GET /v1/models` 返回账号列表
- [x] `POST /v1/responses` 新建对话，SSE 流式返回正文
- [x] 首帧带 `providerSessionId`
- [x] 续接对话保持上下文（实测：问「刚才让你记的数字」答对）
- [x] `type: "compress"` 返回新 session
- [x] 并发锁（同模型第二轮 429）
- [x] 客户端断开后清理并释放锁
- [x] 账号健康检查
- [x] 协议层单测 9/9（真实抓包样本）
- [x] 管理台可加账号 / 看状态 / 配参数
- [ ] 文件/图片输入
- [ ] 账号组转移对话

## 修订记录

### 261123-continue-fix：续接没有真正切换会话

**问题**：客户端传了 `providerSessionId`，消息仍发到页面当前停留的会话里。
实测「建 A（记 111）→ 建 B（记 222）→ 续接 A 问数字」，Quick 答 **222**。

**根因**：`chat.js` 只在 `isNewChat` 时动页面，续接分支没有任何导航逻辑，
全仓库搜不到 `conversationId` 的使用。

**修法**：
- `page.js` 新增 `parseQuickUrl` / `buildConversationUrl` / `isOnConversation`
- `quick-sender.js` 新增 `gotoConversation`：解析账号 ID → 导航 → 等 URL 切换 → 等输入区
- `waitForComposer` 改为 250ms 细轮询并容忍导航过渡期的 evaluate 异常
  （导航后 1~2 秒内会给页面上下文重建，旧实现会在这段耗掉预算后误判失败）
- 续接时若收到别的 thread 的事件，从「静默丢弃」改为「明确报错」，
  避免表现成无输出的超时

**验收**：A→B→A 来回切换，分别答出 111 / 222 / 111；新增 7 项 URL 单测。

### 261123-entry-fix：入口页用错，永远进不了聊天页

**问题**：`targetUrl` 默认值 `https://quick.aws.com/sn` 是**产品落地页**
（Features / Pricing / Sign in），实测等 18 秒也只有 7441 字符的介绍内容、
`textarea` 恒为 0，服务必然报「输入区未就绪」。

**根因**：真正的聊天页是 `/sn/account/<账号ID>/start/chat`，
而账号 ID 我们并不知道，旧代码的兜底又直接导航到落地页。

**修法**：
- `targetUrl` 默认值改为 `https://quick.aws.com/sn/start` —— 实测会自动
  路由到带账号 ID 的聊天页（约 10s 出输入框）
- 新增 `detectAccountId()`：按「当前 URL → cookie `qs-directory-alias` →
  cookie `aws-directoryUserInfo` → localStorage ARN」四级探测账号 ID
- `startNewChat()` 改为三段式：点「新对话」按钮 → 有账号 ID 就直达聊天页
  → 都没有则退回 `/sn/start`
- `chrome.js` 与 `buildChatUrl()` 的兜底全部从 `/sn` 改成 `/sn/start`

**验收**：单测覆盖 `buildChatUrl` 三种入参 + 默认值 + 路由后解析，共 20 项全过；
已确认代码中不再有裸 `/sn` 字面量。

## 遗留

- **文件/图片输入**：Quick 的附件走独立的 `upload-attachment` → DLP 扫描 → `files/upload` 流程，
  需要额外的 REST 调用，当前版本只做文本。
- **账号组转移对话**：可从 `one-chrome-ex` 移植，但 Quick 的历史在服务端按 thread 存，
  转移语义要重新设计。
- **打包 exe**：可参考 `one-chrome-ex` 的 Node SEA 方案。
- **`webSocketCreated` 不可依赖**：页面在 CDP 连上之前就建好连接，该事件不再触发。
  当前实现靠帧内容过滤，若将来需要「主动注入帧」得换方案。
