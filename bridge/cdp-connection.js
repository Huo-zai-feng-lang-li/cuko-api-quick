/**
 * 常驻 CDP 连接管理
 *
 * 为什么需要常驻连接：
 *  - 每次请求临时建连 + Network.enable + 注册监听时，请求极快会出现
 *    「连接建立晚于数据到达」的窗口期，收不到 WebSocket 帧，最终响应为空。
 *  - 常驻连接在首次使用时建立，enable 和监听只做一次，之后所有请求复用。
 *
 * 为什么用「事件作用域」而不是每个请求重新 wire：
 *  - 底层只 wire 一次（_dispatch 分发）。业务层通过 createScope() 注册回调，
 *    请求结束 scope.close() 自动摘除，避免监听无限累积。
 *
 * 失效检测：
 *  - client.disconnect 事件：被动标记，立即失效
 *  - 请求前 Runtime.evaluate('1') 探活：主动兜底，事件丢失时也能发现
 *  - 任一失败则重建连接（ensureAlive）
 */
import CDP from 'chrome-remote-interface';

const connections = new Map(); // modelId -> CdpConnection

class CdpConnection {
  constructor(account, targetMatch) {
    this.account = account;
    // 目标页面匹配：URL 里包含该片段即为聊天页
    this.targetMatch = targetMatch || 'quick.aws.com';
    this.client = null;
    this.Runtime = null;
    this.Input = null;
    this.Network = null;
    this.Page = null;
    this.alive = false;
    this.connecting = null;
    this.scopes = new Set();
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const targets = await CDP.List({ port: this.account.debugPort });
      const target = targets.find(t => t.type === 'page' && String(t.url || '').includes(this.targetMatch));
      if (!target || !target.webSocketDebuggerUrl) {
        throw new Error('找不到目标页面 target（' + this.targetMatch + '）');
      }
      this.client = await CDP({ target: target.webSocketDebuggerUrl });
      this.Runtime = this.client.Runtime;
      this.Input = this.client.Input;
      this.Network = this.client.Network;
      this.Page = this.client.Page;

      await this.Page.enable();
      await this.Runtime.enable();
      await this.Network.enable({
        maxTotalBufferSize: 104857600,
        maxResourceBufferSize: 52428800,
        maxPostDataSize: 104857600,
      });

      this.client.on('disconnect', () => {
        this.alive = false;
        console.log('[CDP-conn] disconnect:', this.account.modelId);
      });

      this.Network.requestWillBeSent((params) => this._dispatch('requestWillBeSent', params));
      this.Network.dataReceived((params) => this._dispatch('dataReceived', params));
      this.Network.loadingFinished((params) => this._dispatch('loadingFinished', params));
      this.Network.loadingFailed((params) => this._dispatch('loadingFailed', params));
      this.Network.webSocketCreated((params) => this._dispatch('webSocketCreated', params));
      this.Network.webSocketWillSendHandshakeRequest((params) => this._dispatch('webSocketWillSendHandshakeRequest', params));
      this.Network.webSocketFrameReceived((params) => this._dispatch('webSocketFrameReceived', params));
      this.Network.webSocketFrameSent((params) => this._dispatch('webSocketFrameSent', params));
      this.Network.webSocketClosed((params) => this._dispatch('webSocketClosed', params));

      this.alive = true;
      console.log('[CDP-conn] connected:', this.account.modelId, 'port', this.account.debugPort);
    })();
    try {
      await this.connecting;
    } catch (e) {
      this.connecting = null;
      throw e;
    } finally {
      this.connecting = null;
    }
  }

  async ensureAlive() {
    if (!this.alive || !this.client) {
      await this.connect();
      return;
    }
    try {
      await this.Runtime.evaluate({ expression: '1', returnByValue: true });
    } catch (e) {
      console.warn('[CDP-conn] 探活失败，重建连接:', this.account.modelId, e.message);
      this.alive = false;
      try { if (this.client) this.client.close(); } catch (_) {}
      this.client = null;
      await this.connect();
    }
  }

  /**
   * 创建一个事件作用域。业务层在作用域内注册事件回调，
   * 底层只 wire 一次，事件按作用域分发；作用域关闭后自动摘除。
   */
  createScope() {
    const handlers = {
      requestWillBeSent: [], dataReceived: [], loadingFinished: [], loadingFailed: [],
      webSocketCreated: [], webSocketWillSendHandshakeRequest: [],
      webSocketFrameReceived: [], webSocketFrameSent: [], webSocketClosed: [],
    };
    const off = (list, cb) => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
    const scope = {
      handlers,
      Network: {
        requestWillBeSent: (cb) => { handlers.requestWillBeSent.push(cb); return () => off(handlers.requestWillBeSent, cb); },
        dataReceived: (cb) => { handlers.dataReceived.push(cb); return () => off(handlers.dataReceived, cb); },
        loadingFinished: (cb) => { handlers.loadingFinished.push(cb); return () => off(handlers.loadingFinished, cb); },
        loadingFailed: (cb) => { handlers.loadingFailed.push(cb); return () => off(handlers.loadingFailed, cb); },
        webSocketCreated: (cb) => { handlers.webSocketCreated.push(cb); return () => off(handlers.webSocketCreated, cb); },
        webSocketWillSendHandshakeRequest: (cb) => { handlers.webSocketWillSendHandshakeRequest.push(cb); return () => off(handlers.webSocketWillSendHandshakeRequest, cb); },
        webSocketFrameReceived: (cb) => { handlers.webSocketFrameReceived.push(cb); return () => off(handlers.webSocketFrameReceived, cb); },
        webSocketFrameSent: (cb) => { handlers.webSocketFrameSent.push(cb); return () => off(handlers.webSocketFrameSent, cb); },
        webSocketClosed: (cb) => { handlers.webSocketClosed.push(cb); return () => off(handlers.webSocketClosed, cb); },
        enable: (...a) => this.Network.enable(...a),
        getResponseBody: (...a) => this.Network.getResponseBody(...a),
        getRequestPostData: (...a) => this.Network.getRequestPostData(...a),
      },
      close: () => { this.scopes.delete(scope); },
    };
    this.scopes.add(scope);
    return scope;
  }

  _dispatch(eventName, params) {
    for (const scope of this.scopes) {
      const list = scope.handlers[eventName];
      if (!list || !list.length) continue;
      for (const cb of list) {
        try { cb(params); } catch (e) { console.warn('[CDP-conn] handler error:', e.message); }
      }
    }
  }

  async close() {
    this.alive = false;
    if (this.client) {
      try { await this.client.close(); } catch (_) {}
      this.client = null;
    }
    connections.delete(this.account.modelId);
  }
}

/**
 * 获取（或建立）账号的常驻连接。
 * 若连接已失效会重建；target 找不到会抛错，调用方负责启动 Chrome 后重试。
 * @param {object} account 账号对象（含 modelId / debugPort）
 * @param {string} [targetMatch] 目标页面 URL 片段
 */
export async function getConnection(account, targetMatch) {
  let conn = connections.get(account.modelId);
  if (!conn) {
    conn = new CdpConnection(account, targetMatch);
    connections.set(account.modelId, conn);
  } else if (targetMatch) {
    conn.targetMatch = targetMatch;
  }
  await conn.ensureAlive();
  return conn;
}

/** 关闭指定账号的连接（账号删除时用） */
export async function closeConnection(accountId) {
  const conn = connections.get(accountId);
  if (conn) await conn.close();
}

/** 关闭所有连接（进程退出时用） */
export async function closeAllConnections() {
  for (const conn of connections.values()) {
    try { await conn.close(); } catch (_) {}
  }
  connections.clear();
}
