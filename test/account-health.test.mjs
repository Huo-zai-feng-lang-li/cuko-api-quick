/**
 * 账号健康闸门：错误状态必须变成可识别的 HTTP 错误，不能把故障账号放行。
 */
import { accountHealthError, makeAccountHealthCheck } from '../bridge/account-health.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

test('健康闸门：ok / 无记录放行', () => {
  assert.equal(accountHealthError('aws', {}), null);
  assert.equal(accountHealthError('aws', { aws: { state: 'ok' } }), null);
});

test('健康闸门：30 分钟内未登录返回 401', () => {
  const now = Date.now();
  const err = accountHealthError('aws', { aws: { state: 'login_required', checkedAt: now - 1000 } });
  assert.equal(err.statusCode, 401);
  assert.equal(err.code, 'authentication_required');
});

test('健康闸门：过期登录记录不永久拦截', () => {
  const now = Date.now();
  const err = accountHealthError('aws', { aws: { state: 'login_required', checkedAt: now - 31 * 60 * 1000 } });
  assert.equal(err, null);
});

test('健康闸门：额度未恢复返回 429，已恢复放行', () => {
  const now = Date.now();
  assert.equal(accountHealthError('aws', { aws: { state: 'quota_exceeded', resetAt: now + 1000 } }).statusCode, 429);
  assert.equal(accountHealthError('aws', { aws: { state: 'quota_exceeded', resetAt: now - 1000 } }), null);
});

test('健康闸门：error 状态返回 503，不能被当成健康账号', () => {
  const err = accountHealthError('aws', { aws: { state: 'error', message: '输入区缺失' } });
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, 'provider_unavailable');
  assert.match(err.message, /输入区缺失/);
});

test('健康闸门：makeAccountHealthCheck 按账号读取', () => {
  const check = makeAccountHealthCheck({ aws: { state: 'error', message: '挂了' } });
  assert.equal(check({ modelId: 'aws' }).statusCode, 503);
  assert.equal(check({ modelId: 'other' }), null);
});
