/**
 * 单轮对话主流程：接收 Cuko 请求 → 驱动页面发送 → 观测聊天帧 → 转成 Cuko SSE
 *
 * 传输策略见 quick-transport.js：
 *   - 默认 observe：页面自己发上行帧，我们只解析下行。
 *   - 页面未就绪/无连接时可切 inject（在页面上下文自建 WS，自己收发）。
 *
 * 结束判定（docs/quick-protocol.md §4.4）：
 *   message_complete 且 continuation_expected !== true  → 本轮结束
 *   stream_ended / turn_aborted                          → 直接结束
 *   error / guardrail_blocked / stream_truncated         → 失败
 */
import { QuickTurnExtractor } from './quick-protocol.js';
import { QuickChannel } from './quick-transport.js';
import { sendUserMessage, waitForComposer, startNewChat, isGenerating, currentUrl } from './quick-sender.js';
import { extractThreadIdFromUrl } from './page.js';

const IDLE_TIMEOUT_MS = 120000;   // 连续 120s 无任何聊天事件 → 判定卡死
const KEEPALIVE_MS = 20000;

/**
 * 处理一次 Cuko /v1/responses 请求（普通增量对话）。
 * @param {object} ctx
 * @param {import('node:http').ServerResponse} ctx.res
 * @param {object} ctx.payload Cuko 请求体
 * @param {object} ctx.account 账号
 * @param {object} ctx.conn CDP 常驻连接
 * @param {object} ctx.cfg 生效配置方案 values
 * @param {object} ctx.profile 生效配置方案
 * @param {(modelId:string)=>void} ctx.release 释放并发锁
 */
