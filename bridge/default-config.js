/**
 * 默认配置方案（不可修改）
 *
 * 时间单位统一为「秒」，支持小数（如 1.12 表示 1.12 秒）。
 * 等待类字段为区间，实际使用时在 [min, max] 内随机，模拟真人节奏。
 */

/** 默认方案字段值（不可变） */
export const DEFAULT_PROFILE_VALUES = Object.freeze({
  // ===== Chrome 组 =====
  /** Chrome 可执行文件路径；空字符串 = 自动探测 Program Files 下的两个默认路径 */
  chromePath: '',
  /** 追加的 Chrome 启动参数，如 --proxy-server=http://127.0.0.1:8080 */
  extraArgs: '',
  /**
   * 首次启动 Chrome 时打开的页面。
   *
   * [261123-entry-fix] 用 /sn/start 而不是 /sn：
   *   /sn       → 产品落地页（Features / Pricing / Sign in），永远没有输入框
   *   /sn/start → 会自动路由到 /sn/account/<账号ID>/start/chat（实测约 10s）
   * 这样不需要知道用户的账号 ID，也能进到真正的聊天页。
   */
  targetUrl: 'https://quick.aws.com/sn/start',

  // ===== 时序组（秒，支持小数） =====
  /** 等待 CDP 调试端口就绪的最长秒数 */
  connectPollMaxSec: 25,
  /** 等待页面输入框出现的最长秒数 */
  pageReadyPollMaxSec: 25,
  /**
   * 单次请求流式接收的最长秒数，超时强制结束。
   * Quick 的 agent 首轮要跑 30~90s，长任务更久，因此默认给到 900s；
   * 真正的卡死判定由 index.js 的空闲超时负责，这里只兜「永不结束」。
   */
  requestTimeoutSec: 900,
  /**
   * SSE 心跳间隔（秒）。
   * 长任务期间每隔这么久发一个 SSE 注释帧保活，
   * 避免客户端或中间代理因「长时间无数据」掐断连接。
   */
  keepAliveSec: 20,
  /**
   * 空闲超时（秒）：连续这么久「没有收到任何聊天事件」才判定卡死。
   *
   * [261123-idle-fix] 注意是「没有任何事件」——只要页面还在输出
   * （思考 / 正文 / 工具进度 / keepalive），计时器就会被重置，不会误判。
   * 旧实现只在首帧重置一次，导致 120s 后无条件超时，长回复必定撞上。
   */
  idleTimeoutSec: 180,
  /** 连接聊天 WebSocket 的最长等待秒数 */
  wsConnectTimeoutSec: 30,
  /** WebSocket 握手后等待 session_established/connected 的最长秒数 */
  wsAckTimeoutSec: 40,

  // ===== 等待区间（秒，实际使用时在 [min, max] 内随机） =====
  // [261123-timing] 以下两个旧区间已被下方自适应等待取代，仅保留以兼容老配置文件，
  // 发送编排不再消费它们；新方案以「条件命中即退出」为准，上限只作兜底。
  textPasteWaitMinSec: 1.0,
  textPasteWaitMaxSec: 3.0,
  preEnterWaitMinSec: 0.8,
  preEnterWaitMaxSec: 2.5,

  // ===== 自适应轮询与等待（秒，支持毫秒级小数；条件命中即退出） =====
  /** 轮询首次间隔（秒）：先快速探一次页面状态 */
  pollFastSec: 0.08,
  /** 轮询退避后间隔（秒）：连续未就绪时放缓，降低 CDP 压力 */
  pollSlowSec: 0.22,
  /** 前 N 次尝试使用 fast 间隔，之后退避到 slow 间隔 */
  pollRampAfterAttempts: 2,
  /** 填词后核对「输入框内容与预期一致」的基准下限（秒）；匹配上立即退出，长文本窗口按长度放大（见 pasteVerifyCapSec） */
  pasteVerifyMaxSec: 0.6,
  /** 填词核对窗口的绝对上限（秒）：长提示词按长度放大后封顶，避免 React/contenteditable 渲染慢被误判 */
  pasteVerifyCapSec: 2.0,
  /** 回车前保底等待（秒）：只给 React 一次状态更新机会，不再默认随机长等 */
  preEnterMinSec: 0.05,
  /** 填词失败、重试一次之前的等待（秒） */
  composerRetryDelaySec: 0.4,
  /** 附件挂载完成后、同步到发送逻辑的短等待（秒） */
  attachSyncDelaySec: 0.3,

  // ===== 开关组 =====
  /** 是否给 Chrome 加防后台节流参数（--disable-background-timer-throttling 等） */
  disableBackgroundThrottling: true,
  /** 是否把发送内容同时走「剪贴板粘贴」以让页面 UI 与真实链路保持一致 */
  uiPasteToInput: true,
});

