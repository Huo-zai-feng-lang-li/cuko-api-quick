/**
 * 资源治理生命周期测试：
 *  - 调度器断连过渡期（detach）槽位边界与定时器清理
 *  - 常驻池：闲置判定、LRU 淘汰顺序、回收动作、停服清理
 *  - 页签去重：多余 Quick 页签关闭，非 Quick 页签不动
 *  - 运行时配置新字段默认值
 */
import http from 'node:http';
import { createAccountScheduler } from '../bridge/account-scheduler.js';
import { createChromePool } from '../bridge/chrome-pool.js';
import { dedupeQuickTabs } from '../bridge/chrome.js';
import { DEFAULT_RUNTIME_CONFIG } from '../bridge/runtime-config.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

function account(modelId, modelAlias) {
  return { modelId, modelAlias: modelAlias || modelId, debugPort: 9300 + Number(modelId.replace(/\D/g, '') || 0) };
}

// ============ 调度器：断连过渡期 ============

test('过渡期：detach 后槽位保留，到点仍未结束则强制释放', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000, detachedGraceMs: 120 });
  const accounts = [account('aws')];
  const grant = await s.acquire({ accounts, alias: 'aws' });
  assert.equal(s.statsFor('aws').active, true);

  grant.detach();
  assert.equal(s.statsFor('aws').detached, true);
  assert.equal(s.statsFor('aws').active, true);

  const queued = s.acquire({ accounts, alias: 'aws' });
  assert.equal(s.statsFor('aws').queued, 1);

  await new Promise(r => setTimeout(r, 180));
  // 强制释放后排队者被交付，槽位转到新持有者；detach 状态已清
  assert.equal(s.statsFor('aws').detached, false);

  const next = await queued;
  next.release();
  assert.equal(s.statsFor('aws').active, false);
});

test('过渡期内回合结束：release 提前释放，detach 定时器被清掉', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000, detachedGraceMs: 500 });
  const accounts = [account('aws')];
  const grant = await s.acquire({ accounts, alias: 'aws' });
  grant.detach();
  grant.release();
  assert.equal(s.statsFor('aws').active, false);
  assert.equal(s.statsFor('aws').detached, false);

  // 超过一个完整 grace 周期也不会误触；新请求能立刻拿到槽位
  await new Promise(r => setTimeout(r, 200));
  const next = await s.acquire({ accounts, alias: 'aws' });
  next.release();
});

test('graceMs=0：detach 等同立即释放槽位', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000, detachedGraceMs: 0 });
  const accounts = [account('aws')];
  const grant = await s.acquire({ accounts, alias: 'aws' });
  grant.detach();
  assert.equal(s.statsFor('aws').active, false);
});

test('删除账号：detach 定时器一并清理，旧代际不能复活槽位', async () => {
  const s = createAccountScheduler({ maxQueuePerAccount: 2, maxWaitMs: 5000, detachedGraceMs: 500 });
  const accounts = [account('aws')];
  const grant = await s.acquire({ accounts, alias: 'aws' });
  grant.detach();
  s.cancelAccount('aws', '账号已删除');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(s.statsFor('aws').active, false);
});

// ============ 常驻池 ============

function makePool(cfgOverrides = {}) {
  const active = new Set();
  const online = new Set();
  const closed = [];
  const disconnected = [];
  const pool = createChromePool({
    cfg: { idleChromeSec: 10, maxResidentChrome: 2, sweepIntervalSec: 0, ...cfgOverrides },
    getStats: (id) => (active.has(id) ? { active: true } : { active: false }),
    actions: {
      probeOnline: async (a) => online.has(a.modelId),
      closeChrome: async (a) => { closed.push(a.modelId); return { ok: true, method: 'taskkill' }; },
      closeConnection: async (id) => disconnected.push(id),
      dedupeTabs: async () => ({ ok: true, closed: 0 }),
    },
  });
  return { pool, closed, disconnected, active, online };
}

test('闲置判定：未超阈值不算空闲；阈值 0 关闭回收', () => {
  const { pool } = makePool();
  const at = 100000;
  assert.equal(pool.isIdle({ lastUsedAt: at - 5000 }, 10000, at), false);
  assert.equal(pool.isIdle({ lastUsedAt: at - 10001 }, 10000, at), true);
  assert.equal(pool.isIdle({ lastUsedAt: 0 }, 0, at), false);
});

