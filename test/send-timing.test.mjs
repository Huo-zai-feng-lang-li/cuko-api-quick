/**
 * 发送时序自适应等待：决策纯函数 + 配置向前兼容回归测试
 *
 * 覆盖：
 *  - 旧配置文件（缺新字段）仍能通过 validateProfile，并取到新默认值
 *  - 填词内容核对、发送按钮就绪判定、渐进退避轮询、状态序列退出时机
 *  - sendUserMessage 愉快路径接线：填词 → 按钮就绪 → 点击 → 进入生成中
 *
 * 运行：npm test
 */
import {
  DEFAULT_PROFILE_VALUES, validateProfile,
  composerTextMatches, normalizeComposerText,
  pollDelayMs, decideSendReady, firstReadyIndex, pasteVerifyWindowMs,
} from '../bridge/default-config.js';
import {
  READ_COMPOSER_EXPR, FOCUS_COMPOSER_EXPR, IS_GENERATING_EXPR, SEND_BUTTON_STATE_EXPR,
} from '../bridge/page.js';
import { sendUserMessage } from '../bridge/quick-sender.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

// ============ 配置向前兼容 ============

test('空配置校验通过，新字段回落内置默认值', () => {
  const v = validateProfile({});
  assert.equal(v.pollFastSec, DEFAULT_PROFILE_VALUES.pollFastSec);
  assert.equal(v.pollSlowSec, DEFAULT_PROFILE_VALUES.pollSlowSec);
  assert.equal(v.pollRampAfterAttempts, DEFAULT_PROFILE_VALUES.pollRampAfterAttempts);
  assert.equal(v.pasteVerifyMaxSec, DEFAULT_PROFILE_VALUES.pasteVerifyMaxSec);
  assert.equal(v.preEnterMinSec, DEFAULT_PROFILE_VALUES.preEnterMinSec);
  assert.equal(v.composerRetryDelaySec, DEFAULT_PROFILE_VALUES.composerRetryDelaySec);
  assert.equal(v.attachSyncDelaySec, DEFAULT_PROFILE_VALUES.attachSyncDelaySec);
});

test('旧配置只带旧等待字段时仍通过，新字段取默认、旧字段保留', () => {
  const v = validateProfile({
    textPasteWaitMinSec: 1, textPasteWaitMaxSec: 3,
    preEnterWaitMinSec: 0.8, preEnterWaitMaxSec: 2.5,
  });
  assert.equal(v.textPasteWaitMinSec, 1);
  assert.equal(v.preEnterWaitMaxSec, 2.5);
  assert.equal(v.pasteVerifyMaxSec, DEFAULT_PROFILE_VALUES.pasteVerifyMaxSec);
  assert.equal(v.preEnterMinSec, DEFAULT_PROFILE_VALUES.preEnterMinSec);
});

test('新字段合法值被接受并保留', () => {
  const v = validateProfile({ pollFastSec: 0.05, pollSlowSec: 0.2, pasteVerifyMaxSec: 1.2 });
  assert.equal(v.pollFastSec, 0.05);
  assert.equal(v.pollSlowSec, 0.2);
  assert.equal(v.pasteVerifyMaxSec, 1.2);
});

test('新字段负数被拒绝', () => {
  let threw = false;
  try { validateProfile({ pollSlowSec: -1 }); } catch { threw = true; }
  assert.ok(threw, '负数应该被拒绝');
});

test('快速间隔大于退避间隔时自动交换', () => {
  const v = validateProfile({ pollFastSec: 0.3, pollSlowSec: 0.05 });
  assert.ok(v.pollFastSec <= v.pollSlowSec, 'fast 不应大于 slow');
  assert.equal(v.pollFastSec, 0.05);
  assert.equal(v.pollSlowSec, 0.3);
});

test('退避前快速次数被规整为至少 1', () => {
  const v = validateProfile({ pollRampAfterAttempts: 0 });
  assert.equal(v.pollRampAfterAttempts, 1);
});

// ============ 填词内容核对 ============

test('内容核对：完全相等命中', () => {
  assert.equal(composerTextMatches('你好世界', '你好世界'), true);
});

test('内容核对：换行/多空白被折叠后命中', () => {
  assert.equal(composerTextMatches('你好\n  世界', '你好 世界'), true);
});

test('内容核对：输入框包含预期文本命中', () => {
  assert.equal(composerTextMatches('你好世界啊', '你好世界'), true);
});

test('内容核对：预期文本被轻微截断（>=90%）仍命中', () => {
  const expected = '一二三四五六七八九十'; // 10 字
  assert.equal(composerTextMatches(expected.slice(0, 9), expected), true);
});

test('内容核对：内容不符不命中', () => {
  assert.equal(composerTextMatches('别的内容', '你好世界'), false);
});

test('内容核对：预期为空不命中', () => {
  assert.equal(composerTextMatches('随便', ''), false);
});

test('归一化：折叠连续空白', () => {
  assert.equal(normalizeComposerText('  a\t b\n c '), 'a b c');
});

