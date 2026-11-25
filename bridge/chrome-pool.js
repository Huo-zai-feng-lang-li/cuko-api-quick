/**
 * 常驻 Chrome 资源池：最后使用时间记录、常驻上限 LRU 淘汰、空闲回收、后台轮询。
 *
 * 为什么独立成模块：
 *  - index.js 已接近行数上限，回收/淘汰策略不应再堆进入口文件；
 *  - 池状态是纯内存结构，关闭动作通过依赖注入，便于单测；
 *  - 停服时可以在这里统一清掉后台轮询定时器，避免残留 interval。
 *
 * 回收边界：只断 CDP 连接、关闭本服务受管的 Chrome 进程与页签；
 * profile 目录（登录态）保留，下次按需冷启动或走预热。
 */

/**
 * @param {object} deps
 * @param {object} deps.cfg 运行时配置（idleChromeSec / maxResidentChrome / sweepIntervalSec）
 * @param {(accountId:string)=>{active:boolean, detached?:boolean}} deps.getStats 读调度器状态
 * @param {object} [deps.actions] 可注入的外部动作（测试用假实现）
 * @param {(account:object)=>Promise<boolean>} [deps.actions.probeOnline] 端口是否在线
 * @param {(account:object)=>Promise<object>} [deps.actions.closeChrome] 关闭受管 Chrome
 * @param {(accountId:string)=>Promise<void>} [deps.actions.closeConnection] 断开 CDP 连接
 * @param {(account:object)=>Promise<object>} [deps.actions.dedupeTabs] 页签去重
 */