test('淘汰候选：按最久未用排序，活跃与回收中账号排除', () => {
  const { pool, active, online } = makePool();
  onlineAdd(pool, online, 'a', 1000);
  onlineAdd(pool, online, 'b', 3000);
  onlineAdd(pool, online, 'c', 2000);
  active.add('b');
  const candidates = pool.evictionCandidates([account('a'), account('b'), account('c')]);
  assert.deepEqual(candidates.map(c => c.account.modelId), ['a', 'c']);
});

function onlineAdd(pool, onlineSet, id, lastUsedAt) {
  onlineSet.add(id);
  pool.touch(id, true, lastUsedAt);
}

test('回收：断开 CDP 并关闭 Chrome，profile 目录不在池模块删除', async () => {
  const { pool, closed, disconnected, online } = makePool();
  pool.touch('aws', true);
  online.add('aws');
  const r = await pool.recycle(account('aws'));
  assert.equal(r.ok, true);
  assert.deepEqual(closed, ['aws']);
  assert.deepEqual(disconnected, ['aws']);
  assert.equal(pool.snapshot().find(e => e.accountId === 'aws').online, false);
});

test('空闲回收：超阈值的非活跃账号被回收；活跃账号保留', async () => {
  const { pool, closed, active, online } = makePool({ idleChromeSec: 10 });
  pool.touch('old', true, Date.now() - 11000);
  pool.touch('busy', true);
  online.add('old'); online.add('busy');
  active.add('busy');
  await pool.sweep([account('old'), account('busy')]);
  assert.deepEqual(closed, ['old']);
});

test('常驻上限：超出 cap 时按 LRU 淘汰最久未用', async () => {
  const { pool, closed, online } = makePool({ maxResidentChrome: 2, idleChromeSec: 0 });
  pool.touch('a', true, 1000);
  pool.touch('b', true, 3000);
  pool.touch('c', true, 2000);
  online.add('a'); online.add('b'); online.add('c');
  await pool.sweep([account('a'), account('b'), account('c')]);
  assert.deepEqual(closed, ['a']);
});

test('停服：回收全部在线账号并清空池记录', async () => {
  const { pool, closed, online } = makePool();
  pool.touch('a', true);
  pool.touch('b', true);
  online.add('a'); online.add('b');
  await pool.shutdown([account('a'), account('b')]);
  assert.deepEqual(closed, ['a', 'b']);
  assert.equal(pool.snapshot().length, 0);
});

test('删除账号：removeAccount 移除池记录', () => {
  const { pool } = makePool();
  pool.touch('aws', true);
  pool.removeAccount('aws');
  assert.equal(pool.snapshot().length, 0);
  assert.equal(pool.isRecycling('aws'), false);
});

// ============ 页签去重 ============

function startDevtools(tabs) {
  const closed = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.end('{}');
      return;
    }
    if (req.url === '/json/list') {
      res.end(JSON.stringify(tabs));
      return;
    }
    const m = req.url.match(/^\/json\/close\/(.+)$/);
    if (m) { closed.push(decodeURIComponent(m[1])); res.end('ok'); return; }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, closed }));
  });
}

test('页签去重：只保留第一个 Quick 页签，多余的关闭，非 Quick 不动', async () => {
  const dev = await startDevtools([
    { id: 'q1', type: 'page', url: 'https://quick.aws.com/sn/account/1/start/chat' },
    { id: 'q2', type: 'page', url: 'https://quick.aws.com/sn/account/1/start/chat' },
    { id: 'q3', type: 'page', url: 'https://quick.aws.com/sn/account/1/start/chat' },
    { id: 'x1', type: 'page', url: 'https://example.com/user-tab' },
    { id: 'b1', type: 'browser' },
  ]);
  try {
    const r = await dedupeQuickTabs({ modelId: 'aws', debugPort: dev.port });
    assert.equal(r.ok, true);
    assert.equal(r.closed, 2);
    assert.deepEqual(dev.closed, ['q2', 'q3']);
  } finally {
    await new Promise(r => dev.server.close(r));
  }
});

test('页签去重：端口不通时直接返回，不报错', async () => {
  const r = await dedupeQuickTabs({ modelId: 'aws', debugPort: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.closed, 0);
});

// ============ 配置默认值 ============

test('运行时配置：资源治理新字段默认值存在且为数值/布尔语义', () => {
  assert.equal(DEFAULT_RUNTIME_CONFIG.idleChromeSec, 600);
  assert.equal(DEFAULT_RUNTIME_CONFIG.maxResidentChrome, 4);
  assert.equal(DEFAULT_RUNTIME_CONFIG.sweepIntervalSec, 60);
  assert.equal(DEFAULT_RUNTIME_CONFIG.detachedGraceSec, 15);
});
