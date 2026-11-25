/**
 * Chrome 启动与目标页面发现
 *
 * 每个账号独立 --user-data-dir + 独立 --remote-debugging-port，
 * 账号之间登录态互不干扰。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { PROFILES_DIR } from './store.js';
import { commandLineMatchesProfile } from './profile-check.js';

const DEFAULT_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/**
 * 正在删除的账号。
 * 删除时 taskkill 会让 launchChrome 的 exit 回调看到非 0 退出码，
 * 如果不拦住，它会误以为“启动失败”又用 ShellExecute 拉起一个新 Chrome，
 * 结果刚删掉的账号窗口又回来了，profile 目录也删不干净。
 */
const closingAccounts = new Set();

/** 本进程刚拉起、可能还没打开调试端口的 Chrome 子进程 */
const launchedChildren = new Map();

/** 同一账号并发的“补开页签”只做一次，避免一次断页开出多个重复页 */
const openingTargets = new Map();

/**
 * 目标页缺失的可识别错误；只有这类错误才触发自愈。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTargetMissingError(err) {
  const text = String((err && err.message) || err || '');
  return text.includes('找不到目标页面 target') || text.includes('target_not_found');
}

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

/**
 * 判断 TCP 端口是否能被本进程监听。
 *
 * 比 probePort 更严格：只要有任何程序占着端口就返回 false。
 * 端口分配不能只看“Chrome 调试接口通不通”，否则普通服务占着 9222 时，
 * 会把一个根本起不来的端口分给新账号，Chrome 启动直接失败。
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
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
  if (closingAccounts.has(account.modelId)) {
    console.warn('[Chrome] 账号正在删除，取消启动:', account.modelId);
    return false;
  }
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
  const startedAt = Date.now();
  const launchViaShell = () => {
    if (closingAccounts.has(account.modelId)) return;
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
  launchedChildren.set(account.modelId, child);
  child.on('exit', (code, signal) => {
    if (launchedChildren.get(account.modelId) === child) launchedChildren.delete(account.modelId);
    // 删除账号时会主动 taskkill，这不是“启动失败”，绝不能兜底重启
    if (closingAccounts.has(account.modelId)) {
      console.log('[Chrome] 账号正在删除，忽略进程退出:', account.modelId);
      return;
    }
    if (code === 0 && !signal) return;
    console.error('[Chrome] 启动失败: code=' + code + ' signal=' + signal);
    if (chromeErr.trim()) console.error('[Chrome] Chrome stderr:\n' + chromeErr.slice(0, 4000));
    // 只在启动初期失败时重试；已经跑起来后的非 0 退出多半是崩溃/被关掉，
    // 再拉一次容易和删除流程抢同一个 profile。
    const earlyFailure = Date.now() - startedAt < 20000;
    if (!retried && earlyFailure) {
      retried = true;
      console.warn('[Chrome] 改用 ShellExecute 兜底重试');
      launchViaShell();
    }
  });
  child.unref();
  return true;
}

/**
 * 确保账号的 Chrome 在跑；必要时启动并等待端口。
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
 * 用 Chrome DevTools HTTP 接口新开一个页签。
 *
 * 为什么不用 CDP.New：这里只需要一个 HTTP 请求，失败信息更直接；
 * /json/new 是 Chrome 官方调试端点，支持 PUT，返回新 target 的 JSON。
 *
 * @param {object} account
 * @param {object} cfg
 * @returns {Promise<object>} 新 target
 */
