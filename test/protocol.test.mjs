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
import net from 'node:net';
import {
  esDrain, decodeOuterPayload, decodeEventStreamMessage, decodeUplinkFrame,
  encodeUplinkFrame, extractInnerEvents, QuickTurnExtractor,
} from '../bridge/quick-protocol.js';
import { parseQuickUrl, buildConversationUrl, isOnConversation, extractThreadIdFromUrl, buildChatUrl } from '../bridge/page.js';
import { DEFAULT_PROFILE_VALUES, validateProfile } from '../bridge/default-config.js';
import { DEFAULT_RUNTIME_CONFIG } from '../bridge/runtime-config.js';
import { splitOversizedTexts, materializeFileItems, TEXT_TO_FILE_THRESHOLD, safeFileName, cleanupAttachments } from '../bridge/attachments.js';
import { commandLineMatchesProfile } from '../bridge/profile-check.js';
import { CdpConnection } from '../bridge/cdp-connection.js';
import { QuickChannel } from '../bridge/quick-transport.js';
import { isPortFree } from '../bridge/chrome.js';
import { createSerialLock } from '../bridge/serial-lock.js';

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
  assert.equal(ex.threadId, '00000000-0000-4000-8000-000000000004');
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

// ============ 会话 URL 解析（续接依赖它，回归重点） ============
const CA = '00000000-0000-4000-8000-000000000001';
const CB = '00000000-0000-4000-8000-000000000002';
const ACCT = '123456789012';
const chatUrl = (cid) => 'https://quick.aws.com/sn/account/' + ACCT + '/start/chat' + (cid ? '?conversationId=' + cid : '');

test('URL 解析：带会话', () => {
  assert.deepEqual(parseQuickUrl(chatUrl(CA)), { accountId: ACCT, conversationId: CA });
});

test('URL 解析：不带会话', () => {
  assert.deepEqual(parseQuickUrl(chatUrl()), { accountId: ACCT, conversationId: null });
});

test('URL 解析：多查询参数', () => {
  const u = 'https://quick.aws.com/sn/account/' + ACCT + '/start/chat?foo=1&conversationId=' + CA + '&bar=2';
  assert.equal(parseQuickUrl(u).conversationId, CA);
});

test('URL 解析：非法输入不抛异常', () => {
  assert.deepEqual(parseQuickUrl(''), { accountId: null, conversationId: null });
  assert.deepEqual(parseQuickUrl('https://example.com/x'), { accountId: null, conversationId: null });
});

test('构造会话 URL 后能被解析回', () => {
  const built = buildConversationUrl(ACCT, CB);
  assert.equal(parseQuickUrl(built).conversationId, CB);
  assert.equal(parseQuickUrl(built).accountId, ACCT);
});

test('会话判定：只有 id 完全相同才算在同一会话', () => {
  assert.equal(isOnConversation(chatUrl(CA), CA), true);
  assert.equal(isOnConversation(chatUrl(CB), CA), false);
  assert.equal(isOnConversation(chatUrl(), CA), false);
  assert.equal(isOnConversation(chatUrl(CA), ''), false);
});

test('extractThreadIdFromUrl 与 parseQuickUrl 一致', () => {
  assert.equal(extractThreadIdFromUrl(chatUrl(CA)), CA);
  assert.equal(extractThreadIdFromUrl(chatUrl()), null);
});

// ============ 入口页（/sn vs /sn/start）============
test('默认 targetUrl 用 /sn/start，不是落地页 /sn', () => {
  assert.equal(DEFAULT_PROFILE_VALUES.targetUrl, 'https://quick.aws.com/sn/start');
});

test('buildChatUrl：有账号 ID 时直达聊天页', () => {
  assert.equal(buildChatUrl('123456789012'), 'https://quick.aws.com/sn/account/123456789012/start/chat');
});

test('buildChatUrl：没有账号 ID 时兜底到 /sn/start（绝不能是 /sn）', () => {
  assert.equal(buildChatUrl(null), 'https://quick.aws.com/sn/start');
  assert.equal(buildChatUrl(''), 'https://quick.aws.com/sn/start');
  assert.equal(buildChatUrl(undefined), 'https://quick.aws.com/sn/start');
});

