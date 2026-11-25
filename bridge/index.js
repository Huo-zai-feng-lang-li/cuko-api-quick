/**
 * cuko-api-quick —— 把 Amazon Quick（quick.aws.com）网页版聊天，暴露成 Cuko API
 *
 * 架构：
 *   客户端 --(HTTP/SSE)--> bridge/index.js --(CDP)--> 独立 Chrome --user-data-dir--> quick.aws.com
 *
 * 端点：
 *   GET  /v1/models                      模型（账号）列表
 *   POST /v1/responses                   发送消息（SSE 流式）
 *   GET  /openai/v1/models               OpenAI 格式模型列表
 *   POST /openai/v1/responses            OpenAI Responses（Codex）
 *   POST /openai/v1/chat/completions     OpenAI Chat Completions（dsh）
 *   GET  /api/accounts                   账号列表
 *   POST /api/accounts                   新增账号（自动启动 Chrome）
 *   POST /api/shutdown                   停止服务并关闭本服务托管的 Quick 页签
 *   PUT  /api/accounts/:id               绑配置方案
 *   DELETE /api/accounts/:id             删除账号（含独立数据目录）
 *   POST /api/accounts/:id/open          打开 Chrome
 *   GET  /api/accounts/:id/health        账号健康检查
 *   GET  /api/profiles                   配置方案
 *   POST /api/profiles                   新建方案
 *   PUT  /api/profiles/:id               修改方案
 *   DELETE /api/profiles/:id             删除方案
 *
 * 协议见 docs/cuko-api-v1.md，Quick 侧细节见 docs/quick-protocol.md。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getAccounts, saveAccounts, getProfiles, saveProfiles, resolveProfile,
  ensureDataDirs, initLogFile, teeConsoleToFile, PROFILES_DIR, getAccountHealth, saveAccountHealth } from './store.js';
import { DEFAULT_PROFILE_VALUES, FIELD_LABELS, validateProfile } from './default-config.js';
import { readUiIndexHtml } from './app-paths.js';
import { launchChrome, probePort, isPortFree, resolveChromePath, ensureConnection, closeChrome, dedupeQuickTabs } from './chrome.js';
import { createAccountScheduler, effectiveModelAlias, groupAccountsByAlias, listModelAliases } from './account-scheduler.js';
import { createChromePool } from './chrome-pool.js';
import { makeAccountHealthCheck } from './account-health.js';
import { createSerialLock } from './serial-lock.js';
import { validateAccountInput, generateUniqueAccountId, listProfileDirNames } from './account-id.js';
import { getConnection, closeConnection, closeAllConnections } from './cdp-connection.js';
import { handleChat } from './chat.js';
import { handleCompress } from './compress.js';
import { checkAccountHealth } from './health.js';
import { normalizeInputItems } from './input.js';
// [261123-openai] OpenAI Responses / Chat Completions 兼容入口：
// Codex、dsh 等标准客户端走 /openai/v1，不复用 Cuko 自定义 /v1/responses。
import { handleOpenAIRequest } from './openai/handler.js';
// [261123-attach] 超长文本转附件：客户端发来的工具调用结果动辄几万字符，
// 直接塞进输入框既慢又容易被页面截断，改成落文件走 Quick 的附件通道。详见 docs/quick-protocol.md
import { splitOversizedTexts, materializeFileItems, TEXT_TO_FILE_THRESHOLD } from './attachments.js';
// [261123-port-config] 运行时配置（端口/监听地址）：配置文件 + 环境变量。
// 双击 exe 的用户没法设环境变量，所以支持改 data/config.json 后重启生效。
import { resolveRuntimeConfig, ensureRuntimeConfigFile, portInUseHint, RUNTIME_CONFIG_FILE } from './runtime-config.js';
// [261123-open-admin] 启动后自动打开管理后台
import { openInBrowser } from './open-browser.js';
// 启动预热放在独立模块，避免 index.js 继续膨胀
import { warmupAccounts } from './warmup.js';

const BASE_DEBUG_PORT = 9222;

ensureDataDirs();
const runtimeCfg = resolveRuntimeConfig();
const HTTP_PORT = runtimeCfg.port;
const HTTP_HOST = runtimeCfg.host;
if (ensureRuntimeConfigFile()) console.log('[config] 已生成默认配置文件:', RUNTIME_CONFIG_FILE);
const LOG_FILE = initLogFile();
teeConsoleToFile();
console.log('[bridge] 日志落盘:', LOG_FILE);

/**
 * 账号池调度器：对外模型别名 -> 内部账号池。
 * 每个账号同时只跑一轮 Quick；同账号的后续请求排队，不同账号并行。
 */