/** 字段中文标签（UI 展示用） */
export const FIELD_LABELS = Object.freeze({
  chromePath: 'Chrome 路径（留空自动探测）',
  extraArgs: '额外启动参数',
  targetUrl: '启动页面 URL（/sn/start 会自动跳到聊天页）',
  connectPollMaxSec: 'CDP 端口就绪超时（秒）',
  pageReadyPollMaxSec: '页面就绪超时（秒）',
  keepAliveSec: 'SSE 心跳间隔（秒）',
  idleTimeoutSec: '空闲超时（秒，无任何事件才算卡死）',
  requestTimeoutSec: '请求总超时（秒）',
  wsConnectTimeoutSec: 'WebSocket 连接超时（秒）',
  wsAckTimeoutSec: '会话握手超时（秒）',
  textPasteWaitMinSec: '文本粘贴等待下限（秒，旧版已弃用）',
  textPasteWaitMaxSec: '文本粘贴等待上限（秒，旧版已弃用）',
  preEnterWaitMinSec: '回车前等待下限（秒，旧版已弃用）',
  preEnterWaitMaxSec: '回车前等待上限（秒，旧版已弃用）',
  pollFastSec: '轮询首次间隔（秒）',
  pollSlowSec: '轮询退避间隔（秒）',
  pollRampAfterAttempts: '轮询退避前快速尝试次数',
  pasteVerifyMaxSec: '填词核对基准下限（秒）',
  pasteVerifyCapSec: '填词核对窗口上限（秒，长文本封顶）',
  preEnterMinSec: '回车前保底等待（秒）',
  composerRetryDelaySec: '填词失败重试间隔（秒）',
  attachSyncDelaySec: '附件同步短等待（秒）',
  disableBackgroundThrottling: '防后台节流',
  uiPasteToInput: '同步到输入框（视觉一致）',
});

/** 数值型字段列表（校验用） */
const NUMBER_FIELDS = [
  'connectPollMaxSec', 'pageReadyPollMaxSec', 'requestTimeoutSec',
  'keepAliveSec', 'idleTimeoutSec',
  'wsConnectTimeoutSec', 'wsAckTimeoutSec',
  'textPasteWaitMinSec', 'textPasteWaitMaxSec',
  'preEnterWaitMinSec', 'preEnterWaitMaxSec',
  'pollFastSec', 'pollSlowSec', 'pollRampAfterAttempts',
  'pasteVerifyMaxSec', 'pasteVerifyCapSec',
  'preEnterMinSec',
  'composerRetryDelaySec', 'attachSyncDelaySec',
];

/** 区间字段对：[min, max, 描述] */
const RANGE_PAIRS = [
  ['textPasteWaitMinSec', 'textPasteWaitMaxSec', '文本粘贴等待'],
  ['preEnterWaitMinSec', 'preEnterWaitMaxSec', '回车前等待'],
];

/** 布尔字段 */
const BOOL_FIELDS = ['disableBackgroundThrottling', 'uiPasteToInput'];

/**
 * 校验方案 values，不合法抛异常。
 * 缺失字段用默认值补齐（向前兼容老方案）。
 * @param {object} values 待校验的 values
 * @returns {object} 规范化后的新对象（含全部字段）
 */
export function validateProfile(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('配置内容必须是对象');
  }
  const out = { ...DEFAULT_PROFILE_VALUES };
  for (const k of Object.keys(DEFAULT_PROFILE_VALUES)) {
    if (values[k] !== undefined) out[k] = values[k];
  }

  for (const k of ['chromePath', 'extraArgs', 'targetUrl']) {
    if (typeof out[k] !== 'string') throw new Error('字段 ' + k + ' 必须是字符串');
  }
  if (!out.targetUrl.trim()) throw new Error('目标页面 URL 不能为空');

  for (const k of NUMBER_FIELDS) {
    const n = Number(out[k]);
    if (!Number.isFinite(n) || n < 0) throw new Error('字段 ' + k + ' 必须是非负数字');
    out[k] = n;
  }

  for (const k of BOOL_FIELDS) {
    if (typeof out[k] !== 'boolean') throw new Error('字段 ' + k + ' 必须是布尔值');
  }

  for (const [minK, maxK, label] of RANGE_PAIRS) {
    if (out[minK] > out[maxK]) throw new Error(label + '的下限不能大于上限');
  }

  // 自适应轮询的兜底规整：快速间隔不能大于退避间隔；快速阶段次数至少为 1
  if (out.pollFastSec > out.pollSlowSec) {
    const swap = out.pollFastSec;
    out.pollFastSec = out.pollSlowSec;
    out.pollSlowSec = swap;
  }
  out.pollRampAfterAttempts = Math.max(1, Math.floor(out.pollRampAfterAttempts));
  // 核对窗口上限不能低于基准下限
  if (out.pasteVerifyCapSec < out.pasteVerifyMaxSec) out.pasteVerifyCapSec = out.pasteVerifyMaxSec;

  return out;
}