// ============ 填词核对窗口：随文本长度自适应 ============

test('核对窗口：短文本用基准下限 0.6s', () => {
  assert.equal(pasteVerifyWindowMs('你好', 0.6, 2.0), 600);
});

test('核对窗口：空文本回落基准下限', () => {
  assert.equal(pasteVerifyWindowMs('', 0.6, 2.0), 600);
});

test('核对窗口：中等长度按长度线性放大（300 字 → 1.0s）', () => {
  assert.equal(pasteVerifyWindowMs('x'.repeat(300), 0.6, 2.0), 1000);
});

test('核对窗口：长文本封顶不超过 2.0s', () => {
  assert.equal(pasteVerifyWindowMs('x'.repeat(600), 0.6, 2.0), 2000);
  assert.equal(pasteVerifyWindowMs('x'.repeat(1000), 0.6, 2.0), 2000);
});

test('核对窗口：上限低于下限时规整为下限', () => {
  const v = validateProfile({ pasteVerifyCapSec: 0.3, pasteVerifyMaxSec: 0.6 });
  assert.equal(v.pasteVerifyCapSec, 0.6);
});

test('核对窗口：新上限字段缺省时取默认 2.0s', () => {
  const v = validateProfile({});
  assert.equal(v.pasteVerifyCapSec, DEFAULT_PROFILE_VALUES.pasteVerifyCapSec);
  assert.equal(DEFAULT_PROFILE_VALUES.pasteVerifyCapSec, 2.0);
});

// ============ 渐进退避轮询 ============

test('退避：前 N 次用快速间隔，之后放缓', () => {
  const opts = { fastMs: 80, slowMs: 220, rampAfter: 2 };
  assert.equal(pollDelayMs(0, opts), 80);
  assert.equal(pollDelayMs(1, opts), 80);
  assert.equal(pollDelayMs(2, opts), 220);
  assert.equal(pollDelayMs(3, opts), 220);
});

test('退避：fast/slow 顺序颠倒也按最小/最大值取间隔', () => {
  const opts = { fastMs: 220, slowMs: 80, rampAfter: 1 };
  assert.equal(pollDelayMs(0, opts), 80);
  assert.equal(pollDelayMs(1, opts), 220);
});

// ============ 就绪判定 ============

test('按钮就绪：找到且未禁用', () => {
  assert.equal(decideSendReady({ found: true, disabled: false }).ready, true);
});

test('按钮就绪：未找到不算就绪', () => {
  assert.equal(decideSendReady({ found: false, disabled: false }).ready, false);
});

test('按钮就绪：禁用中不算就绪', () => {
  assert.equal(decideSendReady({ found: true, disabled: true }).ready, false);
});

test('状态序列：首个就绪样本即退出', () => {
  const samples = [
    { ready: false }, { ready: false }, { ready: true }, { ready: true },
  ];
  const r = firstReadyIndex(samples, (s) => s.ready);
  assert.equal(r.ready, true);
  assert.equal(r.index, 2);
});

test('状态序列：全程未就绪返回 -1', () => {
  const samples = [{ ready: false }, { ready: false }];
  const r = firstReadyIndex(samples, (s) => s.ready);
  assert.equal(r.ready, false);
  assert.equal(r.index, -1);
});

// ============ sendUserMessage 愉快路径接线（假 CDP 连接） ============

/**
 * 构造脚本化假 conn：按表达式匹配返回预设页面状态。
 * @param {Array<{match:(e:string)=>boolean, value:any}>} handlers
 */
function fakeConn(handlers) {
  return {
    Runtime: {
      async evaluate({ expression }) {
        for (const h of handlers) {
          if (h.match(expression)) return { result: { value: h.value } };
        }
        return { result: { value: { ok: false } } };
      },
    },
  };
}

test('发送：文本填词成功 → 按钮就绪 → 点击 → 进入生成中，返回 ok', async () => {
  const conn = fakeConn([
    { match: (e) => e === FOCUS_COMPOSER_EXPR, value: { ok: true } },
    { match: (e) => e.includes('insertText') || e.includes('setter'), value: { ok: true, wrote: 2 } },
    { match: (e) => e === READ_COMPOSER_EXPR, value: { ok: true, value: '你好' } },
    { match: (e) => e === SEND_BUTTON_STATE_EXPR, value: { found: true, disabled: false } },
    { match: (e) => e.includes('aria-label="发送消息"'), value: 'clicked' },
    { match: (e) => e === IS_GENERATING_EXPR, value: true },
  ]);
  const r = await sendUserMessage(conn, '你好', {}, { skipPreEnterWait: true });
  assert.equal(r.ok, true);
  assert.equal(r.how, 'click');
});

test('发送：空文本直接拒绝，不触碰页面', async () => {
  let touched = false;
  const conn = { Runtime: { async evaluate() { touched = true; return { result: { value: {} } }; } } };
  const r = await sendUserMessage(conn, '   ', {}, {});
  assert.equal(r.ok, false);
  assert.equal(touched, false);
});
