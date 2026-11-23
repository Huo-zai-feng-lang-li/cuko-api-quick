/**
 * 协议层回归测试（用真实抓包样本）
 *
 * 样本：test/fixtures/quick-turn-in.json（下行）/ quick-turn-out.json（上行）
 * 抓取时间：2026-11-23，quick.aws.com 网页版真实对话
 *
 * 运行：npm test
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  esDrain, decodeOuterPayload, decodeEventStreamMessage, decodeUplinkFrame,
  encodeUplinkFrame, extractInnerEvents, QuickTurnExtractor,
} from '../bridge/quick-protocol.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

const FIX = path.join(import.meta.dirname, 'fixtures');
const loadFrames = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const toBytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

test('拆帧：单条下行消息结构正确', () => {
  const frames = loadFrames('quick-turn-in.json');
  const { messages, consumed } = esDrain(toBytes(frames[0].b64));
  assert.equal(messages.length, 1);
  assert.equal(consumed, Buffer.from(frames[0].b64, 'base64').length);
  assert.equal(messages[0].headers[':event-type'], 'rawOutputEvent');
  assert.equal(messages[0].headers[':content-type'], 'application/cbor');
});

test('CBOR 解码：第一条是 message_start', () => {
  const frames = loadFrames('quick-turn-in.json');
  const { messages } = esDrain(toBytes(frames[0].b64));
  const evt = decodeOuterPayload(messages[0].payload, messages[0].headers[':content-type']);
  assert.equal(evt.type, 'message_start');
  assert.equal(evt.payload.role, 'assistant');
  assert.ok(/^[0-9a-f-]{36}$/.test(evt.thread_id), 'thread_id 应是 UUID');
});

test('完整一轮：正文 / 用量 / 结束 / threadId', () => {
  const frames = loadFrames('quick-turn-in.json');
  const ex = new QuickTurnExtractor();
  let count = 0;
  for (const f of frames) {
    for (const m of esDrain(toBytes(f.b64)).messages) {
      const r = decodeEventStreamMessage(m);
      if (r.kind === 'event') { count++; ex.consume(r.event); }
    }
  }
  assert.ok(count >= 20, '事件数应 >= 20，实际 ' + count);
  assert.ok(ex.text.indexOf('AWS Quick') >= 0, '正文应包含 AWS Quick');
  assert.equal(ex.finished, true);
  assert.equal(ex.error, null);
  assert.equal(ex.usage.total_tokens, 70310);
  assert.equal(ex.threadId, '3e079448-101e-4a95-a95b-a3a942443ba8');
});

test('分片重组：按 7 字节切片结果一致且无残留', () => {
  const frames = loadFrames('quick-turn-in.json');
  const bytes = new Uint8Array(Buffer.concat(frames.map((f) => Buffer.from(f.b64, 'base64'))));
  let buf = new Uint8Array(0);
  const events = [];
  for (let i = 0; i < bytes.length; i += 7) {
    const r = extractInnerEvents(buf, bytes.subarray(i, Math.min(i + 7, bytes.length)));
    buf = r.rest;
    events.push(...r.events);
  }
  assert.equal(buf.length, 0);
  const ex = new QuickTurnExtractor();
  for (const e of events) ex.consume(e);
  assert.ok(ex.text.indexOf('AWS Quick') >= 0);
  assert.equal(ex.finished, true);
});

test('上行帧：编码后能被自己解回', () => {
  const inner = { type: 'user_message', payload: { thread_id: 't-1', text: '你好', agent_mode: 'smart' } };
  const frame = encodeUplinkFrame(inner);
  assert.equal(Buffer.from(frame).readUInt32BE(0), frame.length);
  const back = decodeUplinkFrame(Buffer.from(frame).toString('base64'), 2);
  assert.deepEqual(back, inner);
});

test('上行帧：真实抓包样本可解析出 user_message', () => {
  const frames = loadFrames('quick-turn-out.json');
  const parsed = frames.map((f) => decodeUplinkFrame(f.b64, 2)).filter(Boolean);
  const userMsg = parsed.find((x) => x.type === 'user_message');
  assert.ok(userMsg, '应能解出一条 user_message');
  assert.equal(userMsg.payload.agent_mode, 'smart');
  assert.equal(typeof userMsg.payload.text, 'string');
});

test('状态机：agentic 多段用空行分隔', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_start', payload: {} });
  ex.consume({ type: 'text_delta', payload: { delta: '第一步' } });
  ex.consume({ type: 'message_complete', payload: { text: '第一步', continuation_expected: true } });
  assert.equal(ex.finished, false);
  ex.consume({ type: 'message_start', payload: {} });
  ex.consume({ type: 'text_delta', payload: { delta: '第二步' } });
  assert.equal(ex.text, '第一步\n\n第二步');
  ex.consume({ type: 'message_complete', payload: { text: '第二步' } });
  assert.equal(ex.finished, true);
});

test('状态机：错误事件被记录', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'error', payload: { message: '炸了' } });
  assert.equal(ex.error, '炸了');
});

test('状态机：text_complete 全文兜底', () => {
  const ex = new QuickTurnExtractor();
  ex.consume({ type: 'message_start', payload: {} });
  ex.consume({ type: 'text_complete', payload: { text: '只有全文' } });
  assert.equal(ex.text, '只有全文');
});
