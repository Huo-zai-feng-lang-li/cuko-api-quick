/**
 * OpenAI 兼容入口。
 *
 * 路由（独立命名空间，避免和 Cuko 老协议冲突）：
 *   GET  /openai/v1/models
 *   GET  /openai/v1/models/:id
 *   POST /openai/v1/responses
 *   POST /openai/v1/chat/completions
 *
 * 这个入口不直接碰 Chrome：账号、健康检查、连接、并发锁都通过 deps 注入，
 * 真正的 Quick 回合仍由现有 handleChat 完成。
 */
import { CukoSink } from './cuko-sink.js';
import { accountHealthError } from '../account-health.js';
import { listModelAliases, groupAccountsByAlias } from '../account-scheduler.js';
import path from 'node:path';
import { DATA_DIR } from '../app-paths.js';
import {
  formatResponsesPrompt, formatChatPrompt, parseToolCalls, makeId, openaiError,
  extractImageAttachments,
} from './protocol.js';
import { materializeFileItems } from '../attachments.js';
import { stopQuickGeneration } from '../quick-sender.js';
import {
  createSessionStore, responseSessionKey, chatSessionKey,
} from './session-store.js';
import {
  writeResponsesJson, writeChatJson, writeResponsesStart, writeChatStart,
  createResponsesStream, createChatStream,
} from './writers.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const KEEPALIVE_MS = 15000;
const SESSION_FILE = process.env.CUKO_OPENAI_SESSION_FILE !== undefined
  ? process.env.CUKO_OPENAI_SESSION_FILE
  : path.join(DATA_DIR, 'openai-sessions.json');
const SESSION_TTL_MS = Number(process.env.CUKO_OPENAI_SESSION_TTL_MS);

/** 进程级会话映射：默认 24h 滑动过期并落盘，网关重启后仍可续接同一 Quick 线程。 */
export const openaiSessions = createSessionStore({ filePath: SESSION_FILE, ttlMs: SESSION_TTL_MS });

/** 正在跑的 OpenAI Chat 回合，按 chatSessionKey 索引；供显式停止入口定位 sink。 */
const activeQuickTurns = new Map();

function cors(res) {
  res.setHeader?.('Access-Control-Allow-Origin', '*');
  res.setHeader?.('Access-Control-Allow-Headers', 'authorization,content-type,x-session-id,x-conversation-id');
  res.setHeader?.('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const declared = Number(req.headers && req.headers['content-length']) || 0;
  if (declared > MAX_BODY_BYTES) {
    const err = new Error('请求体过大');
    err.statusCode = 413;
    throw err;
  }
  let body = '';
  req.setEncoding?.('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      const err = new Error('请求体过大');
      err.statusCode = 413;
      throw err;
    }
  }
  return body;
}