const scheduler = createAccountScheduler({
  maxQueuePerAccount: runtimeCfg.maxQueuePerAccount,
  maxWaitMs: runtimeCfg.queueMaxWaitSec * 1000,
  detachedGraceMs: runtimeCfg.detachedGraceSec * 1000,
});

/**
 * 常驻 Chrome 资源池：空闲回收、常驻上限 LRU 淘汰、页签去重、后台轮询。
 * 关闭动作复用 chrome.js 的受管 Chrome 关闭流程（含 profile 归属校验）。
 */
const pool = createChromePool({
  cfg: runtimeCfg,
  getStats: (id) => scheduler.statsFor(id),
  actions: {
    probeOnline: async (account) => probePort(account.debugPort, 300),
    closeChrome,
    closeConnection: async (accountId) => closeConnection(accountId),
    dedupeTabs: (account) => dedupeQuickTabs(account),
  },
});

/** 每个模型当前在途的 SSE 响应；删除账号时主动断开，避免挂到超时 */
const activeResponses = new Map();

/** 停止服务只允许触发一次，避免并发点击导致重复清理 */
let shuttingDown = false;

/**
 * 停止 HTTP 服务、关闭在途请求和本服务托管的 Quick 页签。
 * 不删除 data/ 或账号 profile；用户自己的 Chrome 不会被触碰。
 */
async function shutdownService() {
  console.log('[bridge] 管理台请求停止服务，正在关闭…');

  // 1) 先停止接收新请求，避免清理过程中又进来新任务
  try { server.close(); } catch (_) {}

  // 2) 断开在途 SSE，释放调度器和并发槽位
  scheduler.cancelAll('服务正在停止');
  for (const sink of activeResponses.values()) {
    try { sink.destroy(); } catch (_) {}
  }
  activeResponses.clear();

  // 3) 断开 CDP 常驻连接，避免退出时留下 socket
  try { await closeAllConnections(); } catch (_) {}

  // 4) 逐个回收受管 Chrome（关页签 + 释放调试端口），不停留在“只关页签”状态
  await pool.shutdown(getAccounts());

  // 5) 强制断开剩余 HTTP 连接，再退出进程
  if (typeof server.closeAllConnections === 'function') {
    try { server.closeAllConnections(); } catch (_) {}
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.exit(0);
}

/** 账号/方案是“读-改-写”文件，管理接口必须串行，避免并发覆盖 */
const withConfigLock = createSerialLock();

/** 统一的 JSON 响应 */
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 读取请求体 */
async function readBody(req) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;
  return body;
}

/**
 * 从 9222 起找第一个可用调试端口。
 *
 * 不能只按 accounts.json 里的最大值 +1：删号后旧 Chrome 可能还占着端口，
 * 新账号会拿到同一个端口，然后 probePort 一通就连接到旧账号的登录态上。
 * 这里同时排除“已被账号登记”和“当前有任意进程监听”的端口。
 *
 * @param {Array<{debugPort?:number}>} accounts
 * @returns {Promise<number>}
 */
