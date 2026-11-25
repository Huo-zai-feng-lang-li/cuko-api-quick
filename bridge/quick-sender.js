/**
 * Quick 发送编排：把一段 Cuko 输入变成「页面上真的发出去的一条消息」
 *
 * 实测（2026-11-23，quick.aws.com）：
 *  - 输入框是原生 textarea，直接设 value 不会触发 React 状态更新，
 *    必须用 HTMLTextAreaElement.prototype 的原生 value setter + 派发 input 事件；
 *    设完 value 后「发送消息」按钮才会从 disabled 变可用。
 *  - 回车不一定生效（页面可能把 Enter 当换行），所以优先点按钮，
 *    按钮点不动再回退 CDP 物理回车。
 *  - 发送成功的判据：输入框被清空，或页面进入生成中（出现停止按钮）。
 */
import {
  DEFAULT_PROFILE_VALUES, pollDelayMs, composerTextMatches, decideSendReady,
  pasteVerifyWindowMs,
} from './default-config.js';
import {
  READ_COMPOSER_EXPR, FOCUS_COMPOSER_EXPR, IS_GENERATING_EXPR, STOP_GENERATION_EXPR,
  SEND_BUTTON_STATE_EXPR, DUMP_STATE_EXPR, NEW_CHAT_EXPR,
  parseQuickUrl, buildConversationUrl, isOnConversation,
  detectAccountId, buildChatUrl,
} from './page.js';

/**
 * 从 cfg 解析自适应等待参数（毫秒/秒混合）。
 * 配置缺字段时回落到内置默认值；调用方传部分 cfg 也不会炸。
 * @param {object} [cfg] 配置方案 values
 * @returns {{fastMs:number, slowMs:number, rampAfter:number, pasteVerifyBaseSec:number,
 *   pasteVerifyCapSec:number, preEnterMinMs:number, composerRetryDelayMs:number, attachSyncDelayMs:number}}
 */
function timingOpts(cfg) {
  const d = DEFAULT_PROFILE_VALUES;
  const num = (k, fb) => {
    const n = Number(cfg && cfg[k]);
    return Number.isFinite(n) && n >= 0 ? n : fb;
  };
  return {
    fastMs: Math.round(num('pollFastSec', d.pollFastSec) * 1000),
    slowMs: Math.round(num('pollSlowSec', d.pollSlowSec) * 1000),
    rampAfter: Math.max(1, Math.floor(num('pollRampAfterAttempts', d.pollRampAfterAttempts))),
    pasteVerifyBaseSec: num('pasteVerifyMaxSec', d.pasteVerifyMaxSec),
    pasteVerifyCapSec: num('pasteVerifyCapSec', d.pasteVerifyCapSec),
    preEnterMinMs: Math.round(num('preEnterMinSec', d.preEnterMinSec) * 1000),
    composerRetryDelayMs: Math.round(num('composerRetryDelaySec', d.composerRetryDelaySec) * 1000),
    attachSyncDelayMs: Math.round(num('attachSyncDelaySec', d.attachSyncDelaySec) * 1000),
  };
}

/** 可注入的 sleep（测试可替换） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读输入区状态 */
export async function readComposer(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: READ_COMPOSER_EXPR, returnByValue: true });
    return (r && r.result && r.result.value) || { ok: false, value: '' };
  } catch (e) {
    return { ok: false, value: '', error: e.message };
  }
}

/** 聚焦输入框 */
export async function focusComposer(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: FOCUS_COMPOSER_EXPR, returnByValue: true });
    return (r && r.result && r.result.value) || { ok: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 页面是否仍在生成 */
export async function isGenerating(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: IS_GENERATING_EXPR, returnByValue: true });
    return !!(r && r.result && r.result.value);
  } catch (_) { return false; }
}

/**
 * 点掉 Quick 页面的“停止生成”按钮。
 * 独立于 HTTP close 链路，供显式停止入口直接调用；找不到按钮说明本轮回合已结束。
 * @param {object} conn CDP 常驻连接
 * @returns {Promise<{ok:boolean, how?:string}>}
 */
export async function stopQuickGeneration(conn) {
  if (!conn) return { ok: false };
  try {
    const r = await conn.Runtime.evaluate({ expression: STOP_GENERATION_EXPR, returnByValue: true });
    return (r && r.result && r.result.value) || { ok: false };
  } catch (_) { return { ok: false }; }
}

