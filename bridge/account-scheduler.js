/**
 * 账号调度器：模型别名池 + 账号级串行槽位 + 有界等待队列。
 *
 * 为什么需要它：
 *  - Quick 一个页面同一时间只能跑一轮对话，所以“并发”必须落到多个账号上；
 *  - 对外只暴露一个模型别名，客户端不需要知道内部账号 ID；
 *  - 续接会话必须粘在同一账号，否则 Quick 的上下文会丢；
 *  - 直接 429 会让短时突发全部失败，有界队列可以吸收少量等待。
 *
 * 这里是纯内存状态，不碰 CDP / HTTP，便于单测。
 */

export const DEFAULT_MAX_QUEUE_PER_ACCOUNT = 8;
export const DEFAULT_MAX_WAIT_MS = 60000;

const ALIAS_MAX = 80;

/**
 * 账号对外使用的模型别名；没配置时回退到 modelId。
 * @param {object} account
 * @returns {string}
 */
export function effectiveModelAlias(account) {
  const alias = String((account && account.modelAlias) || '').trim();
  if (alias) return alias.slice(0, ALIAS_MAX);
  return String((account && account.modelId) || '');
}

/**
 * 按对外别名分组；同别名的多个账号构成一个池。
 * @param {Array<object>} accounts
 * @returns {Map<string, Array<object>>}
 */
export function groupAccountsByAlias(accounts) {
  const map = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || !account.modelId) continue;
    const alias = effectiveModelAlias(account);
    if (!alias) continue;
    if (!map.has(alias)) map.set(alias, []);
    map.get(alias).push(account);
  }
  return map;
}

/**
 * 对外模型别名列表（按账号创建时间取最早的一个作为模型时间）。
 * @param {Array<object>} accounts
 * @returns {Array<{alias:string, createdAt:number, accounts:number}>}
 */
export function listModelAliases(accounts) {
  const groups = groupAccountsByAlias(accounts);
  return [...groups.entries()].map(([alias, pool]) => ({
    alias,
    createdAt: Math.min(...pool.map(a => Number(a.createdAt) || Date.now())),
    accounts: pool.length,
  }));
}

/**
 * 构造带 HTTP 状态的错误，入口层可以直接读 statusCode/code。
 * @param {string} message
 * @param {string} code
 * @param {number} statusCode
 * @returns {Error & {statusCode:number, code:string, type:string}}
 */
export function schedulerError(message, code, statusCode) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.type = statusCode === 429 ? 'rate_limit_error'
    : statusCode === 401 ? 'authentication_error'
      : statusCode === 404 ? 'invalid_request_error'
        : statusCode === 499 ? 'client_error' : 'server_error';
  return err;
}

function normalizeError(value, fallback) {
  if (!value) return fallback;
  if (value instanceof Error) {
    if (!value.statusCode) value.statusCode = fallback.statusCode;
    if (!value.code) value.code = fallback.code;
    if (!value.type) value.type = fallback.type;
    return value;
  }
  return schedulerError(String(value.message || value.error || fallback.message), value.code || fallback.code, value.statusCode || fallback.statusCode);
}

function removeFromArray(arr, item) {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}

function readAccountError(accountError, account, fallback) {
  if (!accountError) return null;
  try {
    return accountError(account);
  } catch (e) {
    return normalizeError(e, fallback);
  }
}

/** 客户端断开后，已发出消息的回合默认再保留槽位的过渡期 */
export const DEFAULT_DETACHED_GRACE_MS = 15000;

/**
 * @param {{maxQueuePerAccount?:number, maxWaitMs?:number, detachedGraceMs?:number}} [options]
 */
