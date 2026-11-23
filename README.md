# cuko-api-quick

Cuko Provider for Amazon Quick web（Stateful Provider）。

> 通过 CDP 控制独立 Chrome 窗口，驱动 [quick.aws.com](https://quick.aws.com) 网页版聊天，
> 对外暴露 Cuko API 契约。姊妹项目：`one-chrome-ex`（DeepSeek 版）、`cuko-api-gpt`（ChatGPT 版）。

## 状态

**链路已实测打通**（2026-11-23，企业账号 261414899405）。

已验证：

| 场景 | 结果 |
|---|---|
| 新建对话（首轮） | ✅ 正文流式返回，`providerSessionId` 正确下发 |
| 会话续接（第二轮） | ✅ 上下文保持（问「刚才让你记的数字」答对） |
| 历史压缩 `type: "compress"` | ✅ 多段历史合并发送，返回新 session |
| 并发锁 | ✅ 同模型第二轮返回 429 |
| 客户端中途断开 | ✅ 清理并释放锁，服务继续可用 |
| 账号健康检查 | ✅ 返回 `ok` / `login_required` / `error` |
| 协议层单测 | ✅ 9/9（基于真实抓包样本） |

未实现：文件/图片输入、账号组转移对话、打包 exe。

## 架构

```
Cuko 客户端 --(HTTP/SSE)--> bridge/index.js --(CDP)--> 独立 Chrome --user-data-dir--> quick.aws.com
```

- **主程序**（`bridge/index.js`）：Node 进程，对外提供 Cuko API，对内通过 `chrome-remote-interface` 直连目标页面。
- **常驻连接**（`bridge/cdp-connection.js`）：每个账号一条常驻 CDP 连接，事件按作用域分发，避免「连接建立晚于数据到达」。
- **协议层**（`bridge/quick-protocol.js`）：AWS event-stream 拆帧 + CBOR 解码 + 事件归并。纯函数，可单测。
- **页面驱动**（`bridge/quick-sender.js` / `bridge/page.js`）：填 textarea、点发送、判定已发出。
- **管理台**（`ui/index.html`）：静态页面，管理账号与配置方案。

## 快速开始

```bash
npm install
npm start
```

默认监听 `http://127.0.0.1:3000`，可用环境变量 `CUKO_HTTP_PORT` 修改。

### 1. 添加账号

打开 `http://127.0.0.1:3000/`，填写模型 ID / 显示名称 → 「添加并启动 Chrome」。
会弹出一个独立 Chrome 窗口（独立 `--user-data-dir` + 独立调试端口，从 9222 递增），
**在该窗口里登录 quick.aws.com**。

### 2. 在客户端里配置

- 中转地址：`http://127.0.0.1:3000`
- Token：留空
- 模型：选择管理台里添加的账号

### 3. 直接调

```bash
curl http://127.0.0.1:3000/v1/models
```

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

## 配置方案

所有行为参数由**配置方案**驱动：

- **默认方案**：硬编码在 `bridge/default-config.js`，不可修改、不可删除。
- **自定义方案**：在管理台「配置方案」卡片新建，创建时从默认方案深拷贝。
- **账号绑定**：每个账号可指定一个方案；不指定或所指方案被删除时回退默认方案。

时间类字段单位为**秒**，支持小数。粘贴/回车等待为区间，实际在 `[min, max]` 内随机。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 模型（账号）列表 |
| POST | `/v1/responses` | 发送消息（SSE 流式） |
| GET | `/api/accounts` | 账号列表（含在线状态、健康、生效方案） |
| POST | `/api/accounts` | 新增账号（自动启动 Chrome） |
| PUT | `/api/accounts/:id` | 改名 / 绑配置方案 |
| DELETE | `/api/accounts/:id` | 删除账号（含独立数据目录） |
| POST | `/api/accounts/:id/open` | 打开 Chrome |
| GET | `/api/accounts/:id/health` | 账号健康检查 |
| GET/POST | `/api/profiles` | 配置方案列表 / 新建 |
| PUT/DELETE | `/api/profiles/:id` | 修改 / 删除方案 |

## 目录结构

```
bridge/
  index.js            HTTP 服务、Cuko 路由、管理 API
  app-paths.js        运行目录解析
  default-config.js   默认配置方案、校验、区间随机
  store.js            账号/方案/健康检查持久化 + 日志落盘
  chrome.js           Chrome 启动与端口探测
  cdp-connection.js   每账号常驻 CDP 连接 + 事件作用域
  quick-protocol.js   AWS event-stream 拆帧 + CBOR + 事件归并（纯函数）
  quick-transport.js  经 CDP 观测/注入聊天 WebSocket 帧
  page.js             页面选择器与求值表达式（基于实测 DOM）
  quick-sender.js     填词、点发送、判定已发出
  chat.js             单轮对话主流程
  compress.js         历史压缩请求
  health.js           账号健康检查
  input.js            输入项归一化
ui/index.html         管理台
docs/
  cuko-api-v1.md          Cuko API 协议契约
  quick-protocol.md       Quick 网页版聊天协议实测分析
  requirements/           需求档案
test/
  run.mjs                测试运行器
  protocol.test.mjs      协议层回归测试
  fixtures/              真实抓包样本
scripts/
  build-docs-index.mjs    需求索引生成器
data/                 运行时数据（已 .gitignore）
```

## 验证

```bash
npm test
```

测试基于 `test/fixtures/` 里的**真实抓包样本**，覆盖拆帧、CBOR 解码、分片重组、
事件归并、上行帧编码往返。

## 关键实现要点

1. **WebSocket 帧是 CBOR，不是 JSON**。payload 是 `application/cbor` 的 `{payload: <bytes>}`，
   里面才是 inner JSON。详见 `docs/quick-protocol.md` §2.3。
2. **不能依赖 `Network.webSocketCreated`**。页面在 CDP 连上来之前就建好了连接，
   该事件不会再触发；但 `webSocketFrameReceived` 照常到达，直接按帧内容过滤。
3. **输入框赋值必须走原生 setter**。页面是 React 受控组件，直接改 `textarea.value`
   不会更新状态，发送按钮一直 disabled。
4. **优先点发送按钮而不是回车**。实测点按钮最稳，回车作兜底。
5. **`turn_usage.total_tokens` 是整个上下文的累计**，不是本轮增量。

## 免责声明

本项目通过自动化驱动网页版界面工作，与 Amazon / AWS 无关联，非官方实现。
请仅在你拥有或获得明确授权的账号上使用，并遵守相关服务条款。