/** 发送按钮状态 */
export async function sendButtonState(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: SEND_BUTTON_STATE_EXPR, returnByValue: true });
    return (r && r.result && r.result.value) || { found: false };
  } catch (_) { return { found: false }; }
}

/** 打印页面快照（排障用） */
export async function dumpState(conn, label) {
  try {
    const r = await conn.Runtime.evaluate({ expression: DUMP_STATE_EXPR, returnByValue: true });
    console.log('[Page] 快照[' + label + ']: ' + JSON.stringify((r && r.result && r.result.value) || null).slice(0, 1200));
  } catch (e) {
    console.warn('[Page] 快照失败[' + label + ']:', e.message);
  }
}

/** 当前页面 URL */
export async function currentUrl(conn) {
  try {
    const r = await conn.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
    return String((r && r.result && r.result.value) || '');
  } catch (_) { return ''; }
}

/**
 * 轮询等待输入区出现。
 * [261123-continue-fix] 导航后前 1~2 秒页面处于 loading 中间态，
 * 对异常/空结果继续重试，不直接判未就绪。
 * [261123-timing] 轮询间隔渐进退避：前几次快速探，连续未就绪再放缓，命中即退出。
 * @param {object} conn CDP 常驻连接
 * @param {number} maxSec 最长等待秒数
 * @param {object} [cfg] 配置方案 values（可选，缺省用内置默认）
 * @returns {Promise<object|null>} 输入区状态；超时返回 null
 */
export async function waitForComposer(conn, maxSec, cfg) {
  const t = timingOpts(cfg);
  const deadline = Date.now() + Math.max(1, maxSec) * 1000;
  let lastErr = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const r = await conn.Runtime.evaluate({ expression: READ_COMPOSER_EXPR, returnByValue: true });
      const v = r && r.result && r.result.value;
      if (v && v.ok) return v;
    } catch (e) {
      // 导航过渡期上下文重建，属预期，继续等
      lastErr = e.message;
    }
    await sleep(pollDelayMs(attempt++, t));
  }
  if (lastErr) console.warn('[Send] waitForComposer 超时，最后一次错误:', lastErr);
  return null;
}

/**
 * 把文本写进 textarea。
 * 用原生 value setter + input 事件，React 受控组件才会更新内部状态，
 * 否则「发送消息」按钮一直 disabled。
 */
async function fillComposer(conn, text) {
  const expr = `(() => {
    const sels = ${JSON.stringify([
      'textarea[placeholder*="提问"]', 'textarea[placeholder*="键入"]', 'textarea',
      'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]',
    ])};
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };
    let el = null;
    for (const s of sels) {
      const nodes = Array.from(document.querySelectorAll(s)).filter(visible);
      if (nodes.length) { el = nodes[nodes.length - 1]; break; }
    }
    if (!el) return { ok: false, reason: 'no-composer' };
    el.focus();
    if (el.isContentEditable) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {}
      document.execCommand('insertText', false, ${JSON.stringify(text)});
    } else {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const value = el.isContentEditable ? String(el.innerText || '') : String(el.value || '');
    return { ok: value.length > 0, wrote: value.length, expected: ${JSON.stringify(text)}.length };
  })()`;
  const r = await conn.Runtime.evaluate({ expression: expr, returnByValue: true });
  return (r && r.result && r.result.value) || { ok: false, reason: 'no-result' };
}