export async function handleChat({ res, payload, account, conn, cfg, profile, release }) {
  const isNewChat = !payload.providerSessionId;
  const log = (...a) => console.log('[Chat]', ...a);

  const extractor = new QuickTurnExtractor();
  let channel = null;
  let dispatched = false;
  let isStreaming = false;
  let sentTextLen = 0;
  let sentThinkLen = 0;
  let sessionIdSent = false;
  let realSessionId = payload.providerSessionId || null;
  let timedOut = false;
  let aborted = false;
  let idleTimer = null;
  let totalTimer = null;
  let keepAliveTimer = null;
  let firstEventSeen = false;

  const clearAllTimers = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  };

  /** 推首帧 / 推增量 */
  const flush = (force) => {
    if (!isStreaming) {
      if (!realSessionId && !payload.providerSessionId && !force) return;
      isStreaming = true;
      res.write('event: message\n');
      res.write('data: ' + JSON.stringify({ output: [], providerSessionId: realSessionId }) + '\n\n');
      if (realSessionId) sessionIdSent = true;
    }
    const data = {};
    let has = false;
    if (extractor.text.length > sentTextLen) {
      data.output = [extractor.text.slice(sentTextLen)];
      sentTextLen = extractor.text.length;
      has = true;
    }
    if (extractor.think.length > sentThinkLen) {
      data.think = extractor.think.slice(sentThinkLen);
      sentThinkLen = extractor.think.length;
      has = true;
    }
    if (has) {
      res.write('event: message\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    }
  };

  /** 拿到真实 thread id 后补推 providerSessionId */
  const pushSessionIdIfNeeded = () => {
    if (sessionIdSent || !realSessionId) return;
    if (!isStreaming) { flush(); return; }
    sessionIdSent = true;
    log('补推 providerSessionId:', realSessionId);
    res.write('event: message\n');
    res.write('data: ' + JSON.stringify({ output: [], providerSessionId: realSessionId }) + '\n\n');
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log('空闲超时（' + Math.round(IDLE_TIMEOUT_MS / 1000) + 's 无事件），强制结束');
      timedOut = true;
      finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
    }, IDLE_TIMEOUT_MS);
  };

  /** 收尾：推 done 并释放资源 */
  const finish = async () => {
    if (dispatched) return;
    dispatched = true;
    clearAllTimers();
    if (channel) channel.close();

    // 页面 URL 里通常能拿到 thread id，作为续接句柄兜底
    if (!realSessionId) {
      const url = await currentUrl(conn).catch(() => '');
      const tid = extractThreadIdFromUrl(url);
      if (tid) {
        realSessionId = tid;
        log('从页面 URL 提取到 thread id:', tid);
        pushSessionIdIfNeeded();
      }
    }

    try { flush(true); } catch (_) {}

    if (extractor.error && !timedOut) {
      try {
        res.write('event: error\n');
        res.write('data: ' + JSON.stringify({ code: 'provider_unavailable', message: extractor.error }) + '\n\n');
      } catch (_) {}
    } else if (timedOut) {
      try {
        res.write('event: error\n');
        res.write('data: ' + JSON.stringify({ code: 'request_timeout', message: '响应超时，内容可能不完整' }) + '\n\n');
      } catch (_) {}
    }

    const usage = extractor.usage || { total_tokens: 0 };
    try {
      res.write('event: done\n');
      res.write('data: ' + JSON.stringify({
        finishReason: timedOut ? 'timeout' : 'stop',
        usage: {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          total_tokens: usage.total_tokens || 0,
        },
        providerSessionId: realSessionId || undefined,
      }) + '\n\n');
      res.end();
    } catch (_) {}

    log('本轮结束：正文 ' + extractor.text.length + ' 字，思考 ' + extractor.think.length + ' 字，事件 ' + JSON.stringify(extractor.eventCounts));
    release();
  };

  // 客户端断开（用户点停止）→ 清理并释放锁
  res.on('close', () => {
    if (!dispatched) {
      log('客户端断开，中止本轮');
      aborted = true;
      clearAllTimers();
      if (channel) channel.close();
      dispatched = true;
      release();
    }
  });

  try {
    // ---------- 1. 页面就绪 ----------
    let st = await waitForComposer(conn, cfg.pageReadyPollMaxSec);
    if (!st) {
      // 可能停在登录页或非聊天页，给出明确提示
      const url = await currentUrl(conn);
      throw new Error('页面输入区未就绪（当前 URL: ' + url + '），请确认已登录 quick.aws.com');
    }
    log('页面就绪，输入区选择器=' + st.sel + '，当前 URL=' + (await currentUrl(conn)));

    if (isNewChat) {
      log('新对话请求，先回到新对话页');
      await startNewChat(conn, cfg);
      st = await waitForComposer(conn, cfg.pageReadyPollMaxSec);
      if (!st) throw new Error('新建对话后输入区未就绪');
    }

    // ---------- 2. 挂下行帧监听 ----------
    const scope = conn.createScope();
    channel = new QuickChannel(scope, {
      log,
      onEvent: (evt) => {
        if (aborted || dispatched) return;
        if (!firstEventSeen) {
          firstEventSeen = true;
          resetIdle();
        }
        // 续接时事件里可能混入别的会话，按 thread 过滤（拿不到 thread 的事件也放行）
        const evtThread = evt.thread_id || (evt.payload && evt.payload.thread_id) || '';
        if (payload.providerSessionId && evtThread && evtThread !== payload.providerSessionId) {
          return;
        }
        extractor.consume(evt);
        if (!realSessionId && extractor.threadId) {
          realSessionId = extractor.threadId;
          log('从事件中拿到 thread id:', realSessionId);
          pushSessionIdIfNeeded();
        }
        flush();
        if (extractor.finished || extractor.error) {
          finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
        }
      },
      onError: (err) => {
        if (aborted || dispatched) return;
        log('通道错误:', err.code, err.message);
        if (err.code === 'ws_closed') {
          extractor.consume({ type: 'stream_truncated', payload: { message: err.message } });
          finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
        }
      },
    }).attach();

    // 总超时 + 心跳（覆盖粘贴/等待阶段）
    totalTimer = setTimeout(() => {
      log('请求总超时（' + cfg.requestTimeoutSec + 's），强制结束');
      timedOut = true;
      finish().catch(e => console.warn('[Chat] finish 异常:', e.message));
    }, Math.round((cfg.requestTimeoutSec || 900) * 1000));
    keepAliveTimer = setInterval(() => {
      try { if (!res.writableEnded) res.write(': keepalive\n\n'); } catch (_) {}
    }, KEEPALIVE_MS);

    // ---------- 3. 发送 ----------
    // 客户端断开后不要再往页面里打字，避免污染会话
    if (aborted) throw new Error('客户端已断开，中止发送');

    const r = await sendUserMessage(conn, payload._text, cfg, {
      skipPreEnterWait: payload.type === 'user',
    });
    if (!r.ok) throw new Error(r.error || '发送失败');
    log('消息已发出，等待 Quick 响应…');

    // 发送完成后再开始空闲计时（粘贴/等待阶段不算卡死）
    resetIdle();

    // 若短时间内没有任何事件，可能是页面没有真的发出，给出提示但不立即失败
    setTimeout(async () => {
      if (dispatched || aborted || firstEventSeen) return;
      const gen = await isGenerating(conn).catch(() => false);
      log('尚未收到任何聊天事件（页面生成中=' + gen + '），继续等待…');
    }, 15000);
  } catch (err) {
    console.error('[Chat] 失败:', err.message);
    if (!res.writableEnded) {
      try {
        res.write('event: error\n');
        res.write('data: ' + JSON.stringify({ code: 'internal_error', message: err.message }) + '\n\n');
        res.end();
      } catch (_) {}
    }
    clearAllTimers();
    if (channel) channel.close();
    if (!dispatched) { dispatched = true; release(); }
  }
}
