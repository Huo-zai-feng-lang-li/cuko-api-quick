/**
 * chat.js 断连 close 处理器单测：
 *  - 正常收尾后的 close 不重复停生成 / detach / 释放
 *  - 中途断连：先停生成，再 detach 过渡期；不置 dispatched，finish 仍可收尾
 *  - 无 detach 回退 release；stop 抛错不影响兜底释放
 *  - 重复 close 只处理一次
 */
import { createCloseHandler } from '../bridge/chat.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

/** 等 Promise 链（then/catch/finally）跑完 */
const flush = async () => { await new Promise((r) => setTimeout(r, 10)); };

function makeDeps(over = {}) {
  const state = { dispatched: false, aborted: false };
  const calls = { stop: 0, detach: 0, release: 0, clear: 0, closeChannel: 0, markAborted: 0 };
  const deps = {
    isDispatched: () => state.dispatched,
    isAborted: () => state.aborted,
    markAborted: () => { state.aborted = true; calls.markAborted++; },
    clearTimers: () => calls.clear++,
    closeChannel: () => calls.closeChannel++,
    stopGeneration: async () => { calls.stop++; },
    detach: () => calls.detach++,
    release: () => calls.release++,
    ...over,
  };
  return { deps, state, calls };
}

test('正常收尾后的 close：不停生成、不 detach、不释放、不清定时器', () => {
  const { deps, state, calls } = makeDeps();
  state.dispatched = true;
  createCloseHandler(deps)();
  assert.equal(calls.stop, 0);
  assert.equal(calls.detach, 0);
  assert.equal(calls.release, 0);
  assert.equal(calls.clear, 0);
  assert.equal(calls.closeChannel, 0);
  assert.equal(calls.markAborted, 0);
});

test('中途断连：先停生成，stop 完成后再 detach；不置 dispatched', async () => {
  let resolveStop;
  const stopPromise = new Promise((r) => { resolveStop = r; });
  const { deps, state, calls } = makeDeps({
    stopGeneration: async () => { calls.stop++; await stopPromise; },
  });

  createCloseHandler(deps)();
  assert.equal(calls.stop, 1);
  assert.equal(calls.detach, 0, 'stop 未完成前不能进入 detach');
  assert.equal(calls.markAborted, 1);
  assert.equal(calls.clear, 1);
  assert.equal(calls.closeChannel, 1);

  resolveStop();
  await flush();
  assert.equal(calls.detach, 1);
  assert.equal(calls.release, 0);
  assert.equal(state.dispatched, false, '断连不能置 dispatched，后续 finish 仍能跑完清理');
});

test('没有 detach 回调时回退立即 release', async () => {
  const { deps, calls } = makeDeps();
  delete deps.detach;
  createCloseHandler(deps)();
  await flush();
  assert.equal(calls.release, 1);
});

test('停止生成抛错不影响兜底释放', async () => {
  const { deps, calls } = makeDeps({
    stopGeneration: async () => { throw new Error('页面已断'); },
  });
  createCloseHandler(deps)();
  await flush();
  assert.equal(calls.detach, 1);
});

test('重复 close：只处理一次', async () => {
  const { deps, calls } = makeDeps();
  const handler = createCloseHandler(deps);
  handler();
  handler();
  await flush();
  assert.equal(calls.stop, 1);
  assert.equal(calls.detach, 1);
  assert.equal(calls.release, 0);
});