async function allocDebugPort(accounts) {
  const used = new Set(accounts.map(a => a.debugPort).filter(Boolean));
  for (let port = BASE_DEBUG_PORT; port < BASE_DEBUG_PORT + 200; port++) {
    if (used.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error('9222 起没有可用调试端口（已检查 200 个），请先关闭不用的 Chrome');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  // 管理台
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = readUiIndexHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('管理页读取失败: ' + e.message);
    }
    return;
  }

  // [261123-port-config] 让管理台能显示「当前实际监听地址」，
  // 用户改完端口不知道填什么时可对照。
  if (req.method === 'GET' && pathname === '/api/info') {
    sendJson(res, 200, {
      port: HTTP_PORT,
      host: HTTP_HOST,
      baseUrl: 'http://127.0.0.1:' + HTTP_PORT,
      portSource: runtimeCfg.portSource,
      configFile: RUNTIME_CONFIG_FILE,
      version: (() => { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version; } catch { return '0.1.0'; } })(),
    });
    return;
  }

  // 管理台「停止服务」：先结束这次 HTTP 响应，再异步清理并退出进程。
  if (req.method === 'POST' && pathname === '/api/shutdown') {
    if (shuttingDown) {
      sendJson(res, 202, { success: true, message: '服务正在停止' });
      return;
    }
    shuttingDown = true;
    sendJson(res, 200, { success: true, message: '服务正在停止，浏览器页签将关闭' });
    setTimeout(() => {
      shutdownService().catch((e) => {
        console.error('[bridge] 停止服务失败:', e && e.message);
        process.exit(1);
      });
    }, 50);
    return;
  }

  // ============ OpenAI 兼容入口 ============
  // Codex / dsh 等标准客户端使用 /openai/v1，避免和 Cuko 老协议冲突。
  if (pathname === '/openai/v1' || pathname.startsWith('/openai/v1/')) {
    try {
      await handleOpenAIRequest({
        req,
        res,
        pathname,
        deps: {
          getAccounts,
          getAccountHealth,
          resolveProfile,
          ensureConnection,
          getConnection,
          handleChat,
          scheduler,
          activeResponses,
          isRecycling: (id) => pool.isRecycling(id),
          touchAccount: (id) => pool.touch(id),
        },
      });
    } catch (e) {
      // 入口层自身出错（比如账号文件读取失败）也不能把进程打挂。
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: e.message || '内部错误', type: 'server_error', code: 'internal_error' } });
      } else {
        try { res.end(); } catch (_) {}
      }
    }
    return;
  }

  // ============ Cuko API ============
  if (req.method === 'GET' && pathname === '/v1/models') {
    const aliases = listModelAliases(getAccounts());
    sendJson(res, 200, {
      // 对外只暴露别名；同名账号自动聚合成一个模型（池）。
      data: aliases.map(a => ({ id: a.alias, name: a.alias })),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/responses') {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { sendJson(res, 400, { code: 'invalid_request', message: 'Bad JSON' }); return; }

    // 归一化输入
    const norm = normalizeInputItems(payload.input);
    if (norm.unknown.length) console.warn('[input] 未识别的输入项:', norm.unknown.join(', '));

    // [261123-attach] 超过阈值的单个文本项转成附件，正文只留摘要
    const split = splitOversizedTexts(norm.items, TEXT_TO_FILE_THRESHOLD);
    const parts = [...split.inlineTexts, ...split.summaryNotes];
    const text = parts.join('\n\n');

    if (split.files.length) {
      console.log('[input] ' + split.files.length + ' 个超长文本已转为附件');
    }

    // [261123-attach] Cuko 的 file 项（base64）落盘后走同一条附件通道
    const fileItems = norm.items.filter(i => i.kind === 'file');
    const materialized = materializeFileItems(fileItems);
    if (materialized.errors.length) {
      console.warn('[input] 部分文件项处理失败:', materialized.errors.join('; '));
    }
    if (materialized.files.length) {
      console.log('[input] ' + materialized.files.length + ' 个文件项已落盘，将作为附件发送');
    }

    // 只有文件、没有文本时，给模型一句简短说明，避免「空消息」
    let finalText = text;
    if (!finalText && materialized.files.length) {
      finalText = '【附件】共 ' + materialized.files.length + ' 个文件：' +
        materialized.files.map(f => f.fileName).join('、') + '，请查看附件内容。';
    }

    const allFiles = [...split.files, ...materialized.files];
    if (!finalText && !allFiles.length) {
      sendJson(res, 400, { code: 'invalid_request', message: '输入为空：没有可识别的文本/文件项' });
      return;
    }

    payload._text = finalText;
    payload._attachFiles = allFiles.map(f => f.filePath);
    payload._attachMeta = allFiles;

    const accounts = getAccounts();
    const healthMap = getAccountHealth();
    const healthCheck = makeAccountHealthCheck(healthMap);
    // 正在回收中的账号不接新请求，调度器按规则挑其它健康账号
    const accountError = (acc) => {
      if (pool.isRecycling(acc.modelId)) {
        return { statusCode: 503, code: 'account_unavailable', message: '账号正在回收，请稍后重试' };
      }
      return healthCheck(acc);
    };
    const ac = new AbortController();
    let acquired = null;
    let released = false;
    const onClose = () => {
      if (res.writableEnded) return;
      ac.abort();
      if (acquired) release();
    };
    const release = () => {
      if (released) return;
      released = true;
      if (acquired) acquired.release();
      const account = acquired && acquired.account;
      if (account && activeResponses.get(account.modelId) === res) activeResponses.delete(account.modelId);
      try { res.off('close', onClose); } catch (_) {}
    };
    res.on('close', onClose);

    try {
      acquired = await scheduler.acquire({
        accounts,
        alias: String(payload.model || '').trim(),
        accountError,
        signal: ac.signal,
      });
    } catch (e) {
      try { res.off('close', onClose); } catch (_) {}
      if (!res.writableEnded) {
        sendJson(res, e.statusCode || 503, { code: e.code || 'provider_unavailable', message: e.message });
      }
      return;
    }

    const account = acquired.account;
    const profile = resolveProfile(account);
    if (res.writableEnded) { release(); return; }
    activeResponses.set(account.modelId, res);

    // SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    try {
      // [261123-autolaunch] Chrome 被关掉时自动拉起，而不是把 ECONNREFUSED 甩给客户端。
      const conn = await ensureConnection(account, profile.values, getConnection, 'quick.aws.com');
      pool.touch(account.modelId);
      if (payload.type === 'compress') {
        await handleCompress({ res, payload, account, conn, cfg: profile.values, profile, release });
      } else {
        await handleChat({ res, payload, account, conn, cfg: profile.values, profile, release, detach: acquired.detach });
      }
    } catch (e) {
      console.error('[bridge] 处理请求失败:', e.message);
      release();
      if (!res.writableEnded) {
        try {
          res.write('event: error\n');
          res.write('data: ' + JSON.stringify({ code: e.code || 'internal_error', message: e.message }) + '\n\n');
          res.end();
        } catch (_) {}
      }
    }
    if (!released) release();
    return;
  }

  // ============ 管理 API：账号 ============
  if (req.method === 'GET' && pathname === '/api/accounts') {
    const accounts = getAccounts();
    const healthMap = getAccountHealth();
    const profiles = getProfiles();
    const groups = groupAccountsByAlias(accounts);
    // 并行探活：以前是 for 里 await，账号多/端口卡住时一轮能拖几秒
    await Promise.all(accounts.map(async (acc) => {
      acc.modelAlias = effectiveModelAlias(acc);
      acc.poolSize = (groups.get(acc.modelAlias) || []).length;
      const st = scheduler.statsFor(acc.modelId);
      acc.active = st.active;
      acc.queued = st.queued;
      acc.status = (await probePort(acc.debugPort, 300)) ? 'online' : 'offline';
      const eff = resolveProfile(acc, profiles);
      acc.profileId = acc.profileId || 'default';
      acc.profileName = eff.name;
      acc.health = healthMap[acc.modelId] || null;
    }));
    sendJson(res, 200, accounts);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/accounts') {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'Bad JSON' }); return; }
    const input = validateAccountInput(data);
    if (!input.ok) { sendJson(res, input.status, { error: input.error }); return; }

    await withConfigLock(async () => {
      const accounts = getAccounts();
      let modelId = input.modelId;
      if (modelId) {
        if (accounts.find(a => a.modelId === modelId)) { sendJson(res, 409, { error: '该 ID 已存在' }); return; }
      } else {
        // 锁内生成：同时排除 accounts.json 已有 ID 与 profiles 目录已存在的目录名，
        // 连续并发新增也不会拿到同一个 ID。
        modelId = generateUniqueAccountId(accounts, listProfileDirNames(PROFILES_DIR));
      }

      let profileId = 'default';
      if (data.profileId && data.profileId !== 'default') {
        if (!getProfiles().find(p => p.id === data.profileId)) { sendJson(res, 400, { error: '指定的配置方案不存在' }); return; }
        profileId = data.profileId;
      }

      let debugPort;
      try {
        debugPort = await allocDebugPort(accounts);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
        return;
      }

      // modelId 是内部唯一身份；modelAlias 是对外模型名，同别名自动组成账号池。
      const account = { modelId, modelAlias: input.modelAlias, debugPort, profileId, createdAt: Date.now() };
      accounts.push(account);
      try {
        saveAccounts(accounts);
      } catch (e) {
        sendJson(res, 500, { error: '写入 accounts.json 失败：' + e.message });
        return;
      }
      const started = launchChrome(account, resolveProfile(account).values);
      if (started) pool.touch(account.modelId);
      sendJson(res, 200, { success: true, account });
    });
    return;
  }

  if (req.method === 'PUT' && pathname.startsWith('/api/accounts/')) {
    const modelId = decodeURIComponent(pathname.split('/')[3] || '');
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'Bad JSON' }); return; }
    await withConfigLock(async () => {
      const accounts = getAccounts();
      const acc = accounts.find(a => a.modelId === modelId);
      if (!acc) { sendJson(res, 404, { error: 'Not found' }); return; }
      if (data.modelAlias !== undefined) {
        const alias = String(data.modelAlias || '').trim();
        if (alias) {
          if (alias.length > 80 || !/^[a-zA-Z0-9._:-]+$/.test(alias)) {
            sendJson(res, 400, { error: 'modelAlias 仅支持英文、数字、点、下划线、冒号、中划线，且不超过 80 字符' });
            return;
          }
          acc.modelAlias = alias;
        } else {
          delete acc.modelAlias; // 清空后回退到 modelId
        }
      }
      if (data.profileId !== undefined) {
        if (!data.profileId || data.profileId === 'default') acc.profileId = 'default';
        else if (!getProfiles().find(p => p.id === data.profileId)) { sendJson(res, 400, { error: '指定的配置方案不存在' }); return; }
        else acc.profileId = data.profileId;
      }
      try {
        saveAccounts(accounts);
      } catch (e) {
        sendJson(res, 500, { error: '写入 accounts.json 失败：' + e.message });
        return;
      }
      sendJson(res, 200, { success: true });
    });
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/accounts/')) {
    const modelId = decodeURIComponent(pathname.split('/')[3] || '');
    await withConfigLock(async () => {
      const accounts = getAccounts();
      const acc = accounts.find(a => a.modelId === modelId);
      if (!acc) { sendJson(res, 404, { error: 'Not found' }); return; }

      // 1) 先断开在途 SSE，避免旧请求继续往页面里写、挂到空闲超时才释放
      const active = activeResponses.get(modelId);
      if (active) { try { active.destroy(); } catch (_) {} }
      scheduler.cancelAccount(modelId, '账号已删除');
      activeResponses.delete(modelId);

      // 2) 断开 CDP（只是本进程到 Chrome 的调试连接，不会关浏览器）
      try { await closeConnection(modelId); } catch (_) {}
      pool.removeAccount(modelId);

      // 3) 关掉这个账号的 Chrome，并确认调试端口真的释放
      let closed;
      try {
        closed = await closeChrome(acc);
      } catch (e) {
        closed = { ok: false, error: e.message };
      }
      if (!closed.ok) {
        sendJson(res, 500, { error: '账号未删除：' + closed.error });
        return;
      }

      // 4) 删登录态目录；删不掉就保留账号记录，允许用户重试
      const dir = path.join(PROFILES_DIR, modelId);
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch (e) {
          console.error('[accounts] 删除数据目录失败:', e.message);
        }
      }
      if (fs.existsSync(dir)) {
        sendJson(res, 500, {
          error: 'Chrome 已关闭，但登录态目录删除失败（可能仍被其它程序占用）。账号记录已保留，请关闭相关窗口后重试',
        });
        return;
      }

      // 5) 所有资源都清理成功后才提交账号删除
      try {
        saveAccounts(accounts.filter(a => a.modelId !== modelId));
      } catch (e) {
        console.error('[accounts] 写入 accounts.json 失败:', e.message);
        sendJson(res, 500, {
          error: 'Chrome 和登录态目录已清理，但 accounts.json 写入失败：' + e.message + '。账号记录仍在，请重试删除',
        });
        return;
      }

      // 6) 清掉健康记录，避免重新添加同 ID 时被旧状态挡住
      const health = getAccountHealth();
      if (health[modelId]) {
        delete health[modelId];
        try {
          saveAccountHealth(health);
        } catch (e) {
          console.error('[accounts] 写入 account-health.json 失败:', e.message);
        }
      }

      sendJson(res, 200, {
        success: true,
        chromeClosed: closed.method || 'closed',
        profileRemoved: true,
      });
    });
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/open')) {
    const modelId = decodeURIComponent(pathname.split('/')[3] || '');
    const account = getAccounts().find(a => a.modelId === modelId);
    if (!account) { sendJson(res, 404, { error: 'Not found' }); return; }
    // 端口已经在跑时不要再 spawn 第二个 Chrome（同 profile 会闪退），
    // 手动打开也视为一次使用，刷新池活跃时间，避免 60s 后被 idle sweep 回收。
    if (await probePort(account.debugPort, 300)) {
      pool.touch(modelId);
      sendJson(res, 200, { success: true });
      return;
    }
    const started = launchChrome(account, resolveProfile(account).values);
    if (started) pool.touch(modelId);
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/health')) {
    const modelId = decodeURIComponent(pathname.split('/')[3] || '');
    const account = getAccounts().find(a => a.modelId === modelId);
    if (!account) { sendJson(res, 404, { error: 'Not found' }); return; }
    try {
      const cfg = resolveProfile(account).values;
      const r = await checkAccountHealth(account, cfg);
      // 健康检查也可能顺手拉起 Chrome；同样算一次使用，避免刚打开就被回收。
      pool.touch(modelId);
      const record = { modelId, ...r, checkedAt: Date.now() };
      const map = getAccountHealth();
      map[modelId] = record;
      saveAccountHealth(map);
      sendJson(res, 200, record);
    } catch (e) {
      sendJson(res, 500, { modelId, state: 'error', message: e.message, checkedAt: Date.now() });
    }
    return;
  }

  // ============ 管理 API：配置方案 ============
  if (req.method === 'GET' && pathname === '/api/profiles') {
    sendJson(res, 200, {
      default: { id: 'default', name: '默认方案', isDefault: true, values: DEFAULT_PROFILE_VALUES },
      profiles: getProfiles(),
      labels: FIELD_LABELS,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/profiles') {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'Bad JSON' }); return; }
    const name = String(data.name || '').trim();
    if (!name) { sendJson(res, 400, { error: '缺少方案名称' }); return; }
    let values;
    try { values = data.values ? validateProfile(data.values) : validateProfile({ ...DEFAULT_PROFILE_VALUES }); }
    catch (e) { sendJson(res, 400, { error: e.message }); return; }
    await withConfigLock(async () => {
      const profiles = getProfiles();
      const created = { id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, values, createdAt: Date.now() };
      profiles.push(created);
      try {
        saveProfiles(profiles);
      } catch (e) {
        sendJson(res, 500, { error: '写入 profiles.json 失败：' + e.message });
        return;
      }
      sendJson(res, 200, created);
    });
    return;
  }

  if (req.method === 'PUT' && pathname.startsWith('/api/profiles/')) {
    const id = decodeURIComponent(pathname.split('/')[3] || '');
    if (id === 'default') { sendJson(res, 403, { error: '默认方案不可修改' }); return; }
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'Bad JSON' }); return; }
    await withConfigLock(async () => {
      const profiles = getProfiles();
      const p = profiles.find(x => x.id === id);
      if (!p) { sendJson(res, 404, { error: 'Not found' }); return; }
      if (data.name !== undefined) {
        const name = String(data.name || '').trim();
        if (!name) { sendJson(res, 400, { error: '名称不能为空' }); return; }
        p.name = name;
      }
      if (data.values !== undefined) {
        try { p.values = validateProfile(data.values); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
      }
      try {
        saveProfiles(profiles);
      } catch (e) {
        sendJson(res, 500, { error: '写入 profiles.json 失败：' + e.message });
        return;
      }
      sendJson(res, 200, p);
    });
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/profiles/')) {
    const id = decodeURIComponent(pathname.split('/')[3] || '');
    if (id === 'default') { sendJson(res, 403, { error: '默认方案不可删除' }); return; }
    await withConfigLock(async () => {
      const profiles = getProfiles();
      if (!profiles.find(x => x.id === id)) { sendJson(res, 404, { error: 'Not found' }); return; }
      try {
        saveProfiles(profiles.filter(x => x.id !== id));
      } catch (e) {
        sendJson(res, 500, { error: '写入 profiles.json 失败：' + e.message });
        return;
      }
      const accounts = getAccounts();
      let affected = 0;
      for (const acc of accounts) if (acc.profileId === id) { acc.profileId = 'default'; affected++; }
      if (affected) {
        try {
          saveAccounts(accounts);
        } catch (e) {
          sendJson(res, 500, { error: '方案已删除，但 accounts.json 写入失败：' + e.message });
          return;
        }
      }
      sendJson(res, 200, { success: true, affectedAccounts: affected });
    });
    return;
  }

  sendJson(res, 404, { code: 'invalid_request', message: 'Not Found' });
});