export async function openTarget(account, cfg) {
  const url = (cfg && cfg.targetUrl) || 'https://quick.aws.com/sn/start';
  const endpoint = 'http://127.0.0.1:' + account.debugPort + '/json/new?' + encodeURIComponent(url);
  const r = await fetch(endpoint, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('打开新页签失败：HTTP ' + r.status + ' ' + endpoint);
  return await r.json().catch(() => ({}));
}

/**
 * 读取调试端口上的全部 target（页面 / browser 等）。
 * 端口不通或接口异常时返回空数组，调用方按「无页签」处理。
 * @param {number} port
 * @returns {Promise<Array<object>>}
 */
export async function listTargets(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/list', {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

/**
 * 等待目标页出现。
 * @param {number} port
 * @param {string} targetMatch
 * @param {number} [maxSec]
 * @returns {Promise<object|null>}
 */
export async function waitForTarget(port, targetMatch, maxSec = 6) {
  const max = Math.max(1, Math.ceil(maxSec));
  for (let i = 0; i < max * 4; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(700) });
      if (r.ok) {
        const list = await r.json();
        const target = (Array.isArray(list) ? list : []).find(
          t => t.type === 'page' && String(t.url || '').includes(targetMatch),
        );
        if (target) return target;
      }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * 端口活着但 Quick 页签被用户关掉时，补开一个页签。
 * 同一账号并发请求只补开一次。
 *
 * @param {object} account
 * @param {object} cfg
 * @param {string} targetMatch
 * @returns {Promise<object>} 目标 target
 */
export async function reopenTarget(account, cfg, targetMatch = 'quick.aws.com') {
  const existing = openingTargets.get(account.modelId);
  if (existing) return existing;

  const task = (async () => {
    console.log('[Chrome] 账号 ' + account.modelId + ' 的目标页丢失，自动补开…');
    const opened = await openTarget(account, cfg);
    const target = await waitForTarget(account.debugPort, targetMatch, (cfg && cfg.pageReadyPollMaxSec) || 10);
    if (!target) {
      // 补开后目标页没出现（加载失败/被立刻关掉），把刚开出来的页签关掉，避免累积垃圾页签。
      if (opened && opened.id) {
        try {
          await fetch('http://127.0.0.1:' + account.debugPort + '/json/close/' + encodeURIComponent(opened.id), {
            signal: AbortSignal.timeout(1000),
          });
        } catch (_) {}
      }
      throw new Error('已尝试补开页签，但目标页仍未出现（' + targetMatch + '）');
    }
    console.log('[Chrome] 账号 ' + account.modelId + ' 已补开目标页:', target.url);
    // 自愈补开后顺手去重，避免历史重复页签越积越多
    await dedupeQuickTabs(account, targetMatch).catch(() => {});
    return target;
  })();

  openingTargets.set(account.modelId, task);
  try {
    return await task;
  } finally {
    openingTargets.delete(account.modelId);
  }
}

/**
 * 确保账号的 CDP 连接可用，必要时自动启动 Chrome。
 *
 * [261123-autolaunch] 为什么需要它：
 * 请求路径原先直接 getConnection()，端口不通就抛 ECONNREFUSED 给客户端，
 * 表现成「Provider 内部错误」。但 Chrome 完全可能被用户关掉（重启电脑、
 * 手滑关窗），这时应该自动拉起来，而不是让客户端一直报错。
 *
 * [261123-tab-heal] 新增：端口还在、浏览器进程也在，但 Quick 页签被关掉时，
 * 直接走 /json/new 补开页签。用户不需要重启浏览器。
 *
 * 流程：
 *   1. 端口活着 → 取连接
 *   2. 连接报“找不到目标 target” → 补开页签 → 等 target → 重连
 *   3. 端口不通 → 启动 Chrome → 等端口就绪 → 取连接
 *   4. 还失败 → 抛出带操作提示的错误
 *
 * @param {object} account 账号（modelId / debugPort）
 * @param {object} cfg 生效配置方案 values
 * @param {(account:object, match:string)=>Promise<object>} getConnectionFn getConnection 实现
 * @param {string} [targetMatch] 目标页面 URL 片段
 * @returns {Promise<object>} CDP 连接
 */
export async function ensureConnection(account, cfg, getConnectionFn, targetMatch = 'quick.aws.com') {
  // 1) 端口活着 → 取连接；若页签被关，补开一次再重试
  if (await probePort(account.debugPort)) {
    try {
      return await getConnectionFn(account, targetMatch);
    } catch (err) {
      if (!isTargetMissingError(err)) throw err;
      await reopenTarget(account, cfg, targetMatch);
      return await getConnectionFn(account, targetMatch);
    }
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

  // 3) 连上它；启动后页签也可能没加载出来，补开一次
  try {
    return await getConnectionFn(account, targetMatch);
  } catch (err) {
    if (!isTargetMissingError(err)) throw err;
    await reopenTarget(account, cfg, targetMatch);
    return await getConnectionFn(account, targetMatch);
  }
}

// ============ 账号删除：关闭该账号的 Chrome ============

/**
 * 执行命令并收集 stdout。
 * 失败也返回结果，不抛异常；调用方根据 ok 决定后续动作。
 * @param {string} file
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok:boolean, out:string, error:string}>}
 */
function runCommand(file, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        error: err ? err.message : '',
      });
    });
  });
}

