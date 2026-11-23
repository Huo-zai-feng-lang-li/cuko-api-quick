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
import { randomInRange } from './default-config.js';
import {
  READ_COMPOSER_EXPR, FOCUS_COMPOSER_EXPR, IS_GENERATING_EXPR,
  SEND_BUTTON_STATE_EXPR, DUMP_STATE_EXPR, NEW_CHAT_EXPR,
} from './page.js';

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

/** 轮询等待输入区出现 */
export async function waitForComposer(conn, maxSec) {
  const max = Math.max(1, Math.ceil(maxSec));
  for (let i = 0; i < max; i++) {
    const st = await readComposer(conn);
    if (st.ok) return st;
    await new Promise(r => setTimeout(r, 1000));
  }
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

/** 判定「真的发出去了」 */
async function waitSent(conn, hadText, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isGenerating(conn)) return { ok: true, how: '页面进入生成中' };
    if (hadText) {
      const st = await readComposer(conn);
      if (!String(st.value || '').trim()) return { ok: true, how: '输入框已清空' };
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return { ok: false };
}

/**
 * 发一轮消息。
 * @param {object} conn CDP 常驻连接
 * @param {string} text
 * @param {object} cfg 配置方案 values
 * @param {object} [opts]
 * @param {boolean} [opts.skipPreEnterWait]
 * @returns {Promise<{ok:boolean, error?:string, how?:string}>}
 */
export async function sendUserMessage(conn, text, cfg, opts = {}) {
  if (!text || !String(text).trim()) return { ok: false, error: '没有可发送的文本' };

  // 1. 填入输入框
  await focusComposer(conn);
  let filled = await fillComposer(conn, text);
  if (!filled.ok) {
    console.warn('[Send] 首次填词失败，重试一次:', JSON.stringify(filled));
    await new Promise(r => setTimeout(r, 800));
    await focusComposer(conn);
    filled = await fillComposer(conn, text);
  }
  if (!filled.ok) {
    await dumpState(conn, '填词失败');
    return { ok: false, error: '无法把文本写入输入框（' + (filled.reason || '未知') + '）' };
  }
  console.log('[Send] 已填入输入框，长度 ' + filled.wrote);

  // 2. 等发送按钮可用（React 完成状态更新）
  let btn = { found: false };
  for (let i = 0; i < 20; i++) {
    btn = await sendButtonState(conn);
    if (btn.found && !btn.disabled) break;
    await new Promise(r => setTimeout(r, 150));
  }
  if (!btn.found) console.warn('[Send] 没找到发送按钮，将回退回车');

  // 3. 回车前随机等待（模拟真人节奏）
  if (!opts.skipPreEnterWait) {
    const waitMs = randomInRange(cfg.preEnterWaitMinSec, cfg.preEnterWaitMaxSec);
    await new Promise(r => setTimeout(r, waitMs));
  }

  const st = await readComposer(conn);
  const hadText = !!String(st.value || '').trim();
  if (!hadText) {
    await dumpState(conn, '发送前输入区为空');
    return { ok: false, error: '发送前输入区为空（内容可能被页面清掉）' };
  }

  // 4. 触发发送：优先点按钮，失败回退物理回车
  let how = 'click';
  let clicked = await clickSendButton(conn);
  console.log('[Send] 点击发送按钮 -> ' + clicked);
  let sent = await waitSent(conn, hadText, 6000);

  if (!sent.ok) {
    console.warn('[Send] 点击后未确认发送，回退 CDP 回车');
    how = 'enter';
    await focusComposer(conn);
    await pressEnter(conn);
    sent = await waitSent(conn, hadText, 5000);
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

/** 回到「新对话」 */
export async function startNewChat(conn, cfg) {
  try {
    const r = await conn.Runtime.evaluate({ expression: NEW_CHAT_EXPR, returnByValue: true });
    const v = (r && r.result && r.result.value) || {};
    if (v.ok) {
      console.log('[Send] 已点击新对话按钮');
      await new Promise(res => setTimeout(res, 1200));
      return true;
    }
  } catch (_) {}
  try {
    await conn.Page.navigate({ url: 'https://quick.aws.com/sn' });
    await new Promise(res => setTimeout(res, 2000));
    return true;
  } catch (e) {
    console.warn('[Send] 新建对话失败:', e.message);
    return false;
  }
}