export function createAccountScheduler(options = {}) {
  const maxQueuePerAccount = Math.max(0, Number(options.maxQueuePerAccount));
  const maxWaitMs = Math.max(0, Number(options.maxWaitMs));
  const queueLimit = Number.isFinite(maxQueuePerAccount) ? maxQueuePerAccount : DEFAULT_MAX_QUEUE_PER_ACCOUNT;
  const waitLimit = Number.isFinite(maxWaitMs) ? maxWaitMs : DEFAULT_MAX_WAIT_MS;
  const graceMsRaw = Number(options.detachedGraceMs);
  const graceMs = Number.isFinite(graceMsRaw) ? Math.max(0, graceMsRaw) : DEFAULT_DETACHED_GRACE_MS;
  const states = new Map(); // accountId -> { active, waiters, lastUsedAt, generation, detached, detachTimer }

  function stateFor(accountId) {
    if (!states.has(accountId)) {
      states.set(accountId, { active: false, waiters: [], lastUsedAt: 0, generation: 0, detached: false, detachTimer: null });
    }
    return states.get(accountId);
  }

  function clearDetachTimer(st) {
    if (st.detachTimer) { clearTimeout(st.detachTimer); st.detachTimer = null; }
    st.detached = false;
  }

  /**
   * 槽位代际：删除/停止时递增，旧的在途请求 release 时必须带着旧代际，
   * 避免删号后立刻重建同名 modelId 时，旧请求把新请求的槽位误释放。
   */
  function nextGeneration(accountId) {
    const st = stateFor(accountId);
    st.generation += 1;
    return st.generation;
  }

  function statsFor(accountId) {
    const st = states.get(accountId);
    return {
      active: Boolean(st && st.active),
      queued: st ? st.waiters.length : 0,
      lastUsedAt: st ? st.lastUsedAt : 0,
      detached: Boolean(st && st.detached),
    };
  }

  function makeGrant(account, queuedMs, generation) {
    let released = false;
    return {
      account,
      queuedMs,
      release: () => {
        if (released) return;
        released = true;
        releaseAccount(account.modelId, generation);
      },
      /**
       * 客户端已断开，但消息已发出：不立刻放槽位，进入过渡期。
       * 过渡期内回合真正结束会走 release()；到点仍未结束则强制释放，
       * 避免无人接收的旧回合永久占住账号。graceMs=0 时等同立即 release。
       */
      detach: () => {
        if (released) return;
        const st = states.get(account.modelId);
        if (!st || generation !== st.generation) return;
        if (graceMs <= 0) { releaseAccount(account.modelId, generation); released = true; return; }
        if (st.detached) return;
        st.detached = true;
        st.detachTimer = setTimeout(() => {
          st.detachTimer = null;
          // 到点仍由同一代际持有，强制释放；代际已变（删号重建）则不动新槽位。
          if (states.get(account.modelId) === st && st.active && generation === st.generation) {
            releaseAccount(account.modelId, generation);
          }
        }, graceMs);
        if (typeof st.detachTimer.unref === 'function') st.detachTimer.unref();
      },
    };
  }

  function releaseAccount(accountId, generation) {
    const st = states.get(accountId);
    // 账号被删除/服务停止后，旧请求可能才走到 release；代际不匹配时
    // 绝不能动新账号（同名 modelId 重建）的 active 槽位。
    if (!st || !st.active || generation !== st.generation) return;
    clearDetachTimer(st);
    st.active = false;
    st.lastUsedAt = Date.now();

    // 只把槽位交给真正能接单的等待者。等待者可能在释放前刚好取消/超时，
    // 此时必须继续向后找，不能留下 active=true 但没有实际持有者的空槽。
    while (st.waiters.length) {
      const next = st.waiters.shift();
      if (next.settled) continue;
      const delivered = next.deliver(Date.now() - next.startedAt);
      if (delivered) {
        st.active = true;
        return;
      }
    }
  }

  function enqueue(account, signal) {
    const st = stateFor(account.modelId);
    const generation = st.generation;
    if (!st.active) {
      st.active = true;
      st.lastUsedAt = Date.now();
      return Promise.resolve(makeGrant(account, 0, generation));
    }
    if (st.waiters.length >= queueLimit) {
      return Promise.reject(schedulerError('账号池排队已满，请稍后重试', 'queue_full', 429));
    }
    if (signal && signal.aborted) {
      return Promise.reject(schedulerError('客户端已断开', 'client_closed', 499));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        account,
        generation,
        startedAt: Date.now(),
        signal,
        timer: null,
        onAbort: null,
        settled: false,
        reject,
      };

      const cleanup = () => {
        if (waiter.timer) { clearTimeout(waiter.timer); waiter.timer = null; }
        if (signal && waiter.onAbort) {
          try { signal.removeEventListener('abort', waiter.onAbort); } catch (_) {}
        }
        waiter.onAbort = null;
      };

      const fail = (err) => {
        if (waiter.settled) return;
        waiter.settled = true;
        removeFromArray(st.waiters, waiter);
        cleanup();
        reject(err);
      };

      waiter.deliver = (queuedMs) => {
        if (waiter.settled) return false;
        if (signal && signal.aborted) {
          fail(schedulerError('客户端已断开', 'client_closed', 499));
          return false;
        }
        waiter.settled = true;
        cleanup();
        resolve(makeGrant(account, queuedMs, generation));
        return true;
      };

      if (signal && typeof signal.addEventListener === 'function') {
        waiter.onAbort = () => fail(schedulerError('客户端已断开', 'client_closed', 499));
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      if (waitLimit > 0) {
        waiter.timer = setTimeout(() => {
          fail(schedulerError('账号池排队超时，请稍后重试', 'queue_timeout', 429));
        }, waitLimit);
      }

      st.waiters.push(waiter);
    });
  }

  /**
   * 申请一个账号槽位。
   *
   * @param {object} opts
   * @param {Array<object>} opts.accounts 当前账号列表
   * @param {string} opts.alias 对外模型别名
   * @param {string} [opts.preferredAccountId] 续接会话时锁定的账号
   * @param {(account:object)=>object|null} [opts.accountError] 健康检查；返回错误则跳过
   * @param {AbortSignal} [opts.signal] 客户端断开信号
   * @returns {Promise<{account:object, queuedMs:number, release:()=>void}>}
   */
  async function acquire(opts = {}) {
    const accounts = Array.isArray(opts.accounts) ? opts.accounts : [];
    const alias = String(opts.alias || '').trim();
    if (!alias) throw schedulerError('缺少模型别名', 'model_not_found', 404);

    const pool = accounts.filter(a => a && a.modelId && effectiveModelAlias(a) === alias);
    if (!pool.length) throw schedulerError('Model not found: ' + alias, 'model_not_found', 404);

    const fallback = schedulerError('账号不可用', 'account_unavailable', 503);
    const accountError = typeof opts.accountError === 'function' ? opts.accountError : null;

    const preferredId = String(opts.preferredAccountId || '');
    if (preferredId) {
      const preferred = pool.find(a => a.modelId === preferredId);
      if (!preferred) {
        throw schedulerError(
          '该会话所属账号已不可用，请去掉 previous_response_id 重新开始',
          'account_unavailable',
          409,
        );
      }
      const err = readAccountError(accountError, preferred, fallback);
      if (err) throw normalizeError(err, fallback);
      return enqueue(preferred, opts.signal);
    }

    const errors = [];
    const usable = [];
    for (const account of pool) {
      const err = readAccountError(accountError, account, fallback);
      if (err) errors.push(normalizeError(err, fallback));
      else usable.push(account);
    }
    if (!usable.length) throw errors[0] || fallback;

    const idle = usable.filter(a => !stateFor(a.modelId).active);
    if (idle.length) {
      idle.sort((a, b) => {
        const sa = stateFor(a.modelId);
        const sb = stateFor(b.modelId);
        return (sa.lastUsedAt - sb.lastUsedAt) || (sa.waiters.length - sb.waiters.length);
      });
      return enqueue(idle[0], opts.signal);
    }

    const leastBusy = usable.slice().sort((a, b) => {
      const sa = stateFor(a.modelId);
      const sb = stateFor(b.modelId);
      return (sa.waiters.length - sb.waiters.length) || (sa.lastUsedAt - sb.lastUsedAt);
    });
    return enqueue(leastBusy[0], opts.signal);
  }

  /** 删除账号时清空它的等待队列，并释放活跃槽位。 */
  function cancelAccount(accountId, message = '账号已删除') {
    const st = states.get(accountId);
    if (!st) return;
    clearDetachTimer(st);
    st.active = false;
    st.lastUsedAt = Date.now();
    nextGeneration(accountId);
    const waiters = st.waiters.splice(0);
    for (const waiter of waiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) {
        try { waiter.signal.removeEventListener('abort', waiter.onAbort); } catch (_) {}
      }
      waiter.reject?.(schedulerError(message, 'account_removed', 409));
      // 上面的 waiter 对象没有暴露 reject；兼容旧结构
    }
  }

  /** 停止服务时清空所有账号的等待队列。 */
  function cancelAll(message = '服务正在停止') {
    for (const id of states.keys()) cancelAccount(id, message);
  }

  function snapshot(accounts = []) {
    return (Array.isArray(accounts) ? accounts : []).map(a => ({
      accountId: a.modelId,
      modelAlias: effectiveModelAlias(a),
      ...statsFor(a.modelId),
    }));
  }

  return {
    acquire,
    cancelAccount,
    cancelAll,
    statsFor,
    snapshot,
  };
}