/**
 * 通过监听端口找到 Chrome 进程 PID。
 * 优先 Get-NetTCPConnection（拿到的就是监听 socket 的 owner），
 * PowerShell 不可用时退回 netstat 解析。
 * @param {number} port
 * @returns {Promise<number|null>}
 */
async function findPidByPort(port) {
  const ps = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
    '$c = Get-NetTCPConnection -LocalPort ' + Number(port) + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;',
    'if ($c) { [string]$c.OwningProcess }',
  ].join(' ');
  const r = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 6000);
  const line = (r.out || '').split(/\r?\n/).find((x) => /^\d+$/.test(x.trim()));
  if (line) {
    const pid = Number.parseInt(line.trim(), 10);
    if (pid > 0) return pid;
  }

  // 兜底：netstat -ano，最后一列是 PID
  const n = await runCommand('netstat', ['-ano'], 6000);
  for (const raw of (n.out || '').split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1] || '';
    const pid = Number.parseInt(parts[parts.length - 1], 10);
    if (local.endsWith(':' + port) && Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * 读取进程完整命令行（用于校验 profile 归属）。
 * @param {number} pid
 * @returns {Promise<string>}
 */
async function readProcessCommandLine(pid) {
  const ps = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '" -ErrorAction SilentlyContinue;',
    'if ($p) { [string]$p.CommandLine }',
  ].join(' ');
  const r = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 6000);
  return String(r.out || '').trim();
}

/**
 * 优雅关闭调试端口上的页面。
 * Chrome 关掉最后一个窗口后通常会退出；仍不退出再由 taskkill 兜底。
 *
 * @param {number} port
 * @param {string} [targetMatch] 只关闭 URL 含该片段的 page；为空时关闭全部非 browser 目标
 */
async function closeDebugTargets(port, targetMatch = '') {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/list', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return;
    const list = await res.json();
    const match = String(targetMatch || '');
    for (const target of Array.isArray(list) ? list : []) {
      if (!target || !target.id || target.type === 'browser') continue;
      if (match && (target.type !== 'page' || !String(target.url || '').includes(match))) continue;
      try {
        await fetch('http://127.0.0.1:' + port + '/json/close/' + encodeURIComponent(target.id), {
          signal: AbortSignal.timeout(1000),
        });
      } catch (_) { /* 页面可能已随浏览器退出 */ }
    }
  } catch (_) { /* 端口已经不可用，交给后续判断 */ }
}

/**
 * 关闭某个账号的 Quick 页签，但不主动结束 Chrome 进程。
 *
 * 停止服务时使用：只清理本服务托管的页面，避免影响用户自己的 Chrome；
 * 如果关掉最后一个页签后 Chrome 自行退出，属于 Chrome 的正常行为。
 *
 * @param {{modelId:string, debugPort:number}} account
 * @returns {Promise<{ok:boolean, method?:string, error?:string}>}
 */
export async function closeAccountTabs(account) {
  const port = Number(account && account.debugPort);
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, error: '账号没有有效的调试端口' };
  }
  if (!(await probePort(port, 400))) {
    return { ok: true, method: 'already-closed' };
  }
  await closeDebugTargets(port, 'quick.aws.com');
  return { ok: true, method: 'json-close' };
}

/**
 * 页签卫生：同一账号只保留一个匹配的 Quick 页签，多余的重复页签关掉。
 * 不匹配 URL 的页签（用户自己开的）与 browser 类型目标不动。
 *
 * @param {{modelId:string, debugPort:number}} account
 * @param {string} [targetMatch]
 * @returns {Promise<{ok:boolean, closed:number}>}
 */
export async function dedupeQuickTabs(account, targetMatch = 'quick.aws.com') {
  const port = Number(account && account.debugPort);
  if (!Number.isInteger(port) || port <= 0) return { ok: false, closed: 0 };
  if (!(await probePort(port, 400))) return { ok: true, closed: 0 };
  const quick = (await listTargets(port)).filter(
    t => t && t.id && t.type === 'page' && String(t.url || '').includes(targetMatch),
  );
  let closed = 0;
  for (const t of quick.slice(1)) {
    try {
      await fetch('http://127.0.0.1:' + port + '/json/close/' + encodeURIComponent(t.id), {
        signal: AbortSignal.timeout(1000),
      });
      closed++;
    } catch (_) { /* 页签可能已随浏览器退出 */ }
  }
  return { ok: true, closed };
}