function parseJson(body) {
  try { return JSON.parse(body); } catch {
    const err = new Error('Bad JSON');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * 会话存储统一成对象：{ providerSessionId, accountId }。
 * 兼容旧格式（只存字符串），避免服务升级后旧句柄直接失效。
 */
function sessionParts(value) {
  if (!value) return { providerSessionId: '', accountId: '' };
  if (typeof value === 'string') return { providerSessionId: value, accountId: '' };
  return {
    providerSessionId: String(value.providerSessionId || ''),
    accountId: String(value.accountId || ''),
  };
}

function sessionValue(providerSessionId, accountId) {
  return { providerSessionId: providerSessionId || '', accountId: accountId || '' };
}

/**
 * 从账号池申请槽位；健康过滤交给调度器，入口层只负责把错误转成 HTTP。
 */
async function acquireSlot(deps, { alias, preferredAccountId, signal }) {
  const healthMap = deps.getAccountHealth();
  return await deps.scheduler.acquire({
    accounts: deps.getAccounts(),
    alias,
    preferredAccountId,
    accountError: (account) => {
      // 回收窗口（断连 + 关 Chrome 的 1~2s）内不接单，避免一边 taskkill 一边冷启动。
      if (typeof deps.isRecycling === 'function' && deps.isRecycling(account.modelId)) {
        return {
          statusCode: 503,
          code: 'account_unavailable',
          type: 'server_error',
          message: '账号正在回收，请稍后重试',
        };
      }
      return accountHealthError(account && account.modelId, healthMap);
    },
    signal,
  });
}

function sendAcquireError(res, err) {
  const status = err.statusCode || (err.code === 'client_closed' ? 499 : 503);
  const code = err.code || 'provider_unavailable';
  const type = err.type || (status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'server_error');
  if (!res.writableEnded) sendError(res, status, err.message, code, type);
}

function errorStatus(code) {
  if (code === 'authentication_required') return 401;
  if (code === 'rate_limit_exceeded') return 429;
  if (code === 'request_timeout') return 504;
  if (code === 'provider_unavailable') return 502;
  return 500;
}

function errorType(code) {
  if (code === 'authentication_required') return 'authentication_error';
  if (code === 'rate_limit_exceeded') return 'rate_limit_error';
  if (code === 'request_timeout') return 'timeout_error';
  if (code === 'provider_unavailable') return 'server_error';
  return 'server_error';
}

function sendResponsesStreamError(res, { id, model, message, code, sequenceStart = 0 }) {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }
  let seq = Number(sequenceStart) || 0;
  const send = (type, data) => {
    if (res.writableEnded) return;
    res.write('event: ' + type + '\n');
    res.write('data: ' + JSON.stringify({ type, ...data, sequence_number: seq++ }) + '\n\n');
  };
  send('error', {
    type: 'error',
    code,
    message,
    param: null,
    error: { message, type: errorType(code), code },
  });
  send('response.failed', {
    type: 'response.failed',
    response: {
      id: id || makeId('resp'),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'failed',
      model: model || '',
      output: [],
      usage: null,
      error: { code, message },
    },
  });
  res.end();
}

function sendChatStreamError(res, { message, code }) {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }
  res.write('data: ' + JSON.stringify({
    error: { message, type: errorType(code), code },
  }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendError(res, status, message, code = 'invalid_request', type = 'invalid_request_error') {
  sendJson(res, status, openaiError(message, type, code));
}

/**
 * 等待一轮 Quick 完成。handleChat 是“启动后返回”，完成靠 sink 事件。
 */
function runQuickTurn({ deps, account, profile, payload, release, detach, res, onSink, onConn, onText, onThink, onSession }) {
  const sink = new CukoSink();
  deps.activeResponses.set(account.modelId, sink);
  if (typeof onSink === 'function') onSink(sink);

  const state = { text: '', think: '', sessionId: payload.providerSessionId || '', usage: null, finishReason: 'stop' };
  sink.on('text', (t) => { state.text += t; if (typeof onText === 'function') onText(t); });
  sink.on('think', (t) => { state.think += t; if (typeof onThink === 'function') onThink(t); });
  sink.on('session', (id) => { state.sessionId = id; if (typeof onSession === 'function') onSession(id); });
  sink.on('done', (data) => {
    state.finishReason = data.finishReason || 'stop';
    state.usage = data.usage || null;
    if (data.providerSessionId) state.sessionId = data.providerSessionId;
  });

  const clientClosed = () => {
    const err = new Error('客户端已断开');
    err.code = 'client_closed';
    err.statusCode = 499;
    return err;
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      try { res.off?.('close', onResClose); } catch (_) {}
      if (timer) { clearTimeout(timer); timer = null; }
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve({
        text: state.text,
        think: state.think,
        sessionId: state.sessionId || null,
        usage: state.usage,
        finishReason: state.finishReason,
      });
    };

    const onResClose = () => {
      if (!res.writableEnded) sink.destroy();
    };
    res.on('close', onResClose);

    // handleChat 自己有 idle/总超时，但入口层再加一道硬闸：
    // 如果 handleChat 还没进入自己的计时器就卡住，锁也不能永久不释放。
    const timeoutSec = Number(profile && profile.values && profile.values.requestTimeoutSec) || 900;
    timer = setTimeout(() => {
      if (settled) return;
      const err = new Error('Quick 回合超时');
      err.code = 'request_timeout';
      err.statusCode = 504;
      // 先结算超时，再销毁 sink；destroy 会同步触发 close，
      // 反过来会把错误误报成 client_closed。
      finish(err);
      sink.destroy();
    }, (timeoutSec + 30) * 1000);

    sink.once('cuko-error', (err) => finish(err));
    sink.once('done', () => finish(null));
    sink.once('close', () => finish(clientClosed()));
    sink.once('end', () => {
      // 正常路径应先有 done；没有 done 的 end 视为失败，避免空响应挂起。
      finish(new Error('Quick 回合异常结束（没有 done 事件）'));
    });

    (async () => {
      try {
        const conn = await deps.ensureConnection(account, profile.values, deps.getConnection, 'quick.aws.com');
        if (settled) return;
        if (typeof onConn === 'function') onConn(conn);
        // OpenAI 入口也要刷新常驻池活跃时间，否则空闲轮询会把刚拉起的 Chrome 回收。
        if (typeof deps.touchAccount === 'function') deps.touchAccount(account.modelId);
        await deps.handleChat({
          res: sink,
          payload,
          account,
          conn,
          cfg: profile.values,
          profile,
          release,
          detach,
        });
      } catch (e) {
        finish(e);
      }
    })();
  });
}

/** 把提示词里最后一个“图片暂不支持”占位改成真附件说明；旧历史图片不重复上传，保留占位。 */
function attachImageNotice(prompt, imageItems) {
  if (!imageItems || imageItems.length === 0) return prompt;
  const note = '[图片附件：本轮已通过附件上传 ' + imageItems.length + ' 张图片，请查看附件内容]';
  const marker = '[图片输入暂不支持：当前只转发文本]';
  const idx = prompt.lastIndexOf(marker);
  if (idx >= 0) return prompt.slice(0, idx) + note + prompt.slice(idx + marker.length);
  return note + '\n' + prompt;
}

function buildPayload({ body, prompt, providerSessionId, sessionKey, imageItems }) {
  const materialized = materializeFileItems(imageItems || []);
  if (materialized.errors.length) {
    console.warn('[openai] 图片附件落盘失败:', materialized.errors.join('; '));
  }
  return {
    // 对外仍回显别名；account.modelId 只用于内部连接和调度。
    model: String(body.model || ''),
    cuckSessionId: String(body.cuck_session_id || body.cuckSessionId || sessionKey || makeId('cuck')),
    requestId: makeId('req'),
    providerSessionId: providerSessionId || undefined,
    input: [{ type: 'text', text: prompt }],
    _text: prompt,
    _attachFiles: materialized.files.map((f) => f.filePath),
    _attachMeta: materialized.files,
  };
}

function toolListForParse(body) {
  return body && body.tool_choice === 'none' ? [] : body && body.tools;
}

async function handleModels({ res, pathname, deps }) {
  if (pathname === '/openai/v1/models') {
    const aliases = listModelAliases(deps.getAccounts());
    sendJson(res, 200, {
      object: 'list',
      data: aliases.map(a => ({
        id: a.alias,
        object: 'model',
        created: Math.floor((a.createdAt || Date.now()) / 1000),
        owned_by: 'cuko',
        meta: { accounts: a.accounts },
      })),
    });
    return true;
  }
  const m = pathname.match(/^\/openai\/v1\/models\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const groups = groupAccountsByAlias(deps.getAccounts());
    const pool = groups.get(id);
    if (!pool || !pool.length) { sendError(res, 404, 'Model not found: ' + id, 'model_not_found'); return true; }
    sendJson(res, 200, {
      id,
      object: 'model',
      created: Math.floor((Math.min(...pool.map(a => Number(a.createdAt) || Date.now()))) / 1000),
      owned_by: 'cuko',
      meta: { accounts: pool.length },
    });
    return true;
  }
  return false;
}

async function handleResponses({ req, res, body, deps }) {
  const previousId = typeof body.previous_response_id === 'string' ? body.previous_response_id : '';
  const key = responseSessionKey(previousId);
  const session = sessionParts(key ? openaiSessions.get(key) : null);
  let providerSessionId = session.providerSessionId;
  if (previousId && !providerSessionId) {
    // 不静默新建线程：客户端会误以为上下文还在，工具结果/历史会落进错误会话。
    sendError(res, 400, 'previous_response_id 不存在或已过期；请去掉该字段重新开始', 'previous_response_id_not_found');
    return;
  }
  const imageItems = extractImageAttachments(body, 'responses');
  let continuation = Boolean(providerSessionId);
  let prompt = formatResponsesPrompt(body, { continuation });
  if (!prompt && continuation) {
    // 旧句柄存在但本轮没有新增内容：回退成新对话，避免空消息。
    console.warn('[openai] 续接句柄没有新内容，回退新对话:', previousId);
    providerSessionId = '';
    continuation = false;
    prompt = formatResponsesPrompt(body, { continuation: false });
  }
  prompt = attachImageNotice(prompt, imageItems);
  if (!prompt || !prompt.trim()) { sendError(res, 400, '输入为空：没有可识别的文本', 'invalid_request'); return; }

  const responseId = makeId('resp');
  const ac = new AbortController();
  let acquired = null;
  let account = null;
  let released = false;
  let sinkRef = null;

  const cleanupActive = () => {
    if (!account) return;
    if (!sinkRef || deps.activeResponses.get(account.modelId) === sinkRef) {
      deps.activeResponses.delete(account.modelId);
    }
  };
  const release = () => {
    if (released) return;
    released = true;
    if (acquired) acquired.release();
    cleanupActive();
    try { res.off?.('close', onClose); } catch (_) {}
  };
  // 客户端断开：优先进入调度器过渡期（detach），槽位不立刻空出，避免下一轮撞上旧回合；
  // 无 detach 或 grace=0 时 detach 自身会立即 release。回合最终结算仍走 release()。
  const detachSlot = () => {
    if (released) return;
    if (acquired && typeof acquired.detach === 'function') acquired.detach();
    else release();
    cleanupActive();
  };
  const onClose = () => {
    if (res.writableEnded) return;
    ac.abort();
    detachSlot();
  };
  res.on('close', onClose);

  try {
    acquired = await acquireSlot(deps, {
      alias: body.model,
      preferredAccountId: session.accountId,
      signal: ac.signal,
    });
  } catch (e) {
    try { res.off?.('close', onClose); } catch (_) {}
    sendAcquireError(res, e);
    return;
  }

  account = acquired.account;
  const profile = deps.resolveProfile(account);

  if (res.writableEnded) { release(); return; }
  const payload = buildPayload({ body, prompt, providerSessionId, sessionKey: key, imageItems });
  const stream = body.stream === true;
  let keepAlive = null;
  let responseSeq = 0;
  let streamer = null;

  try {
    if (stream && !res.writableEnded) {
      // 先发 response.created/in_progress，避免 Codex 在长回合里只看到 keepalive。
      responseSeq = writeResponsesStart(res, { id: responseId, model: body.model });
      keepAlive = setInterval(() => {
        try { if (!res.writableEnded) res.write(': keepalive\n\n'); } catch (_) {}
      }, KEEPALIVE_MS);
      // 正文增量随 Quick text 事件即写；工具调用仍在整轮结束后解析补发。
      streamer = createResponsesStream(res, {
        id: responseId, model: body.model, sequenceStart: responseSeq,
      });
    }

    const result = await runQuickTurn({
      deps, account, profile, payload, release, detach: acquired.detach, res,
      onSink: (s) => { sinkRef = s; },
      onText: (t) => { if (streamer) streamer.pushText(t); },
    });
    const parsed = parseToolCalls(result.text, toolListForParse(body));
    const finalSession = result.sessionId || providerSessionId;
    // 超时/半成品回合不发布新句柄，避免下一轮续进未完成的 Quick 线程。
    if (finalSession && result.finishReason !== 'timeout') {
      openaiSessions.set(responseSessionKey(responseId), sessionValue(finalSession, account.modelId));
    }

    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (res.writableEnded) { release(); return; }

    if (stream) {
      streamer.finish({
        text: parsed.text, calls: parsed.calls,
        usage: result.usage, promptText: prompt,
        finishReason: result.finishReason,
      });
    } else {
      writeResponsesJson(res, {
        id: responseId, model: body.model, text: parsed.text, calls: parsed.calls,
        usage: result.usage, promptText: prompt, finishReason: result.finishReason,
      });
    }
    release();
  } catch (e) {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    // 异常前先关闭已打开的正文 item，避免留下“开了 content_part 没 done”的坏收尾。
    if (streamer) streamer.abort();
    // 客户端断开走 detach 过渡期；其它异常立即 release 结算。
    if (e && e.code === 'client_closed') detachSlot(); else release();
    if (res.writableEnded) return;
    const code = e.code || 'provider_unavailable';
    if (stream) sendResponsesStreamError(res, {
      id: responseId, model: body.model, message: e.message, code, sequenceStart: responseSeq,
    });
    else sendError(res, e.statusCode || errorStatus(code), e.message, code, errorType(code));
  }
}

async function handleChatCompletions({ req, res, body, deps }) {
  const key = chatSessionKey(body, req.headers);
  const session = sessionParts(key ? openaiSessions.get(key) : null);
  const imageItems = extractImageAttachments(body, 'chat');
  let providerSessionId = session.providerSessionId;
  let continuation = Boolean(providerSessionId);
  let prompt = formatChatPrompt(body, { continuation });
  if (!prompt && continuation) {
    console.warn('[openai] Chat 会话没有新内容，回退新对话:', key);
    providerSessionId = '';
    continuation = false;
    prompt = formatChatPrompt(body, { continuation: false });
  }
  prompt = attachImageNotice(prompt, imageItems);
  if (!prompt || !prompt.trim()) { sendError(res, 400, '输入为空：没有可识别的文本', 'invalid_request'); return; }

  const chatId = makeId('chatcmpl', '-');
  const ac = new AbortController();
  let acquired = null;
  let account = null;
  let released = false;
  let sinkRef = null;
  let turnKey = '';

  const cleanupActive = () => {
    if (!account) return;
    if (!sinkRef || deps.activeResponses.get(account.modelId) === sinkRef) {
      deps.activeResponses.delete(account.modelId);
    }
    if (turnKey && (!sinkRef || activeQuickTurns.get(turnKey)?.sink === sinkRef)) {
      activeQuickTurns.delete(turnKey);
    }
  };
  const release = () => {
    if (released) return;
    released = true;
    if (acquired) acquired.release();
    cleanupActive();
    try { res.off?.('close', onClose); } catch (_) {}
  };
  // 客户端断开优先 detach 过渡期；回合最终结算仍走 release()。
  const detachSlot = () => {
    if (released) return;
    if (acquired && typeof acquired.detach === 'function') acquired.detach();
    else release();
    cleanupActive();
  };
  const onClose = () => {
    if (res.writableEnded) return;
    ac.abort();
    detachSlot();
  };
  res.on('close', onClose);

  try {
    acquired = await acquireSlot(deps, {
      alias: body.model,
      preferredAccountId: session.accountId,
      signal: ac.signal,
    });
  } catch (e) {
    try { res.off?.('close', onClose); } catch (_) {}
    sendAcquireError(res, e);
    return;
  }

  account = acquired.account;
  const profile = deps.resolveProfile(account);

  if (res.writableEnded) { release(); return; }
  const payload = buildPayload({ body, prompt, providerSessionId, sessionKey: key, imageItems });
  turnKey = key || ('cuck:' + payload.cuckSessionId);
  const stream = body.stream === true;
  let keepAlive = null;
  let chatCreated = 0;
  let streamer = null;

  try {
    if (stream && !res.writableEnded) {
      // 先发 role chunk，dsh 这类客户端才不会在长回合里判定流超时。
      chatCreated = writeChatStart(res, { id: chatId, model: body.model });
      keepAlive = setInterval(() => {
        try { if (!res.writableEnded) res.write(': keepalive\n\n'); } catch (_) {}
      }, KEEPALIVE_MS);
      // 正文 chunk 随 Quick text 事件即写；工具调用仍在整轮结束后解析补发。
      streamer = createChatStream(res, {
        id: chatId, model: body.model, created: chatCreated,
        includeUsage: Boolean(body.stream_options && body.stream_options.include_usage),
      });
    }

    const result = await runQuickTurn({
      deps, account, profile, payload, release, detach: acquired.detach, res,
      onSink: (s) => {
        sinkRef = s;
        if (turnKey) activeQuickTurns.set(turnKey, { sink: s, conn: null });
      },
      onConn: (conn) => {
        const entry = activeQuickTurns.get(turnKey);
        if (entry) entry.conn = conn;
      },
      onText: (t) => { if (streamer) streamer.pushText(t); },
    });
    const parsed = parseToolCalls(result.text, toolListForParse(body));
    const finalSession = result.sessionId || providerSessionId;
    if (finalSession && result.finishReason !== 'timeout' && key) {
      openaiSessions.set(key, sessionValue(finalSession, account.modelId));
    }

    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (res.writableEnded) { release(); return; }

    if (stream) {
      streamer.finish({
        text: parsed.text, calls: parsed.calls,
        usage: result.usage, promptText: prompt,
        finishReason: result.finishReason,
      });
    } else {
      writeChatJson(res, {
        id: chatId, model: body.model, text: parsed.text, calls: parsed.calls,
        usage: result.usage, promptText: prompt, finishReason: result.finishReason,
      });
    }
    release();
  } catch (e) {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (streamer) streamer.abort();
    if (e && e.code === 'client_closed') detachSlot(); else release();
    if (res.writableEnded) return;
    const code = e.code || 'provider_unavailable';
    if (stream) sendChatStreamError(res, { message: e.message, code });
    else sendError(res, e.statusCode || errorStatus(code), e.message, code, errorType(code));
  }
}

/** 显式停止：按 conversation_id 找到本网关正在跑的回合，先点网页停止按钮，再断开本地流。 */
async function handleChatStop({ res, body, headers }) {
  const key = chatSessionKey(body, headers);
  if (!key) {
    sendJson(res, 400, { ok: false, reason: 'missing_conversation_id' });
    return;
  }
  const entry = activeQuickTurns.get(key);
  if (!entry) {
    sendJson(res, 200, { ok: false, reason: 'no-active-turn' });
    return;
  }
  let clicked = false;
  try {
    const r = await Promise.race([
      stopQuickGeneration(entry.conn),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false }), 2000)),
    ]);
    clicked = !!(r && r.ok);
  } catch (_) { /* ignore */ }
  try { entry.sink.destroy(); } catch (_) { /* ignore */ }
  console.log('[openai] 停止回合，网页停止按钮=' + (clicked ? 'clicked' : 'not-found'));
  sendJson(res, 200, { ok: true, reason: clicked ? 'stopping' : 'disconnected' });
}

