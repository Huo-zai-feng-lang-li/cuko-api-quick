/**
 * 停止服务依赖的页签关闭逻辑：只通过 CDP HTTP 接口关页面，不结束进程。
 * 用本地假 CDP 服务验证请求路径和目标过滤，不依赖真实 Chrome。
 */
import http from 'node:http';
import { closeAccountTabs } from '../bridge/chrome.js';

const assert = globalThis.__assert;

globalThis.__test('closeAccountTabs 关闭调试端口上的页面', async () => {
  const closed = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { id: 'page-1', type: 'page', url: 'https://quick.aws.com/sn/account/1/start/chat' },
        { id: 'page-2', type: 'page', url: 'https://example.com/user-tab' },
        { id: 'browser-1', type: 'browser' },
      ]));
      return;
    }
    if (req.url === '/json/close/page-1') {
      closed.push('page-1');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url === '/json/close/page-2') {
      closed.push('page-2');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await closeAccountTabs({ modelId: 'test-account', debugPort: port });
    assert.equal(result.ok, true);
    assert.equal(result.method, 'json-close');
    assert.deepEqual(closed, ['page-1']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

globalThis.__test('closeAccountTabs 端口已关闭时直接返回', async () => {
  const result = await closeAccountTabs({ modelId: 'test-account', debugPort: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'already-closed');
});
