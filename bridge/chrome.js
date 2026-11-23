/**
 * Chrome 启动与目标页面发现
 *
 * 每个账号独立 --user-data-dir + 独立 --remote-debugging-port，
 * 账号之间登录态互不干扰。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { PROFILES_DIR } from './store.js';

const DEFAULT_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/** 解析 Chrome 可执行文件路径 */
export function resolveChromePath(cfg) {
  const configured = String((cfg && cfg.chromePath) || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  return DEFAULT_CHROME_PATHS.find(p => fs.existsSync(p)) || null;
}

/** 探测调试端口是否已就绪 */
export async function probePort(port, timeoutMs = 500) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch (_) {
    return false;
  }
}

/** 轮询等待端口就绪 */
export async function waitForPort(port, maxSec) {
  const max = Math.max(1, Math.ceil(maxSec));
  for (let i = 0; i < max; i++) {
    if (await probePort(port)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * 启动 Chrome。
 * @param {object} account 账号（modelId / debugPort）
 * @param {object} cfg 生效的配置方案 values
 * @param {string} [targetUrl] 覆盖默认 URL
 */
export function launchChrome(account, cfg, targetUrl) {
  const chromePath = resolveChromePath(cfg);
  if (!chromePath) {
    console.error('[Chrome] 未找到 chrome.exe，请在配置方案里指定 chromePath');
    return false;
  }

  const userDataDir = path.join(PROFILES_DIR, account.modelId);
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  // [261123-entry-fix] 兜底用 /sn/start：它会自动路由到带账号 ID 的聊天页；
  // 旧的 /sn 是产品落地页，没有输入框。
  const url = targetUrl || (cfg && cfg.targetUrl) || 'https://quick.aws.com/sn/start';
  const extraArgs = String((cfg && cfg.extraArgs) || '').trim();
  const antiThrottle = !!(cfg && cfg.disableBackgroundThrottling);

  const argsArr = [
    '--user-data-dir=' + userDataDir,
    '--remote-debugging-port=' + account.debugPort,
    '--enable-logging=stderr',
    '--no-first-run',
    '--no-default-browser-check',
    ...(antiThrottle ? [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ] : []),
    ...(extraArgs.match(/(?:"[^"]*"|'[^']*'|\S+)/g) || []).map(x => x.replace(/^["']|["']$/g, '')),
    url,
  ];

  console.log('[Chrome] 启动账号 ' + account.modelId + '，端口 ' + account.debugPort);
  let child;
  try {
    child = spawn(chromePath, argsArr, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    console.error('[Chrome] spawn 失败:', err.message);
    return false;
  }
  let chromeErr = '';
  let retried = false;
  const launchViaShell = () => {
    try {
      const quoted = argsArr.map(x => "'" + String(x).replace(/'/g, "''") + "'").join(',');
      const ps = "Start-Process -FilePath '" + chromePath.replace(/'/g, "''") + "' -ArgumentList @(" + quoted + ')';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true }, (err) => {
        if (err) console.error('[Chrome] ShellExecute 兜底失败:', err.message.split('\n')[0]);
        else console.log('[Chrome] 已通过 ShellExecute 兜底启动');
      });
    } catch (e) { console.error('[Chrome] ShellExecute 兜底异常:', e.message); }
  };
  child.stderr.on('data', (d) => { chromeErr = (chromeErr + d.toString()).slice(-8000); });
  child.on('error', (err) => console.error('[Chrome] 启动进程失败:', err.message));
  child.on('exit', (code, signal) => {
    if (code === 0 && !signal) return;
    console.error('[Chrome] 启动失败: code=' + code + ' signal=' + signal);
    if (chromeErr.trim()) console.error('[Chrome] Chrome stderr:\n' + chromeErr.slice(0, 4000));
    if (!retried) {
      retried = true;
      console.warn('[Chrome] 改用 ShellExecute 兜底重试');
      launchViaShell();
    }
  });
  child.unref();
  return true;
}

/**
 * 确保账号的 Chrome 在跑且目标页面可达；必要时启动并等待。
 * @returns {Promise<boolean>}
 */
export async function ensureChrome(account, cfg, targetUrl) {
  if (await probePort(account.debugPort)) return true;
  console.log('[Chrome] 账号 ' + account.modelId + ' 端口不通，启动 Chrome…');
  launchChrome(account, cfg, targetUrl);
  const ok = await waitForPort(account.debugPort, (cfg && cfg.connectPollMaxSec) || 25);
  if (!ok) console.error('[Chrome] 账号 ' + account.modelId + ' 启动超时');
  return ok;
}

/**
 * 确保账号的 CDP 连接可用，必要时自动启动 Chrome。
 *
 * [261123-autolaunch] 为什么需要它：
 * 请求路径原先直接 getConnection()，端口不通就抛 ECONNREFUSED 给客户端，
 * 表现成「Provider 内部错误」。但 Chrome 完全可能被用户关掉（重启电脑、
 * 手滑关窗），这时应该自动拉起来，而不是让客户端一直报错。
 *
 * 流程：
 *   1. 端口活着 → 直接取连接（最常见，零开销）
 *   2. 端口不通 → 启动 Chrome → 等端口就绪 → 取连接
 *   3. 还失败 → 抛出带操作提示的错误
 *
 * @param {object} account 账号（modelId / debugPort）
 * @param {object} cfg 生效配置方案 values
 * @param {(account:object, match:string)=>Promise<object>} getConnectionFn getConnection 实现
 * @param {string} [targetMatch] 目标页面 URL 片段
 * @returns {Promise<object>} CDP 连接
 */
export async function ensureConnection(account, cfg, getConnectionFn, targetMatch = 'quick.aws.com') {
  // 1) 端口活着就直接连
  if (await probePort(account.debugPort)) {
    return await getConnectionFn(account, targetMatch);
  }

  // 2) 端口不通 → 启动 Chrome 再连
  console.log('[Chrome] 账号 ' + account.modelId + ' 调试端口 ' + account.debugPort + ' 不通，自动启动 Chrome…');
  const ok = await ensureChrome(account, cfg);
  if (!ok) {
    throw new Error([
      '无法启动 Chrome（端口 ' + account.debugPort + '）。请检查：',
      '  1) 本机是否安装了 Chrome（或在配置方案里指定 chromePath）',
      '  2) 该账号的 Chrome 是否被其它进程占用',
      '  3) 首次使用需要在弹出的窗口里登录 quick.aws.com',
    ].join('\\n'));
  }
  console.log('[Chrome] 账号 ' + account.modelId + ' 已启动，端口就绪');

  // 3) 连上它
  return await getConnectionFn(account, targetMatch);
}