/** CDP 物理回车（按钮不可用时的兜底） */
async function pressEnter(conn) {
  await conn.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await conn.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

/** 点发送按钮（页面内点击，最稳定） */
async function clickSendButton(conn) {
  const r = await conn.Runtime.evaluate({
    expression: `(() => {
      const sels = ${JSON.stringify(['button[aria-label="发送消息"]', 'button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'button[data-testid*="send" i]'])};
      for (const s of sels) {
        const nodes = Array.from(document.querySelectorAll(s)).filter(n => n.offsetParent !== null);
        if (nodes.length) {
          const b = nodes[nodes.length - 1];
          if (b.disabled) return 'disabled';
          b.click();
          return 'clicked';
        }
      }
      return 'not-found';
    })()`,
    returnByValue: true,
  });
  return String((r && r.result && r.result.value) || 'error');
}

/**
 * 判定「真的发出去了」。
 * [261123-timing] 轮询间隔渐进退避，命中（进入生成中 / 输入框清空）立即返回。
 * @param {object} conn CDP 常驻连接
 * @param {boolean} hadText 发送前输入框是否有文本
 * @param {number} timeoutMs 等待窗口毫秒
 * @param {object} [cfg] 配置方案 values
 * @returns {Promise<{ok:boolean, how?:string}>}
 */
async function waitSent(conn, hadText, timeoutMs, cfg) {
  const t = timingOpts(cfg);
  const t0 = Date.now();
  let attempt = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (await isGenerating(conn)) return { ok: true, how: '页面进入生成中' };
    if (hadText) {
      const st = await readComposer(conn);
      if (!String(st.value || '').trim()) return { ok: true, how: '输入框已清空' };
    }
    await sleep(pollDelayMs(attempt++, t));
  }
  return { ok: false };
}

/**
 * 填词后核对输入框内容与预期一致；命中即退出，未命中只等到自适应窗口上限。
 * 窗口随文本长度放大（短文本用基准下限，长文本封顶），避免长 prompt 渲染慢被误判。
 * 不命中不直接判失败：后续按钮就绪检查与填词重试保底路径仍然保留。
 * @param {object} conn CDP 常驻连接
 * @param {string} expected 预期文本
 * @param {ReturnType<typeof timingOpts>} t 解析后的等待参数
 * @returns {Promise<void>}
 */
async function verifyComposerText(conn, expected, t) {
  const maxMs = pasteVerifyWindowMs(expected, t.pasteVerifyBaseSec, t.pasteVerifyCapSec);
  const deadline = Date.now() + maxMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    const st = await readComposer(conn);
    if (composerTextMatches(st.value, expected)) return;
    await sleep(pollDelayMs(attempt++, t));
  }
}

/**
 * 发一轮消息。
 * @param {object} conn CDP 常驻连接
 * @param {string} text
 * @param {object} cfg 配置方案 values
 * @param {object} [opts]
 * @param {boolean} [opts.skipPreEnterWait]
 * @param {boolean} [opts.hasAttachments]
 * @returns {Promise<{ok:boolean, error?:string, how?:string}>}
 */
export async function sendUserMessage(conn, text, cfg, opts = {}) {
  if (!text || !String(text).trim()) return { ok: false, error: '没有可发送的文本' };
  const t = timingOpts(cfg);

  // 1. 填入输入框
  await focusComposer(conn);
  let filled = await fillComposer(conn, text);
  if (!filled.ok) {
    console.warn('[Send] 首次填词失败，重试一次:', JSON.stringify(filled));
    await sleep(t.composerRetryDelayMs);
    await focusComposer(conn);
    filled = await fillComposer(conn, text);
  }
  if (!filled.ok) {
    await dumpState(conn, '填词失败');
    return { ok: false, error: '无法把文本写入输入框（' + (filled.reason || '未知') + '）' };
  }
  console.log('[Send] 已填入输入框，长度 ' + filled.wrote);

  // 1b. 自适应核对输入框内容：与预期一致立即退出，否则只等到按长度放大的窗口上限
  await verifyComposerText(conn, text, t);

  // 2. 等发送按钮可用（React 完成状态更新）；渐进退避轮询，可用即退出
  let btn = { found: false };
  const btnDeadline = Date.now() + 3000;
  let attempt = 0;
  while (Date.now() < btnDeadline) {
    btn = await sendButtonState(conn);
    if (decideSendReady(btn).ready) break;
    await sleep(pollDelayMs(attempt++, t));
  }
  if (!btn.found) console.warn('[Send] 没找到发送按钮，将回退回车');

  // 3. 回车前保底等待：只给 React 一次状态更新机会，不再默认随机长等
  if (!opts.skipPreEnterWait) {
    await sleep(t.preEnterMinMs);
  }

  const st = await readComposer(conn);
  const hadText = !!String(st.value || '').trim();
  // [261123-attach] 纯附件消息的 textarea 本来就是空的，不能因此判失败
  if (!hadText && !opts.hasAttachments) {
    await dumpState(conn, '发送前输入区为空');
    return { ok: false, error: '发送前输入区为空（内容可能被页面清掉）' };
  }
  if (!hadText && opts.hasAttachments) {
    console.log('[Send] 纯附件消息（输入框为空，但已挂附件），继续发送');
  }

  // 4. 触发发送：优先点按钮，失败回退物理回车
  //    纯附件消息没有文本可判断「输入框被清空」，只能靠「是否进入生成中」，
  //    所以等待窗口给宽一点（上传/解析附件后页面才真正开始生成）。
  const firstWait = opts.hasAttachments ? 12000 : 6000;
  const retryWait = opts.hasAttachments ? 8000 : 5000;
  let how = 'click';
  let clicked = await clickSendButton(conn);
  console.log('[Send] 点击发送按钮 -> ' + clicked);
  let sent = await waitSent(conn, hadText, firstWait, cfg);

  if (!sent.ok) {
    console.warn('[Send] 点击后未确认发送，回退 CDP 回车');
    how = 'enter';
    await focusComposer(conn);
    await pressEnter(conn);
    sent = await waitSent(conn, hadText, retryWait, cfg);
  }

  if (sent.ok) {
    console.log('[Send] 已确认发送（' + sent.how + '，方式=' + how + '）');
    return { ok: true, how };
  }

  const after = await readComposer(conn);
  if (String(after.value || '').trim()) {
    await dumpState(conn, '发送未确认');
    return { ok: false, error: '未触发发送：输入框仍有内容' };
  }
  console.warn('[Send] 未确认生成中，但输入框已空，按「已发送」继续');
  return { ok: true, how, note: 'unconfirmed' };
}