/**
 * @param {{req:any,res:any,url:URL,pathname:string,deps:object}} ctx
 * deps: getAccounts, getAccountHealth, resolveProfile, ensureConnection,
 *       getConnection, handleChat, scheduler, activeResponses
 */
export async function handleOpenAIRequest({ req, res, pathname, deps }) {
  cors(res);
  const routePath = String(pathname || '').replace(/\/+$/g, '') || '/';
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET') {
    if (await handleModels({ res, pathname: routePath, deps })) return;
    if (routePath === '/openai/v1/responses' || routePath === '/openai/v1/chat/completions'
      || routePath === '/openai/v1/chat/completions/stop') {
      sendError(res, 405, 'Method Not Allowed', 'method_not_allowed');
      return;
    }
    sendError(res, 404, 'Not Found', 'not_found');
    return;
  }

  if (req.method !== 'POST') {
    if (routePath === '/openai/v1/models' || routePath === '/openai/v1/responses'
      || routePath === '/openai/v1/chat/completions' || routePath === '/openai/v1/chat/completions/stop') {
      sendError(res, 405, 'Method Not Allowed', 'method_not_allowed');
      return;
    }
    sendError(res, 404, 'Not Found', 'not_found');
    return;
  }

  // 停止入口不要求 messages，只要 model + conversation_id 就能定位本轮。
  if (routePath === '/openai/v1/chat/completions/stop') {
    let stopBody;
    try {
      stopBody = parseJson(await readBody(req));
    } catch (e) {
      sendError(res, e.statusCode || 400, e.message, e.statusCode === 413 ? 'request_too_large' : 'invalid_json');
      return;
    }
    if (!stopBody || typeof stopBody !== 'object' || Array.isArray(stopBody)) {
      sendError(res, 400, '请求体必须是 JSON 对象', 'invalid_request');
      return;
    }
    if (!stopBody.model || typeof stopBody.model !== 'string') {
      sendError(res, 400, '缺少 model', 'invalid_request');
      return;
    }
    await handleChatStop({ res, body: stopBody, headers: req.headers });
    return;
  }

  if (routePath !== '/openai/v1/responses' && routePath !== '/openai/v1/chat/completions') {
    sendError(res, 404, 'Not Found', 'not_found');
    return;
  }

  let body;
  try {
    body = parseJson(await readBody(req));
  } catch (e) {
    sendError(res, e.statusCode || 400, e.message, e.statusCode === 413 ? 'request_too_large' : 'invalid_json');
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, '请求体必须是 JSON 对象', 'invalid_request');
    return;
  }
  if (!body.model || typeof body.model !== 'string') {
    sendError(res, 400, '缺少 model', 'invalid_request');
    return;
  }

  if (pathname === '/openai/v1/responses') {
    await handleResponses({ req, res, body, deps });
  } else {
    await handleChatCompletions({ req, res, body, deps });
  }
}
