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
  /** 目标页面 URL（Amazon Quick 网页版） */
  targetUrl: 'https://quick.aws.com/sn',

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
  /** 连接聊天 WebSocket 的最长等待秒数 */
  wsConnectTimeoutSec: 30,
  /** WebSocket 握手后等待 session_established/connected 的最长秒数 */
  wsAckTimeoutSec: 40,

  // ===== 等待区间（秒，实际使用时在 [min, max] 内随机） =====
  textPasteWaitMinSec: 1.0,
  textPasteWaitMaxSec: 3.0,
  preEnterWaitMinSec: 0.8,
  preEnterWaitMaxSec: 2.5,

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
  targetUrl: '目标页面 URL',
  connectPollMaxSec: 'CDP 端口就绪超时（秒）',
  pageReadyPollMaxSec: '页面就绪超时（秒）',
  requestTimeoutSec: '请求超时（秒）',
  wsConnectTimeoutSec: 'WebSocket 连接超时（秒）',
  wsAckTimeoutSec: '会话握手超时（秒）',
  textPasteWaitMinSec: '文本粘贴等待下限（秒）',
  textPasteWaitMaxSec: '文本粘贴等待上限（秒）',
  preEnterWaitMinSec: '回车前等待下限（秒）',
  preEnterWaitMaxSec: '回车前等待上限（秒）',
  disableBackgroundThrottling: '防后台节流',
  uiPasteToInput: '同步到输入框（视觉一致）',
});

/** 数值型字段列表（校验用） */
const NUMBER_FIELDS = [
  'connectPollMaxSec', 'pageReadyPollMaxSec', 'requestTimeoutSec',
  'wsConnectTimeoutSec', 'wsAckTimeoutSec',
  'textPasteWaitMinSec', 'textPasteWaitMaxSec',
  'preEnterWaitMinSec', 'preEnterWaitMaxSec',
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