/**
 * 回到「新对话」。
 * [261123-timing] 点完新对话按钮后不再固定 sleep 1200ms，
 * 直接轮询输入区出现即返回（上限 10s），页面快就早返回。
 * @param {object} conn CDP 常驻连接
 * @param {object} [cfg] 配置方案 values
 * @returns {Promise<boolean>}
 */
export async function startNewChat(conn, cfg) {
  // 1) 首选：点页面自己的「新对话」按钮（最贴近真实用户操作）
  try {
    const r = await conn.Runtime.evaluate({ expression: NEW_CHAT_EXPR, returnByValue: true });
    const v = (r && r.result && r.result.value) || {};
    if (v.ok) {
      console.log('[Send] 已点击新对话按钮');
      // 点完之后必须确认真的到了聊天页，否则继续走兜底
      const st = await waitForComposer(conn, 10, cfg);
      if (st) return true;
      console.warn('[Send] 点了新对话但输入区没出来，改用 URL 兜底');
    }
  } catch (_) {}

  // 2) 兜底：直接导航到「当前已登录账号」的聊天页。
  // [261123-entry-fix] 旧实现导航到 "https://quick.aws.com/sn" 是错的：
  // 那是产品落地页（Features/Pricing/Sign in），永远没有输入框。
  // 正确入口是 /sn/account/<账号ID>/start/chat，账号 ID 从页面 cookie/localStorage 探测。
  // 优先用探测到的账号 ID 直接拼聊天页（最快，少一次跳转）
  try {
    const accountId = await detectAccountId(conn);
    if (accountId) {
      const url = buildChatUrl(accountId);
      console.log('[Send] 导航到聊天页:', url);
      await conn.Page.navigate({ url });
      const st = await waitForComposer(conn, Math.max(15, Math.ceil((cfg && cfg.pageReadyPollMaxSec) || 25)), cfg);
      if (st) return true;
      console.warn('[Send] 直达聊天页后输入区未就绪，改用 /sn/start 兜底');
    }
  } catch (e) {
    console.warn('[Send] 直连聊天页失败:', e.message);
  }

  // 探测不到账号 ID 时，走 /sn/start —— 页面自己会路由到正确的聊天页
  try {
    const fallback = 'https://quick.aws.com/sn/start';
    console.log('[Send] 导航到入口页:', fallback);
    await conn.Page.navigate({ url: fallback });
    const st = await waitForComposer(conn, Math.max(20, Math.ceil((cfg && cfg.pageReadyPollMaxSec) || 25)), cfg);
    if (st) return true;
    console.warn('[Send] 入口页导航后输入区仍未就绪');
    return false;
  } catch (e) {
    console.warn('[Send] 新建对话失败:', e.message);
    return false;
  }
}