/**
 * 在 [min, max] 区间内取随机数（秒 → 毫秒）。
 * @param {number} minSec 下限秒
 * @param {number} maxSec 上限秒
 * @returns {number} 毫秒整数
 */
export function randomInRange(minSec, maxSec) {
  const lo = Math.min(minSec, maxSec);
  const hi = Math.max(minSec, maxSec);
  return Math.round(lo * 1000 + Math.random() * (hi - lo) * 1000);
}

/**
 * 归一化输入框文本：折叠连续空白、去首尾空白，便于比对。
 * @param {string} s 原始文本
 * @returns {string} 归一化后的文本
 */
export function normalizeComposerText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * 判定填词结果是否与预期一致。
 * 富文本编辑器可能规范化换行/空白，因此命中条件为：完全相等、包含预期文本，
 * 或预期文本被轻微截断（长度达到预期 90% 以上）。
 * @param {string} composerValue 输入框当前内容
 * @param {string} expected 预期文本
 * @returns {boolean}
 */
export function composerTextMatches(composerValue, expected) {
  const v = normalizeComposerText(composerValue);
  const e = normalizeComposerText(expected);
  if (!e) return false;
  if (!v) return false;
  if (v === e) return true;
  if (v.includes(e)) return true;
  return e.includes(v) && v.length >= Math.floor(e.length * 0.9);
}

/**
 * 按文本长度自适应填词核对窗口（毫秒）。
 * 短文本用基准下限；长文本按「每 charsPerSec 字放大 1 秒」线性放大；封顶 capSec。
 * 匹配上仍立即退出，窗口只兜底 React/contenteditable 渲染慢的情况。
 * @param {string} text 预期填入的文本
 * @param {number} baseSec 基准下限秒（配置 pasteVerifyMaxSec）
 * @param {number} capSec 绝对上限秒（配置 pasteVerifyCapSec）
 * @param {number} [charsPerSec] 每多少字放大 1 秒，默认 300
 * @returns {number} 毫秒整数
 */
export function pasteVerifyWindowMs(text, baseSec, capSec, charsPerSec = 300) {
  const len = String(text || '').length;
  const baseMs = Math.max(0, baseSec) * 1000;
  const capMs = Math.max(baseMs, Math.max(0, capSec) * 1000);
  const per = Number.isFinite(charsPerSec) && charsPerSec > 0 ? charsPerSec : 300;
  const scaledMs = (len / per) * 1000;
  return Math.round(Math.min(capMs, Math.max(baseMs, scaledMs)));
}

/**
 * 渐进退避轮询间隔（毫秒）：前 rampAfter 次用 fastMs，之后退避到 slowMs。
 * @param {number} attempt 第几次尝试（从 0 开始）
 * @param {object} opts
 * @param {number} opts.fastMs 快速间隔毫秒
 * @param {number} opts.slowMs 退避间隔毫秒
 * @param {number} opts.rampAfter 快速阶段次数
 * @returns {number} 毫秒整数
 */
export function pollDelayMs(attempt, { fastMs, slowMs, rampAfter }) {
  const lo = Math.min(Math.max(0, fastMs), Math.max(0, slowMs));
  const hi = Math.max(Math.max(0, fastMs), Math.max(0, slowMs));
  const after = Number.isFinite(rampAfter) && rampAfter > 0 ? Math.floor(rampAfter) : 2;
  return Math.round(attempt < after ? lo : hi);
}

/**
 * 判定「发送按钮就绪」：按钮已找到且未禁用。
 * 纯附件消息没有文本可比对，就绪只看按钮状态。
 * @param {object} state
 * @param {boolean} state.found 是否找到发送按钮
 * @param {boolean} state.disabled 按钮是否禁用
 * @returns {{ready:boolean, reason:string}}
 */
export function decideSendReady(state) {
  if (state.found && !state.disabled) return { ready: true, reason: '按钮可用' };
  if (!state.found) return { ready: false, reason: '未找到发送按钮' };
  return { ready: false, reason: '发送按钮禁用中' };
}

/**
 * 沿状态序列找首次就绪的样本下标（纯函数，便于单测「给定序列断言退出时机」）。
 * @param {Array<object>} samples 每次轮询拿到的状态样本
 * @param {(s:object)=>boolean} predicate 就绪判定
 * @returns {{ready:boolean, index:number}} index 为首次就绪样本下标；未就绪为 -1
 */
export function firstReadyIndex(samples, predicate) {
  for (let i = 0; i < samples.length; i++) {
    if (predicate(samples[i])) return { ready: true, index: i };
  }
  return { ready: false, index: -1 };
}
