/**
 * Quick 页签自愈测试：不依赖真实 Chrome，用本地 HTTP 模拟 DevTools 端点。
 */
import http from 'node:http';

import { ensureConnection, reopenTarget } from '../bridge/chrome.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

function startDevtools() {
  let created = 0;
  let newCount = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/json/version') {
      res.end('{"Browser":"FakeChrome"}');
      return;
    }
    if (url.pathname === '/json/list') {
      const list = created > 0
        ? [{ type: 'page', url: 'https://quick.aws.com/sn/account/1/start/chat' }]
        : [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(list));
      return;
    }
    if (url.pathname === '/json/new') {
      newCount++;
      created++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'page', url: 'https://quick.aws.com/sn/start' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      count: () => newCount,
    }));
  });
}

function close(server) {
  return new Promise(r => server.close(r));
}

test('页签自愈：target 缺失时补开一次并重连', async () => {
  const dev = await startDevtools();
  const account = { modelId: 'aws', debugPort: dev.port };
  let calls = 0;
  const getConnection = async () => {
    calls++;
    if (calls === 1) throw new Error('找不到目标页面 target（quick.aws.com）');
    return { ok: true };
  };
  try {
    const conn = await ensureConnection(account, { targetUrl: 'https://quick.aws.com/sn/start' }, getConnection);
    assert.equal(conn.ok, true);
    assert.equal(calls, 2);
    assert.equal(dev.count(), 1);
  } finally {
    await close(dev.server);
  }
});

test('页签自愈：非 target 错误不补开页签', async () => {
  const dev = await startDevtools();
  const account = { modelId: 'aws', debugPort: dev.port };
  try {
    await assert.rejects(
      () => ensureConnection(account, {}, async () => { throw new Error('profile 不匹配'); }),
      (e) => e.message.includes('profile 不匹配'),
    );
    assert.equal(dev.count(), 0);
  } finally {
    await close(dev.server);
  }
});

test('页签自愈：同账号并发只补开一次', async () => {
  const dev = await startDevtools();
  const account = { modelId: 'aws', debugPort: dev.port };
  try {
    const [a, b] = await Promise.all([
      reopenTarget(account, { targetUrl: 'https://quick.aws.com/sn/start' }),
      reopenTarget(account, { targetUrl: 'https://quick.aws.com/sn/start' }),
    ]);
    assert.equal(dev.count(), 1);
    assert.equal(a.url, b.url);
  } finally {
    await close(dev.server);
  }
});
