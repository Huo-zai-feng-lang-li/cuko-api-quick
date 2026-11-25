/**
 * 启动预热：把前 N 个账号的 Chrome + Quick 页签提前拉起来。
 *
 * 为什么不放在 index.js：
 *  - 预热是独立的后台任务，失败不应影响 HTTP 服务；
 *  - 账号池参数（warmupLimit）是运行时配置，放在单独模块便于阅读。
 */
import { getAccounts, getAccountHealth, resolveProfile } from './store.js';
import { ensureConnection } from './chrome.js';
import { getConnection } from './cdp-connection.js';
import { makeAccountHealthCheck } from './account-health.js';

/**
 * 后台预热账号；串行执行，避免一次性拉起太多 Chrome 抢内存。
 * @param {{warmupOnStart:boolean, warmupLimit:number}} runtimeCfg
 * @param {(account:object)=>void} [onAccountReady] 单个账号就绪回调（资源池登记用）
 * @returns {Promise<void>}
 */
export async function warmupAccounts(runtimeCfg, onAccountReady) {
  if (!runtimeCfg || !runtimeCfg.warmupOnStart || runtimeCfg.warmupLimit <= 0) return;
  const accounts = getAccounts().slice(0, runtimeCfg.warmupLimit);
  if (!accounts.length) return;
  console.log('[warmup] 开始预热 ' + accounts.length + ' 个账号…');

  for (const account of accounts) {
    // 预热是后台串行任务，期间用户可能删号；每轮重新读账号和健康，
    // 避免为已删除的 profile 重新拉起 Chrome。
    const current = getAccounts().find(a => a.modelId === account.modelId);
    if (!current) {
      console.warn('[warmup] 跳过已删除账号:', account.modelId);
      continue;
    }
    const healthMap = getAccountHealth();
    const err = makeAccountHealthCheck(healthMap)(current);
    if (err) {
      console.warn('[warmup] 跳过 ' + current.modelId + '：' + err.message);
      continue;
    }
    try {
      const profile = resolveProfile(current);
      await ensureConnection(current, profile.values, getConnection, 'quick.aws.com');
      console.log('[warmup] 账号就绪:', current.modelId);
      if (typeof onAccountReady === 'function') onAccountReady(current);
    } catch (e) {
      console.warn('[warmup] 账号预热失败:', current.modelId, e.message);
    }
  }
}
