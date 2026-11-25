/**
 * 账号调度器：别名池、账号级串行、队列与健康过滤。
 */
import {
  effectiveModelAlias, groupAccountsByAlias, createAccountScheduler,
} from '../bridge/account-scheduler.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

function account(modelId, modelAlias) {
  return { modelId, modelAlias, createdAt: 1 };
}

function healthErrorFor(id) {
  return (acc) => (acc.modelId === id
    ? { statusCode: 401, code: 'authentication_required', message: '未登录' }
    : null);
}

test('别名：缺省回退 modelId，显式别名优先生效', () => {
  assert.equal(effectiveModelAlias(account('aws')), 'aws');
  assert.equal(effectiveModelAlias(account('aws-2', 'quick')), 'quick');
  assert.equal(effectiveModelAlias(account('aws-3', '  ')), 'aws-3');
  assert.equal(effectiveModelAlias(null), '');
});

test('别名分组：同别名多个账号进入同一池', () => {
  const groups = groupAccountsByAlias([
    account('aws', 'quick'), account('aws-2', 'quick'), account('aws-3'),
  ]);
  assert.equal(groups.get('quick').length, 2);
  assert.equal(groups.get('aws-3').length, 1);
});

test('单账号：第二轮排队，释放后按 FIFO 获得槽位', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 4, maxWaitMs: 5000 });
  const accounts = [account('aws')];
  const first = await s.acquire({ accounts, alias: 'aws' });
  assert.equal(first.account.modelId, 'aws');
  assert.equal(s.statsFor('aws').active, true);

  const secondPromise = s.acquire({ accounts, alias: 'aws' });
  assert.equal(s.statsFor('aws').queued, 1);
  first.release();
  const second = await secondPromise;
  assert.equal(second.account.modelId, 'aws');
  assert.equal(s.statsFor('aws').active, true);
  second.release();
  assert.equal(s.statsFor('aws').active, false);
});

test('多账号同别名：两个请求并行落到不同账号', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000 });
  const accounts = [account('aws', 'quick'), account('aws-2', 'quick')];
  const [a, b] = await Promise.all([
    s.acquire({ accounts, alias: 'quick' }),
    s.acquire({ accounts, alias: 'quick' }),
  ]);
  assert.ok(a.account.modelId !== b.account.modelId);
  assert.equal(s.statsFor(a.account.modelId).active, true);
  assert.equal(s.statsFor(b.account.modelId).active, true);
  a.release();
  b.release();
});

test('会话粘性：指定账号即使有其它空闲账号也只排该账号', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000 });
  const accounts = [account('aws', 'quick'), account('aws-2', 'quick')];
  const holder = await s.acquire({ accounts, alias: 'quick', preferredAccountId: 'aws' });
  const queued = s.acquire({ accounts, alias: 'quick', preferredAccountId: 'aws' });
  assert.equal(s.statsFor('aws').queued, 1);
  assert.equal(s.statsFor('aws-2').active, false);
  holder.release();
  const next = await queued;
  assert.equal(next.account.modelId, 'aws');
  next.release();
});

test('健康过滤：跳过不可用账号；全部不可用返回原始错误', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000 });
  const accounts = [account('aws', 'quick'), account('aws-2', 'quick')];
  const first = await s.acquire({ accounts, alias: 'quick', accountError: healthErrorFor('aws') });
  assert.equal(first.account.modelId, 'aws-2');
  first.release();

  await assert.rejects(
    () => s.acquire({ accounts, alias: 'quick', accountError: () => ({ statusCode: 401, code: 'authentication_required', message: '未登录' }) }),
    (e) => e.code === 'authentication_required' && e.statusCode === 401,
  );
});

test('健康回调同步抛异常：不炸入口，按 fallback 503 处理', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000 });
  await assert.rejects(
    () => s.acquire({
      accounts: [account('aws')],
      alias: 'aws',
      accountError: () => { throw new Error('健康检查崩了'); },
    }),
    (e) => e.statusCode === 503 && e.code === 'account_unavailable',
  );
});

test('队列上限：满了返回 queue_full，不无限堆积', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 1, maxWaitMs: 5000 });
  const accounts = [account('aws')];
  const holder = await s.acquire({ accounts, alias: 'aws' });
  const queued = s.acquire({ accounts, alias: 'aws' });
  await assert.rejects(
    () => s.acquire({ accounts, alias: 'aws' }),
    (e) => e.code === 'queue_full' && e.statusCode === 429,
  );
  holder.release();
  (await queued).release();
});

test('队列超时：等待超过 maxWaitMs 返回 queue_timeout', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 80 });
  const accounts = [account('aws')];
  const holder = await s.acquire({ accounts, alias: 'aws' });
  await assert.rejects(
    () => s.acquire({ accounts, alias: 'aws' }),
    (e) => e.code === 'queue_timeout' && e.statusCode === 429,
  );
  holder.release();
});

test('客户端取消：排队中的请求可被 abort，活跃槽位释放', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000 });
  const accounts = [account('aws')];
  const holder = await s.acquire({ accounts, alias: 'aws' });
  const ac = new AbortController();
  const queued = s.acquire({ accounts, alias: 'aws', signal: ac.signal });
  ac.abort();
  await assert.rejects(() => queued, (e) => e.code === 'client_closed');
  assert.equal(s.statsFor('aws').queued, 0);
  holder.release();
});

test('释放时跳过已取消的等待者：不能留下 active=true 的空槽', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 100 });
  const accounts = [account('aws')];
  const holder = await s.acquire({ accounts, alias: 'aws' });

  // 模拟“abort 标志已置位，但 abort 事件还没跑”的窗口；真实网络断开的时序也可能这样。
  const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
  const queued = s.acquire({ accounts, alias: 'aws', signal });
  signal.aborted = true;
  holder.release();

  await assert.rejects(() => queued, (e) => e.code === 'client_closed');
  assert.equal(s.statsFor('aws').active, false);
  assert.equal(s.statsFor('aws').queued, 0);

  const next = await s.acquire({ accounts, alias: 'aws' });
  assert.equal(next.account.modelId, 'aws');
  next.release();
});

test('删除后重建同名账号：旧请求 release 不能误释放新请求的槽位', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000 });
  const accounts = [account('aws')];
  const old = await s.acquire({ accounts, alias: 'aws' });
  s.cancelAccount('aws', '账号已删除');
  const rebuilt = await s.acquire({ accounts, alias: 'aws' });
  assert.equal(s.statsFor('aws').active, true);

  old.release();
  assert.equal(s.statsFor('aws').active, true, '旧代际 release 不能释放新账号槽位');

  rebuilt.release();
  assert.equal(s.statsFor('aws').active, false);
});

test('删除账号：清空等待队列并拒绝等待者', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000 });
  const accounts = [account('aws')];
  const holder = await s.acquire({ accounts, alias: 'aws' });
  const queued = s.acquire({ accounts, alias: 'aws' });
  s.cancelAccount('aws', '账号已删除');
  await assert.rejects(() => queued, (e) => e.code === 'account_removed');
  assert.equal(s.statsFor('aws').active, false);
  holder.release();
});