/**
 * 导航到指定会话并等它真的就位。
 *
 * 为什么不能只看「输入框出现了」：Quick 是 SPA，导航是异步的，
 * textarea 在切会话过程中一直存在。必须等 URL 里的 conversationId 变成目标值，
 * 再等输入区可用，才能保证消息发到正确的会话里。
 *
 * @param {object} conn CDP 常驻连接
 * @param {string} conversationId 目标会话 ID
 * @param {object} cfg 配置方案 values
 * @returns {Promise<{ok:boolean, error?:string, url?:string}>}
 */
export async function gotoConversation(conn, conversationId, cfg) {
  const before = await currentUrl(conn);
  const { accountId } = parseQuickUrl(before);
  if (!accountId) {
    return { ok: false, error: '无法从当前 URL 解析账号 ID（当前: ' + before + '）' };
  }
  if (isOnConversation(before, conversationId)) {
    console.log('[Send] 已经在目标会话里，无需导航');
    return { ok: true, url: before, navigated: false };
  }

  const target = buildConversationUrl(accountId, conversationId);
  console.log('[Send] 导航到会话:', target);
  try {
    await conn.Page.navigate({ url: target });
  } catch (e) {
    return { ok: false, error: '导航失败: ' + e.message };
  }

  // 等 URL 里的 conversationId 变成目标值；最多等 pageReadyPollMaxSec 秒
  const t = timingOpts(cfg);
  const maxSec = Math.max(5, Math.ceil((cfg && cfg.pageReadyPollMaxSec) || 25));
  const deadline = Date.now() + maxSec * 1000;
  let urlNow = '';
  let attempt = 0;
  while (Date.now() < deadline) {
    urlNow = await currentUrl(conn);
    if (isOnConversation(urlNow, conversationId)) {
      // URL 切对之后，页面还要重新渲染一次（实测约 2~4s），
      // 这里单独给一段充裕的时间等输入区，而不是沿用上面循环的剩余时间。
      const st = await waitForComposer(conn, Math.max(15, maxSec), cfg);
      if (st) {
        console.log('[Send] 已进入会话并就绪:', urlNow);
        return { ok: true, url: urlNow, navigated: true };
      }
      return { ok: false, error: '会话 URL 已切换但输入区未就绪（已等待 ' + Math.max(15, maxSec) + 's）: ' + urlNow };
    }
    await sleep(pollDelayMs(attempt++, t));
  }
  return { ok: false, error: '导航超时：' + maxSec + 's 内 URL 未切到目标会话（当前: ' + urlNow + '，目标: ' + conversationId + '）' };
}

/**
 * 把本地文件挂到 Quick 的输入区（走页面的 input[type=file]）。
 *
 * 实测（2026-11-23）：页面本身就有一个隐藏的 input[type=file]（accept=*、multiple），
 * 用 CDP 的 DOM.setFileInputFiles 把绝对路径塞进去后，页面会自己走完上传：
 *   POST .../attachments/presigned-url
 *   POST .../dlp/internal/.../describe-user-aware
 *   POST .../invocations/files/upload/<threadId>
 * 三个都 200 后，输入区上方出现附件卡片，发送时模型能读到文件内容
 * （已用暗号实测确认：模型准确答出文件里独有的一串字符）。
 *
 * @param {object} conn CDP 常驻连接
 * @param {string[]} filePaths 本地绝对路径
 * @param {object} cfg 配置方案 values
 * @returns {Promise<{ok:boolean, error?:string, count?:number}>}
 */