export function createChromePool(deps = {}) {
  const cfg = deps.cfg || {};
  const getStats = typeof deps.getStats === 'function' ? deps.getStats : () => ({ active: false });
  const actions = deps.actions || {};
  const probeOnline = actions.probeOnline || (async () => false);
  const closeChrome = actions.closeChrome || (async () => ({ ok: true }));
  const closeConnection = actions.closeConnection || (async () => {});
  const dedupeTabs = actions.dedupeTabs || (async () => ({ ok: true, closed: 0 }));

  /** modelId -> { lastUsedAt:number, online:boolean, closing:boolean } */
  const registry = new Map();
  let sweepTimer = null;

  function now() { return Date.now(); }

  /**
   * 记录一次使用/上线，刷新最后活跃时间。
   * @param {string} accountId
   * @param {boolean} [online]
   * @param {number} [at] 覆盖时间戳（测试/回填历史状态用）
   */
  function touch(accountId, online = true, at) {
    if (!accountId) return;
    const entry = registry.get(accountId) || { lastUsedAt: 0, online: false, closing: false };
    entry.lastUsedAt = at || now();
    entry.online = online;
    entry.closing = false;
    registry.set(accountId, entry);
  }

  /** 端口已不通时标记离线（不删记录，保留最后使用时间） */
  function markOffline(accountId) {
    const entry = registry.get(accountId);
    if (entry) { entry.online = false; entry.closing = false; }
  }

  /**
   * 探活只更新在线标志，不刷新最后使用时间；
   * 否则「端口还活着」会把闲置判定永远顶掉，回收失效。
   */
  function setOnline(accountId, online) {
    const entry = registry.get(accountId);
    if (entry) entry.online = online;
    else if (online) registry.set(accountId, { lastUsedAt: now(), online, closing: false });
  }

  /** 账号是否正在被回收（清理中）；调度/健康过滤应跳过它 */
  function isRecycling(accountId) {
    return Boolean(registry.get(accountId)?.closing);
  }

  /**
   * 纯判定：是否超过闲置阈值。阈值 0 表示关闭空闲回收。
   * @param {{lastUsedAt:number}} entry
   * @param {number} thresholdMs
   * @param {number} at 当前时间戳
   */
  function isIdle(entry, thresholdMs, at) {
    if (!entry || thresholdMs <= 0) return false;
    return at - entry.lastUsedAt >= thresholdMs;
  }

  /**
   * 可淘汰候选：在线、未在回收中、调度器非活跃；按最久未用升序。
   * @param {Array<object>} accounts
   * @returns {Array<{account:object, entry:object, lastUsedAt:number}>}
   */
  function evictionCandidates(accounts) {
    return accounts
      .filter(a => a && a.modelId && registry.has(a.modelId))
      .map(a => ({ account: a, entry: registry.get(a.modelId), lastUsedAt: registry.get(a.modelId).lastUsedAt }))
      .filter(x => x.entry.online && !x.entry.closing && !getStats(x.account.modelId).active)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }

  /**
   * 回收单个账号：断 CDP → 关受管 Chrome；profile 目录保留。
   * @param {object} account
   * @returns {Promise<{ok:boolean, method?:string, error?:string}>}
   */
  async function recycle(account) {
    let entry = registry.get(account.modelId);
    if (!entry) entry = { lastUsedAt: 0, online: true, closing: false };
    if (entry.closing) return { ok: false, reason: 'closing' };
    entry.closing = true;
    registry.set(account.modelId, entry);
    try {
      await closeConnection(account.modelId);
      const r = await closeChrome(account);
      entry.online = false;
      entry.closing = false;
      return (r && r.ok) ? { ok: true, method: r.method } : { ok: false, error: (r && r.error) || 'close failed' };
    } catch (e) {
      entry.closing = false;
      return { ok: false, error: e.message };
    }
  }

  /**
   * 一轮整理：刷新在线状态与页签去重 → 空闲回收 → 常驻上限淘汰。
   * @param {Array<object>} accounts 当前账号列表
   */
  async function sweep(accounts) {
    const idleMs = Math.max(0, Number(cfg.idleChromeSec) || 0) * 1000;
    const cap = Math.max(0, Number(cfg.maxResidentChrome) || 0);
    const list = Array.isArray(accounts) ? accounts : [];

    // 探活并发：单账号探活超时只有几百毫秒，串行 N 个账号会把一轮拖成 N×超时；
    // 并发后一轮耗时约等于最慢的那个账号。
    const probeResults = await Promise.all(list.map(async (account) => {
      const online = await probeOnline(account).catch(() => false);
      return { account, online };
    }));
    for (const { account, online } of probeResults) {
      if (online) {
        setOnline(account.modelId, true);
        // 调度器记录的最近使用时间（含 OpenAI 入口的请求）同步到池中，
        // 避免非 Cuko 入口服务过的账号永远不进入闲置判定。
        const st = getStats(account.modelId);
        const entry = registry.get(account.modelId);
        if (entry && st.lastUsedAt > entry.lastUsedAt) entry.lastUsedAt = st.lastUsedAt;
        await dedupeTabs(account).catch(() => {});
      } else {
        markOffline(account.modelId);
      }
    }

    if (idleMs > 0) {
      for (const account of list) {
        const entry = registry.get(account.modelId);
        if (!entry || !entry.online || entry.closing) continue;
        if (getStats(account.modelId).active) continue;
        if (isIdle(entry, idleMs, now())) {
          const r = await recycle(account);
          if (r.ok) console.log('[pool] 空闲回收:', account.modelId);
          else console.warn('[pool] 空闲回收失败:', account.modelId, r.error || '');
        }
      }
    }

    if (cap > 0) {
      const onlineCount = [...registry.values()].filter(e => e.online && !e.closing).length;
      let excess = onlineCount - cap;
      for (const c of evictionCandidates(list)) {
        if (excess <= 0) break;
        const r = await recycle(c.account);
        if (r.ok) { excess--; console.log('[pool] 常驻上限淘汰:', c.account.modelId); }
      }
    }
  }

  /** 停止后台轮询 */
  function stopSweep() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  /**
   * 启动后台回收轮询。间隔 0 表示不启动；返回停止函数。
   * @param {()=>Array<object>} accountsProvider 每次轮询时取最新账号列表
   */
  function startSweep(accountsProvider) {
    stopSweep();
    const intervalMs = Math.max(0, Number(cfg.sweepIntervalSec) || 0) * 1000;
    if (intervalMs <= 0) return stopSweep;
    sweepTimer = setInterval(() => {
      sweep(accountsProvider()).catch(e => console.warn('[pool] 回收轮询异常:', e.message));
    }, intervalMs);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    return stopSweep;
  }

  /**
   * 停服回收：清轮询定时器，并逐个关闭受管 Chrome。
   * @param {Array<object>} accounts
   */
  async function shutdown(accounts) {
    stopSweep();
    for (const account of (Array.isArray(accounts) ? accounts : [])) {
      await recycle(account).catch(() => {});
    }
    registry.clear();
  }

  /** 删除账号后从池中移除记录 */
  function removeAccount(accountId) {
    registry.delete(accountId);
  }

  /** 观测快照（管理台/测试用） */
  function snapshot() {
    return [...registry.entries()].map(([accountId, entry]) => ({ accountId, ...entry }));
  }

  return {
    touch, markOffline, setOnline, isRecycling, recycle, sweep,
    startSweep, stopSweep, shutdown, removeAccount, snapshot,
    isIdle, evictionCandidates,
  };
}
