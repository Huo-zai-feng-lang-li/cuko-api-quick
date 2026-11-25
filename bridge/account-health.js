/**
 * 账号健康闸门：把 account-health.json 的记录翻译成入口层错误。
 *
 * 为什么单独抽出来：
 *  - Cuko 和 OpenAI 两个入口都要在调度前过滤不可用账号；
 *  - 调度器也需要拿到准确的 statusCode/code，才能把“唯一账号未登录”
 *    直接返回 401，而不是笼统的 503。
 */

const LOGIN_TTL_MS = 30 * 60 * 1000;

/**
 * @param {string} accountId
 * @param {object} healthMap
 * @returns {null | {statusCode:number, code:string, type:string, message:string}}
 */
export function accountHealthError(accountId, healthMap) {
  const health = healthMap && healthMap[accountId];
  if (!health || !health.state || health.state === 'ok') return null;
  const now = Date.now();
  if (health.state === 'login_required' && health.checkedAt && (now - health.checkedAt) < LOGIN_TTL_MS) {
    return {
      statusCode: 401,
      code: 'authentication_required',
      type: 'authentication_error',
      message: '账号未登录或登录失效，请重新登录 quick.aws.com 后再试',
    };
  }
  if (health.state === 'quota_exceeded' && health.resetAt && health.resetAt > now) {
    return {
      statusCode: 429,
      code: 'rate_limit_exceeded',
      type: 'rate_limit_error',
      message: '账号额度已用完，预计 ' + new Date(health.resetAt).toLocaleString('sv-SE') + ' 恢复',
    };
  }
  if (health.state === 'error') {
    // Chrome 起不来、CDP 断开、输入区缺失：不能当成健康账号放行，
    // 否则池里唯一账号会持续接单再失败。让调度器跳过它。
    return {
      statusCode: 503,
      code: 'provider_unavailable',
      type: 'server_error',
      message: health.message || '账号当前不可用，请检查 Chrome 登录态后重试',
    };
  }
  return null;
}

/**
 * 生成给调度器用的 accountError 回调。
 * @param {object} healthMap
 * @returns {(account:object)=>object|null}
 */
export function makeAccountHealthCheck(healthMap) {
  return (account) => accountHealthError(account && account.modelId, healthMap);
}
