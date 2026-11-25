# cuko-api-quick 项目说明

> 本文件在初始化项目时随系统提示词发送给 AI。**做任何改动前先读它。**

## 一、这是什么

**cuko-api-quick** 是 **Cuko Provider** 的一个实现：通过原生 CDP 控制独立 Chrome 窗口，
驱动 **Amazon Quick 网页版**（`quick.aws.com/sn/account/<id>/start/chat`）聊天，
对外提供符合 Cuko API 契约的 HTTP/SSE 端点。

姊妹项目：
- `one-chrome-ex` —— DeepSeek 网页版（`C:\d\SourceCode\2026\one-chrome-ex`）
- `cuko-api-gpt` —— ChatGPT 网页版（`C:\d\SourceCode\2027\cuko-api-gpt`）

核心能力：
- 多账号管理（独立 `--user-data-dir` + 独立调试端口）
- 通过 CDP 驱动页面填词 + 点发送按钮，后台静默发消息
- 通过 CDP `Network` 域观测聊天 WebSocket 帧，解析正文与用量
- 会话续接（`providerSessionId` = Quick 的 thread_id）
- 历史压缩（`type: "compress"`）
- 管理页面：`http://127.0.0.1:3000/`

## 二、技术栈

| 项 | 说明 |
|---|---|
| 运行时 | Node.js >= 18 |
| 语言 | 纯 ESM JavaScript（`"type": "module"`） |
| CDP 库 | `chrome-remote-interface` |
| HTTP | Node 原生 `http` 模块 |
| 包管理 | npm |
| 测试 | `node test/run.mjs`（自带运行器，基于真实抓包样本） |

## 三、目录结构

```
bridge/          主程序
  index.js       HTTP 服务 + Cuko 路由 + 管理 API
  quick-protocol.js   协议层（AWS event-stream + CBOR + 事件归并，纯函数）
  quick-transport.js  CDP 帧观测
  page.js        页面选择器（基于实测 DOM）
  quick-sender.js 填词 / 点发送 / 判定已发出
  chat.js        单轮对话主流程
ui/index.html    管理台
docs/
  cuko-api-v1.md          Cuko API 协议契约（冻结）
  quick-protocol.md       Quick 网页版聊天协议实测分析
  requirements/           需求档案
test/            回归测试 + 真实抓包样本
data/            运行时数据（.gitignore）
```

## 四、开工前：先读文档

1. 读 `docs/cuko-api-v1.md` —— Cuko API 契约。
2. 读 `docs/quick-protocol.md` —— Quick 网页版聊天协议（**全是实测结论，别再猜**）。
3. 读 `docs/requirements/INDEX.md` —— 已有需求档案。

## 五、必须知道的坑（都踩过）

| 坑 | 结论 |
|---|---|
| 帧编码 | WebSocket payload 是 **CBOR**（`application/cbor`），不是 JSON。外层是 AWS event-stream。 |
| `webSocketCreated` | **不可依赖**。页面在 CDP 连上之前就建好了连接，该事件不再触发；`webSocketFrameReceived` 照常到达。 |
| 输入框赋值 | React 受控组件，必须用 `HTMLTextAreaElement.prototype` 的原生 value setter + 派发 `input` 事件，否则发送按钮一直 disabled。 |
| 发送方式 | 优先点 `button[aria-label="发送消息"]`，回车作兜底。 |
| 输入框定位 | 原生 textarea，**无 id/class/data-testid**，只有 placeholder「提问或键入 @ 以提醒代理...」。 |
| `total_tokens` | 是整个上下文的累计（含 ~70k prompt cache），不是本轮增量。 |
| 页面路由 | 必须停在 `/start/chat`。停在 `/sn` 落地页时没有输入框。 |

## 六、常见任务

| 任务 | 关键点 |
|---|---|
| 加 API 端点 | 在 `bridge/index.js` 的 `server` 回调里按现有模式添加路由。 |
| 改 UI | 改 `ui/index.html`，刷新即可（无编译）。 |
| 调发送逻辑 | 改 `bridge/quick-sender.js`；选择器在 `bridge/page.js`。 |
| 调协议解析 | 改 `bridge/quick-protocol.js` 的 `QuickTurnExtractor`；改完跑 `npm test`。 |
| 新增抓包样本 | 存成 `test/fixtures/quick-turn-*.json`（数组，元素 `{ts, b64}`）。 |

## 七、验证

```bash
npm start              # 启动主程序
npm test               # 协议层回归测试（不需要登录）
```

**真机验证**（需要已登录的 Chrome）：加账号 → `curl -N` 打 `/v1/responses` 看流式输出。

## 八、关键约定

- **多账号隔离**：每个账号独立 `--user-data-dir` 和调试端口（从 9222 起找第一个 TCP 可绑定的空闲端口，被占用就往后跳）。
- **并发锁**：同一账号同一时间只允许一个请求（`scheduler` 账号级槽位，后续请求进入有界队列）。
- **路径基准**：数据/UI 路径统一从 `bridge/app-paths.js` 取。
- **防后台节流**：启动 Chrome 必须带 `--disable-background-timer-throttling` 等参数。
- **代码注释关联档案**：只在决策点和反直觉处加，格式 `// [id] 一句话 + 为什么。详见 docs/requirements/xxx.md`。

## 九、任务纪律

- **逐项完成**：清单里的每一项都要做，不许跳。
- **做不了就明说**：无法完成的项立即说明原因。
- **边做边验**：每完成一项，立即用 `npm test` 或真机 `curl` 验证。
- **收尾必须交付报告**：做了什么 / 没做什么（及原因） / 验证结果 / 后续建议。