// [261123-port-config] 端口被占用时不要甩一堆栈，直接给出可操作的解决步骤
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('\n[Cuko Provider] ' + portInUseHint(HTTP_PORT) + '\n');
    process.exit(1);
  }
  if (err && err.code === 'EACCES') {
    console.error('\n[Cuko Provider] 没有权限监听端口 ' + HTTP_PORT + '。请换一个 1024 以上的端口：编辑 ' + RUNTIME_CONFIG_FILE + '\n');
    process.exit(1);
  }
  console.error('\n[Cuko Provider] 启动失败:', err && err.message, '\n');
  process.exit(1);
});

server.listen(HTTP_PORT, HTTP_HOST, async () => {
  const adminUrl = 'http://127.0.0.1:' + HTTP_PORT + '/';
  console.log('[Cuko Provider] 运行在 http://' + HTTP_HOST + ':' + HTTP_PORT + (runtimeCfg.portSource === '默认值' ? '' : '（端口来源：' + runtimeCfg.portSource + '）'));
  console.log('[Cuko Provider] 管理台: ' + adminUrl);
  console.log('[Cuko Provider] 配置文件: ' + RUNTIME_CONFIG_FILE);
  const chrome = resolveChromePath(DEFAULT_PROFILE_VALUES);
  if (!chrome) console.warn('[Cuko Provider] 未探测到 Chrome，请在配置方案里指定 chromePath');

  // [261123-open-admin] 自动打开管理后台。
  // 监听地址是 0.0.0.0 时，日志里仍用 127.0.0.1 拼地址（本机浏览器能访问）。
  // 打开失败不影响服务，只提示手动访问。
  if (runtimeCfg.autoOpenAdmin) {
    const ok = await openInBrowser(adminUrl);
    if (ok) console.log('[Cuko Provider] 已尝试打开管理台（若没弹出请手动访问上面的地址）');
    else console.warn('[Cuko Provider] 自动打开浏览器失败，请手动访问: ' + adminUrl);
  } else {
    console.log('[Cuko Provider] autoOpenAdmin 已关闭，请手动打开上面的地址');
  }

  // 后台回收轮询：空闲回收 + 常驻上限淘汰；间隔 0 时不启动。
  pool.startSweep(getAccounts);

  // 后台预热，不阻塞管理台打开；失败只告警，第一次请求仍会自动拉起。
  warmupAccounts(runtimeCfg, (account) => pool.touch(account.modelId)).catch((e) => console.warn('[warmup] 预热异常:', e.message));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n[bridge] 收到 ' + sig + '，正在关闭…');
    pool.stopSweep();
    try { await closeAllConnections(); } catch (_) {}
    try { await pool.shutdown(getAccounts()); } catch (_) {}
    process.exit(0);
  });
}