export async function attachFiles(conn, filePaths, cfg) {
  const paths = (filePaths || []).filter(Boolean);
  if (!paths.length) return { ok: true, count: 0 };
  if (typeof conn.DOM === 'undefined' || !conn.DOM) {
    return { ok: false, error: 'CDP DOM 域不可用，无法注入文件' };
  }

  // 1. 找到那个隐藏的 file input
  let nodeId = null;
  try {
    const doc = await conn.DOM.getDocument({ depth: -1 });
    const found = await conn.DOM.querySelector({ nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
    nodeId = found && found.nodeId;
  } catch (e) {
    return { ok: false, error: '查找文件输入框失败: ' + e.message };
  }
  if (!nodeId) return { ok: false, error: '页面上找不到 input[type=file]（Quick 可能改版了）' };

  // 2. 记录上传请求完成情况，用来确认真的传完了。
  // 注意：requestWillBeSent 的 requestId 不含 URL，必须单独存 URL 映射；
  // 之前用 requestId 去匹配 /upload/ 永远不命中，图片又没有文件名文本，
  // 结果上传早就完成却一直等到 60s 超时。
  const uploadUrls = new Map();
  const done = new Set();
  let scope = null;
  try {
    scope = conn.createScope();
    scope.Network.requestWillBeSent((p) => {
      const u = (p.request && p.request.url) || '';
      if (/invocations\/files\/upload|attachments\/presigned-url/i.test(u)) {
        uploadUrls.set(p.requestId, u);
      }
    });
    scope.Network.loadingFinished((p) => {
      if (uploadUrls.has(p.requestId)) done.add(p.requestId);
    });
  } catch (_) {}

  // 注入前先清掉输入区残留附件：
  // Quick 点“新对话”不会自动清掉上一轮没发出去的附件，图片又会以缩略图保留。
  // 如果只追加新文件，模型会收到“旧图 + 新图”，用户看到的就是上传串图。
  const clearAttachExpr = '(() => { const bs = Array.from(document.querySelectorAll(\'button[aria-label="删除附件"]\')); for (const b of bs) b.click(); return bs.length; })()';
  let attachmentsBefore = 0;
  try {
    const r = await conn.Runtime.evaluate({ expression: clearAttachExpr, returnByValue: true });
    attachmentsBefore = Number(r && r.result && r.result.value) || 0;
    if (attachmentsBefore > 0) {
      console.log('[Send] 已清理残留附件 ' + attachmentsBefore + ' 个');
      await sleep(300);
    }
    const r2 = await conn.Runtime.evaluate({
      expression: '(() => document.querySelectorAll(\'button[aria-label="删除附件"]\').length)()',
      returnByValue: true,
    });
    attachmentsBefore = Number(r2 && r2.result && r2.result.value) || 0;
  } catch (_) {}

  // 3. 注入文件
  try {
    await conn.DOM.setFileInputFiles({ nodeId, files: paths });
    console.log('[Send] 已注入 ' + paths.length + ' 个附件，等待页面上传…');
  } catch (e) {
    if (scope) scope.close();
    return { ok: false, error: '注入文件失败: ' + e.message };
  }

  // 4. 等上传完成：看到 files/upload 请求结束，或附件卡片数量增加。
  const t = timingOpts(cfg);
  const maxSec = Math.max(30, Math.ceil((cfg && cfg.fileUploadTimeoutSec) || 60));
  const deadline = Date.now() + maxSec * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(500);
    // 依据 1：真正的 files/upload 请求已完成（presigned-url 只是拿签名）
    const uploadFinished = [...uploadUrls.entries()].some(
      ([id, url]) => done.has(id) && /invocations\/files\/upload/i.test(url),
    );
    // 依据 2：附件卡片出现。图片卡片没有文件名，所以同时看“删除附件”数量。
    let cardSeen = false;
    try {
      const names = paths.map((p) => p.split(/[\\/]/).pop()).filter(Boolean);
      const expr = '(() => { const t = document.body.innerText || ""; const byName = ' +
        JSON.stringify(names) + '.some(n => t.includes(n)); const n = document.querySelectorAll(\'button[aria-label="删除附件"]\').length; return byName || n > ' + attachmentsBefore + '; })()';
      const r = await conn.Runtime.evaluate({ expression: expr, returnByValue: true });
      cardSeen = !!(r && r.result && r.result.value);
    } catch (_) {}
    if (cardSeen || uploadFinished) { ready = true; break; }
  }

  if (scope) scope.close();
  if (!ready) return { ok: false, error: '附件上传超时（' + maxSec + 's）' };

  // 5. 再给页面一点时间把附件状态同步到发送逻辑（可配置短等待，默认 0.3s）
  await sleep(t.attachSyncDelayMs);
  console.log('[Send] 附件已就绪 ' + paths.length + ' 个');
  return { ok: true, count: paths.length };
}
