/**
 * 把现有 handleChat 写出的 Cuko SSE，捕获成事件流。
 *
 * 这样 OpenAI 入口不用重写 Quick 的发送、续接、超时、附件逻辑：
 *   handleChat({ res: sink, ... }) → sink 解析 event: message/done/error
 *   → 入口层再翻译成 OpenAI Responses / Chat Completions。
 */
import { EventEmitter } from 'node:events';

export class CukoSink extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.socket = { setNoDelay() {} };
    this._buffer = '';
    this._ended = false;
    this._destroyed = false;
  }

  writeHead(statusCode, headers) {
    this.statusCode = Number(statusCode) || 200;
    if (headers && typeof headers === 'object') Object.assign(this.headers, headers);
    return this;
  }

  flushHeaders() {}

  setHeader(name, value) { this.headers[String(name)] = value; }
  getHeader(name) { return this.headers[String(name)]; }

  get writableEnded() { return this._ended; }
  get headersSent() { return true; }
  get destroyed() { return this._destroyed; }

  write(chunk) {
    if (this._ended || this._destroyed) return false;
    if (chunk == null) return true;
    this._buffer += String(chunk).replace(/\r\n/g, '\n');
    this._drain();
    return true;
  }

  end(chunk) {
    if (chunk != null) this.write(chunk);
    if (this._ended) return this;
    this._ended = true;
    this._drain();
    this.emit('end');
    return this;
  }

  /** 模拟客户端断开：handleChat 会收到 close 并释放锁。 */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._ended = true;
    this.emit('close');
  }

  _drain() {
    let index = this._buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = this._buffer.slice(0, index);
      this._buffer = this._buffer.slice(index + 2);
      this._handleBlock(block);
      index = this._buffer.indexOf('\n\n');
    }
  }

  _handleBlock(block) {
    const lines = String(block || '').split('\n');
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue; // SSE 注释 / keepalive
      if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) { dataLines.push(line.slice(5).trimStart()); continue; }
    }
    if (!dataLines.length) return;

    let data;
    try { data = JSON.parse(dataLines.join('\n')); } catch { return; }

    if (event === 'message') {
      if (data.providerSessionId) this.emit('session', String(data.providerSessionId));
      if (Array.isArray(data.output)) {
        for (const part of data.output) {
          if (typeof part === 'string' && part) this.emit('text', part);
        }
      }
      if (typeof data.think === 'string' && data.think) this.emit('think', data.think);
      return;
    }

    if (event === 'done') {
      if (data.providerSessionId) this.emit('session', String(data.providerSessionId));
      this.emit('done', data);
      return;
    }

    if (event === 'error') {
      const err = new Error(String(data.message || 'Quick 返回错误'));
      err.code = String(data.code || 'provider_unavailable');
      this.emit('cuko-error', err);
    }
  }
}