/**
 * 等调试端口关闭。
 * @param {number} port
 * @param {number} maxSec
 * @returns {Promise<boolean>}
 */
async function waitForPortClosed(port, maxSec) {
  const deadline = Date.now() + Math.max(1, maxSec) * 1000;
  while (Date.now() < deadline) {
    if (!(await probePort(port, 300))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !(await probePort(port, 300));
}

/**
 * 校验某个调试端口上的 Chrome 是否属于指定账号。
 *
 * @param {number} port
 * @param {string} modelId
 * @returns {Promise<{ok:boolean, pid?:number, reason?:'mismatch'|'unknown', error?:string}>}
 */
export async function verifyChromeProfile(port, modelId) {
  const pid = await findPidByPort(port);
  if (!pid) {
    return { ok: false, reason: 'unknown', error: '端口 ' + port + ' 找不到监听进程' };
  }
  const cmd = await readProcessCommandLine(pid);
  if (!cmd) {
    return { ok: false, reason: 'unknown', error: '无法读取 PID ' + pid + ' 的启动参数' };
  }
  if (!commandLineMatchesProfile(cmd, modelId)) {
    return {
      ok: false,
      pid,
      reason: 'mismatch',
      error: '端口 ' + port + ' 属于其它 Chrome profile（PID ' + pid + '）',
    };
  }
  return { ok: true, pid };
}

/**
 * 关闭某个账号的 Chrome。
 *
 * 顺序：
 *   1. 端口不通 → 已经关了，直接成功
 *   2. /json/close 关掉所有页面，等端口释放
 *   3. 还活着 → 找 PID → 校验启动参数里的 user-data-dir → taskkill /T /F
 *
 * 第 3 步必须校验归属，避免端口被其它程序占用时误杀无关进程。
 *
 * @param {{modelId:string, debugPort:number}} account
 * @returns {Promise<{ok:boolean, method?:string, pid?:number, error?:string}>}
 */
export async function closeChrome(account) {
  const modelId = account && account.modelId;
  if (modelId) closingAccounts.add(modelId);
  try {
    return await closeChromeInner(account);
  } finally {
    // 不能立刻摘掉标记：taskkill 返回后子进程的 exit 事件可能晚一两秒才到，
    // 那时代码会看到非 0 退出并误判为“启动失败”重新拉起 Chrome。
    if (modelId) {
      const timer = setTimeout(() => closingAccounts.delete(modelId), 10000);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

async function closeChromeInner(account) {
  const port = Number(account && account.debugPort);
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, error: '账号没有有效的调试端口' };
  }
  if (!(await probePort(port, 400))) {
    // 刚点完“添加”就点“删除”时，Chrome 可能还在启动、端口没开。
    // 这时不能直接认为已经关了，必须把本进程拉起的子进程杀掉。
    const child = launchedChildren.get(account.modelId);
    if (child && child.pid && child.exitCode === null) {
      try { child.kill(); } catch (_) {}
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (await waitForPortClosed(port, 2)) {
        return { ok: true, method: 'kill-starting', pid: child.pid };
      }
      return { ok: false, error: 'Chrome 启动中的进程 ' + child.pid + ' 未能结束' };
    }
    return { ok: true, method: 'already-closed' };
  }

  await closeDebugTargets(port);
  if (await waitForPortClosed(port, 4)) {
    return { ok: true, method: 'json-close' };
  }

  const owner = await verifyChromeProfile(port, account.modelId);
  if (!owner.ok) {
    return {
      ok: false,
      error: owner.reason === 'mismatch'
        ? owner.error + '，已拒绝结束'
        : '无法确认端口 ' + port + ' 的归属（' + owner.error + '），拒绝结束进程',
    };
  }

  const kill = await runCommand('taskkill', ['/PID', String(owner.pid), '/T', '/F'], 8000);
  if (!kill.ok) {
    return { ok: false, error: 'taskkill 失败: ' + kill.error };
  }
  if (await waitForPortClosed(port, 6)) {
    return { ok: true, method: 'taskkill', pid: owner.pid };
  }
  return { ok: false, error: 'Chrome 进程 ' + owner.pid + ' 已结束，但端口 ' + port + ' 仍被占用' };
}