test('/sn/start 本身解析不出账号，跳转后才有', () => {
  assert.equal(parseQuickUrl('https://quick.aws.com/sn/start').accountId, null);
  assert.equal(parseQuickUrl('https://quick.aws.com/sn/account/123456789012/start/chat').accountId, '123456789012');
});

// ============ 超长文本转附件 ============
test('阈值是 20000', () => {
  assert.equal(TEXT_TO_FILE_THRESHOLD, 20000);
});

test('不超过阈值的文本原样直发', () => {
  const r = splitOversizedTexts([{ kind: 'text', text: 'x'.repeat(20000) }]);
  assert.equal(r.files.length, 0);
  assert.equal(r.inlineTexts.length, 1);
});

test('超过阈值转成附件，并生成摘要', () => {
  const r = splitOversizedTexts([{ kind: 'text', text: 'y'.repeat(20001) }]);
  assert.equal(r.files.length, 1);
  assert.equal(r.inlineTexts.length, 0);
  assert.equal(r.summaryNotes.length, 1);
  assert.ok(r.summaryNotes[0].includes('已作为附件发送'));
  cleanupAttachments(r.files);
});

test('文件名清洗掉 Windows 非法字符', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

// ============ base64 文件项 ============
test('base64 文件项落盘且内容一致', () => {
  const content = '暗号：测试-1234';
  const r = materializeFileItems([{
    kind: 'file', filename: 'x.txt', mimeType: 'text/plain',
    data: Buffer.from(content, 'utf8').toString('base64'),
  }]);
  assert.equal(r.files.length, 1);
  assert.equal(r.errors.length, 0);
  assert.ok(r.files[0].fileName.endsWith('.txt'), '应保留扩展名');
  const back = fs.readFileSync(r.files[0].filePath, 'utf8');
  assert.equal(back, content);
  cleanupAttachments(r.files);
});

test('base64 支持 data:URL 前缀', () => {
  const b64 = Buffer.from('hello', 'utf8').toString('base64');
  const r = materializeFileItems([{ kind: 'file', filename: 'a.md', data: 'data:text/plain;base64,' + b64 }]);
  assert.equal(r.files.length, 1);
  cleanupAttachments(r.files);
});

test('空 data 与非法 base64 都要报错，不产生垃圾文件', () => {
  const r1 = materializeFileItems([{ kind: 'file', filename: 'e.txt', data: '' }]);
  assert.equal(r1.files.length, 0);
  assert.equal(r1.errors.length, 1);

  const r2 = materializeFileItems([{ kind: 'file', filename: 'b.txt', data: '!!!bad!!!' }]);
  assert.equal(r2.files.length, 0);
  assert.equal(r2.errors.length, 1);
});

test('只用 file 项、text 项不受影响', () => {
  const b64 = Buffer.from('z', 'utf8').toString('base64');
  const r = materializeFileItems([{ kind: 'text', text: 'hi' }, { kind: 'file', filename: 'z.txt', data: b64 }]);
  assert.equal(r.files.length, 1);
  cleanupAttachments(r.files);
});

// ============ 心跳 / 超时配置 ============
test('配置里有 keepAliveSec 与 idleTimeoutSec', () => {
  assert.equal(DEFAULT_PROFILE_VALUES.keepAliveSec, 20);
  assert.equal(DEFAULT_PROFILE_VALUES.idleTimeoutSec, 180);
});

test('空闲超时默认比旧硬编码 120s 更宽松', () => {
  assert.ok(DEFAULT_PROFILE_VALUES.idleTimeoutSec >= 180,
    '默认空闲超时应该 >= 180s，实际 ' + DEFAULT_PROFILE_VALUES.idleTimeoutSec);
});

test('requestTimeoutSec 仍是总兜底，且大于 idleTimeoutSec', () => {
  assert.ok(DEFAULT_PROFILE_VALUES.requestTimeoutSec > DEFAULT_PROFILE_VALUES.idleTimeoutSec);
});

test('新字段能被校验并接受合法值', () => {
  const v = validateProfile({ keepAliveSec: 10, idleTimeoutSec: 300 });
  assert.equal(v.keepAliveSec, 10);
  assert.equal(v.idleTimeoutSec, 300);
});

test('新字段拒绝负数', () => {
  let threw = false;
  try { validateProfile({ idleTimeoutSec: -1 }); } catch { threw = true; }
  assert.ok(threw, '负数应该被拒绝');
});

// ============ 启动后自动打开管理后台 ============
test('autoOpenAdmin 默认开启', () => {
  assert.equal(DEFAULT_RUNTIME_CONFIG.autoOpenAdmin, true);
});

test('openInBrowser 是函数且空 URL 直接返回 false', async () => {
  const { openInBrowser } = await import('../bridge/open-browser.js');
  assert.equal(typeof openInBrowser, 'function');
  assert.equal(await openInBrowser(''), false);
});

// ============ Chrome profile 归属校验 ============
const PROFILES_ROOT = path.join('C:\\', 'Cuko', 'data', 'profiles');

test('profile 校验：Windows 引号路径能匹配', () => {
  const cmd = 'chrome.exe --user-data-dir="' + path.join(PROFILES_ROOT, 'aws') + '" --remote-debugging-port=9222';
  assert.equal(commandLineMatchesProfile(cmd, 'aws', PROFILES_ROOT), true);
});

test('profile 校验：aws 不会误匹配 aws2 / aws-2', () => {
  const aws2 = 'chrome.exe --user-data-dir="' + path.join(PROFILES_ROOT, 'aws2') + '" --remote-debugging-port=9223';
  const awsDash = 'chrome.exe --user-data-dir="' + path.join(PROFILES_ROOT, 'aws-2') + '" --remote-debugging-port=9224';
  assert.equal(commandLineMatchesProfile(aws2, 'aws', PROFILES_ROOT), false);
  assert.equal(commandLineMatchesProfile(awsDash, 'aws', PROFILES_ROOT), false);
});

test('profile 校验：正斜杠、无引号也能匹配', () => {
  const cmd = 'chrome.exe --user-data-dir=C:/Cuko/data/profiles/aws --headless';
  assert.equal(commandLineMatchesProfile(cmd, 'aws', PROFILES_ROOT), true);
});

test('profile 校验：尾部斜杠也能匹配', () => {
  const cmd = 'chrome.exe --user-data-dir="C:\\Cuko\\data\\profiles\\aws\\" --flag';
  assert.equal(commandLineMatchesProfile(cmd, 'aws', PROFILES_ROOT), true);
});

test('profile 校验：缺少 user-data-dir 时拒绝', () => {
  assert.equal(commandLineMatchesProfile('chrome.exe --remote-debugging-port=9222', 'aws', PROFILES_ROOT), false);
});

// ============ 端口分配与并发写保护 ============
test('端口检查：被 TCP 服务占用时返回 false，释放后返回 true', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  assert.equal(await isPortFree(port), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortFree(port), true);
});

test('串行锁：任务按入队顺序执行，前一个失败不阻塞后续', async () => {
  const lock = createSerialLock();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = lock(async () => {
    order.push('a-start');
    await gate;
    order.push('a-end');
  });
  const second = lock(async () => { order.push('b'); });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);

  let failure = null;
  const failed = lock(async () => { throw new Error('boom'); }).catch((e) => { failure = e; });
  const after = lock(async () => { order.push('c'); });
  await failed;
  await after;
  assert.equal(failure.message, 'boom');
  assert.equal(order[order.length - 1], 'c');
});

// ============ CDP 作用域回收 ============
test('QuickChannel.close 会把作用域从连接里摘掉', () => {
  const conn = new CdpConnection({ modelId: '__scope_test__', debugPort: 9999 });
  const channel = new QuickChannel(conn.createScope());
  assert.equal(conn.scopes.size, 1);
  channel.close();
  assert.equal(conn.scopes.size, 0, 'close 后不能留下作用域，否则每轮对话都会泄漏');
  assert.equal(channel.closed, true);
  channel.close(); // 幂等
  assert.equal(conn.scopes.size, 0);
});
