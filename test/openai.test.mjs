/**
 * OpenAI 兼容层回归测试。
 *
 * 不需要 Chrome / Quick 登录：协议、SSE、会话和 HTTP 入口都用假数据验证。
 */
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildToolInstruction, parseToolCalls, formatResponsesPrompt, formatChatPrompt,
  normalizeResponsesInput, normalizeChatMessages, makeId, extractImageAttachments,
} from '../bridge/openai/protocol.js';
import { createSessionStore, responseSessionKey, chatSessionKey, hashText } from '../bridge/openai/session-store.js';
import { CukoSink } from '../bridge/openai/cuko-sink.js';
import {
  writeResponsesJson, streamResponses, writeChatJson, streamChat,
} from '../bridge/openai/writers.js';
import { handleOpenAIRequest } from '../bridge/openai/handler.js';
import { createAccountScheduler } from '../bridge/account-scheduler.js';
import { cleanupAttachments } from '../bridge/attachments.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

function fakeRes() {
  const chunks = [];
  let ended = false;
  let headersSent = false;
  let status = 200;
  const headers = {};
  const emitter = new EventEmitter();
  return {
    get writableEnded() { return ended; },
    get headersSent() { return headersSent; },
    socket: { setNoDelay() {} },
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    writeHead(code, h) { status = code; headersSent = true; if (h) Object.assign(headers, h); },
    flushHeaders() { headersSent = true; },
    write(chunk) { if (ended) return false; chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk != null) chunks.push(String(chunk)); ended = true; },
    on(...args) { emitter.on(...args); return this; },
    off(...args) { emitter.off(...args); return this; },
    emit(...args) { emitter.emit(...args); return this; },
    get statusCode() { return status; },
    get body() { return chunks.join(''); },
    get headers() { return headers; },
  };
}

function sse(event, data) {
  return 'event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n';
}

function parseSse(body) {
  return String(body || '').split('\n\n').map(block => {
    const lines = block.split('\n');
    const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim() || '';
    const data = lines.find(l => l.startsWith('data:'))?.slice(5).trim() || '';
    if (!data || data === '[DONE]') return null;
    try { return { event, data: JSON.parse(data) }; } catch { return null; }
  }).filter(Boolean);
}

// ---------- 协议 ----------

test('OpenAI 工具说明：function 与 custom 都能展开', () => {
  const text = buildToolInstruction([
    { type: 'function', name: 'shell', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { type: 'custom', name: 'apply_patch', description: '应用补丁' },
  ], 'auto');
  assert.ok(text.includes('shell'));
  assert.ok(text.includes('command'));
  assert.ok(text.includes('apply_patch'));
  assert.ok(text.includes('<tool_call>'));
  assert.equal(buildToolInstruction([], 'auto'), '');
  assert.equal(buildToolInstruction([{ type: 'function', name: 'x' }], 'none'), '');
});

test('工具解析：function call 与正文分离', () => {
  const tools = [{ type: 'function', name: 'shell', parameters: { type: 'object' } }];
  const parsed = parseToolCalls('我先看一下。\n<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>', tools);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].type, 'function');
  assert.equal(parsed.calls[0].name, 'shell');
  assert.equal(parsed.calls[0].arguments, '{"command":"ls"}');
  assert.equal(parsed.text, '我先看一下。');
});

test('工具解析：custom call 走 input 字段', () => {
  const tools = [{ type: 'custom', name: 'apply_patch' }];
  const parsed = parseToolCalls('<tool_call>{"name":"apply_patch","input":"*** Begin Patch\\n*** End Patch"}</tool_call>', tools);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].type, 'custom');
  assert.equal(parsed.calls[0].name, 'apply_patch');
  assert.ok(parsed.calls[0].input.includes('*** Begin Patch'));
  assert.equal(parsed.text, '');
});

test('工具解析：未知工具不生成调用，也不泄漏内部块', () => {
  const parsed = parseToolCalls('正文\n<tool_call>{"name":"nope","arguments":{}}</tool_call>', [
    { type: 'function', name: 'shell' },
  ]);
  assert.equal(parsed.calls.length, 0);
  assert.equal(parsed.text, '正文');
});

test('工具解析：JSON 代码块可作为工具调用', () => {
  const parsed = parseToolCalls('```json\n{"name":"shell","arguments":{"command":"pwd"}}\n```', [
    { type: 'function', name: 'shell' },
  ]);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].arguments, '{"command":"pwd"}');
});

test('工具解析：客户端没给 tools 时也剥离内部块', () => {
  const parsed = parseToolCalls('正文<tool_call>{"name":"shell","arguments":{}}</tool_call>', []);
  assert.equal(parsed.calls.length, 0);
  assert.equal(parsed.text, '正文');
});

test('工具解析：未闭合的标签和围栏不泄漏到正文', () => {
  const tools = [{ type: 'function', name: 'shell' }];
  const tag = parseToolCalls('正文\n<tool_call>{"name":"shell","arguments":{"command":"ls"}', tools);
  assert.equal(tag.calls.length, 0);
  assert.ok(!tag.text.includes('<tool_call>'));
  const fence = parseToolCalls('正文\n```tool_call\n{"name":"shell","arguments":{}}', tools);
  assert.equal(fence.calls.length, 0);
  assert.ok(!fence.text.includes('```tool_call'));
});

test('工具解析：非法 arguments 字符串不当成工具调用', () => {
  const parsed = parseToolCalls('<tool_call>{"name":"shell","arguments":"not-json"}</tool_call>', [
    { type: 'function', name: 'shell' },
  ]);
  assert.equal(parsed.calls.length, 0);
  assert.equal(parsed.text, '');
});

test('空输入：只有空白时提示词为空', () => {
  assert.equal(formatResponsesPrompt({ input: '   ' }), '');
  assert.equal(formatChatPrompt({ messages: [{ role: 'user', content: ' \n\t ' }] }), '');
});

test('Responses 首次请求：instructions、工具和用户文本都在', () => {
  const prompt = formatResponsesPrompt({
    instructions: '简洁回答',
    input: [{ role: 'user', content: [{ type: 'input_text', text: '读一下文件' }] }],
    tools: [{ type: 'function', name: 'read_file', description: '读文件', parameters: { type: 'object' } }],
  });
  assert.ok(prompt.includes('System'));
  assert.ok(prompt.includes('简洁回答'));
  assert.ok(prompt.includes('外部工具调用规则'));
  assert.ok(prompt.includes('read_file'));
  assert.ok(prompt.includes('User'));
  assert.ok(prompt.includes('读一下文件'));
});

test('Responses 续接：只发工具结果', () => {
  const prompt = formatResponsesPrompt({
    input: [{ type: 'function_call_output', call_id: 'call_1', output: '文件内容' }],
    tools: [{ type: 'function', name: 'read_file' }],
  }, { continuation: true });
  assert.ok(prompt.includes('Tool result (call_1)'));
  assert.ok(prompt.includes('文件内容'));
  assert.ok(!prompt.includes('外部工具调用规则'));
});

test('Responses 续接：用户新消息优先于旧工具结果', () => {
  const prompt = formatResponsesPrompt({
    input: [
      { role: 'user', content: '旧问题' },
      { type: 'function_call_output', call_id: 'call_1', output: '旧工具结果' },
      { role: 'user', content: '新问题' },
    ],
    tools: [{ type: 'function', name: 'read_file' }],
  }, { continuation: true });
  assert.equal(prompt, '新问题');
});

test('Chat 首次与续接：消息转写正确', () => {
  const first = formatChatPrompt({
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
  });
  assert.ok(first.includes('System'));
  assert.ok(first.includes('助手'));
  assert.ok(first.includes('User'));
  const cont = formatChatPrompt({
    messages: [
      { role: 'assistant', content: '要调用工具' },
      { role: 'tool', tool_call_id: 'call_2', content: '结果' },
    ],
  }, { continuation: true });
  assert.ok(cont.includes('Tool result (call_2)'));
  assert.ok(cont.includes('结果'));
});

test('空输入：normalize 返回空数组，prompt 为空', () => {
  assert.deepEqual(normalizeResponsesInput(undefined), []);
  assert.deepEqual(normalizeChatMessages(undefined), []);
  assert.equal(formatResponsesPrompt({ input: [] }), '');
  assert.equal(formatChatPrompt({ messages: [] }), '');
});

test('图片附件：Chat 最后一条 user 的 data URL 被提取', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const body = {
    model: 'aws',
    messages: [
      { role: 'user', content: '旧图', image_url: { url: png } },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image_url', image_url: { url: png } },
      ] },
    ],
  };
  const files = extractImageAttachments(body, 'chat');
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, 'file');
  assert.equal(files[0].filename, 'image-1.png');
  assert.equal(files[0].mimeType, 'image/png');
  assert.equal(files[0].data, png);
  assert.ok(formatChatPrompt(body).includes('[图片输入暂不支持：当前只转发文本]'));
});

test('图片附件：Responses input_image 与非法 URL 处理', () => {
  const jpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const files = extractImageAttachments({
    model: 'aws',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '看图' }, { type: 'input_image', image_url: jpg }] },
    ],
  }, 'responses');
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'image-1.jpg');
  assert.equal(extractImageAttachments({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] }] }).length, 0);
});

test('HTTP Chat 图片：落盘为附件并替换提示词占位', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const res = fakeRes();
  const deps = makeDeps({ text: '看到了' });
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'aws',
      conversation_id: 'image-s1',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: png } },
      ] }],
    }),
    res,
    pathname: '/openai/v1/chat/completions',
    deps,
  });
  const payload = deps.calls[0].payload;
  assert.equal(payload._attachFiles.length, 1);
  assert.equal(payload._attachFiles[0].endsWith('.png'), true);
  assert.ok(payload._text.includes('图片附件：本轮已通过附件上传 1 张图片'));
  assert.ok(!payload._text.includes('图片输入暂不支持'));
  cleanupAttachments(payload._attachMeta);
});

test('HTTP 停止入口：没有活动回合时返回 no-active-turn', async () => {
  const res = fakeRes();
  const deps = makeDeps();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', conversation_id: 'cuckoo-js:s1' }),
    res,
    pathname: '/openai/v1/chat/completions/stop',
    deps,
  });
  assert.equal(res.statusCode, 200);
  const obj = JSON.parse(res.body);
  assert.equal(obj.ok, false);
  assert.equal(obj.reason, 'no-active-turn');
});

// ---------- 会话 ----------

test('会话存储：写入、命中、过期与 LRU', async () => {
  const store = createSessionStore({ ttlMs: 20, maxEntries: 2 });
  store.set('a', 'p1');
  assert.equal(store.get('a'), 'p1');
  store.set('b', 'p2');
  store.set('c', 'p3');
  assert.equal(store.size, 2);
  assert.equal(store.get('a'), null);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(store.get('b'), null);
});

test('会话存储：对象值保持对象，不会被 String() 成 [object Object]', () => {
  const store = createSessionStore();
  store.set('resp:r1', { providerSessionId: 'p1', accountId: 'aws-1' });
  assert.deepEqual(store.get('resp:r1'), { providerSessionId: 'p1', accountId: 'aws-1' });
});

test('会话存储：文件持久化后新实例可续接，且滑动 TTL 会落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuko-openai-sess-'));
  const file = path.join(dir, 'sessions.json');
  try {
    let now = 1000;
    const first = createSessionStore({ filePath: file, ttlMs: 100, now: () => now });
    first.set('chat:aws:s1', { providerSessionId: 'p1', accountId: 'aws-1' });
    now = 1050;
    assert.deepEqual(first.get('chat:aws:s1'), { providerSessionId: 'p1', accountId: 'aws-1' });

    // 模拟网关重启：新实例从同一个文件恢复，不能丢 providerSessionId。
    const second = createSessionStore({ filePath: file, ttlMs: 100, now: () => now });
    assert.deepEqual(second.get('chat:aws:s1'), { providerSessionId: 'p1', accountId: 'aws-1' });

    now = 1151; // 1050 触碰后过期；第二次启动不能把旧线程当成有效映射
    const third = createSessionStore({ filePath: file, ttlMs: 100, now: () => now });
    assert.equal(third.get('chat:aws:s1'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会话存储：坏文件不阻塞启动，按空仓库处理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuko-openai-sess-bad-'));
  const file = path.join(dir, 'sessions.json');
  try {
    fs.writeFileSync(file, '{bad json', 'utf8');
    const store = createSessionStore({ filePath: file });
    assert.equal(store.size, 0);
    store.set('k', 'v');
    assert.equal(store.get('k'), 'v');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会话键：previous_response_id 与 Chat 显式键', () => {
  assert.equal(responseSessionKey('resp_1'), 'resp:resp_1');
  const body = { model: 'aws', messages: [{ role: 'user', content: '同一段话' }] };
  assert.equal(chatSessionKey(body, {}), '');
  assert.equal(chatSessionKey(body, { 'x-session-id': 's1' }), 'chat:aws:s1');
  assert.equal(chatSessionKey({ ...body, conversation_id: 'c1' }, {}), 'chat:aws:c1');
  assert.equal(chatSessionKey({ ...body, user: 'u1' }, {}), '');
  assert.equal(chatSessionKey({ ...body, model: 'other', conversation_id: 'c1' }, {}), 'chat:other:c1');
  assert.equal(hashText('x').length, 24);
});

// ---------- Cuko sink ----------

test('Cuko sink：分片 SSE 解析 text/session/done', () => {
  const sink = new CukoSink();
  const events = [];
  sink.on('text', t => events.push(['text', t]));
  sink.on('session', id => events.push(['session', id]));
  sink.on('done', d => events.push(['done', d.finishReason]));
  sink.write('event: mess');
  sink.write('age\ndata: {"output":["你"],"providerSessionId":"p1"}\n\n');
  sink.write(sse('done', { providerSessionId: 'p1', finishReason: 'stop' }));
  sink.write(': keepalive\n\n');
  assert.deepEqual(events, [['session', 'p1'], ['text', '你'], ['session', 'p1'], ['done', 'stop']]);
});

test('Cuko sink：error 事件带 code', () => {
  const sink = new CukoSink();
  let err = null;
  sink.on('cuko-error', e => { err = e; });
  sink.write(sse('error', { code: 'request_timeout', message: '超时' }));
  assert.equal(err.code, 'request_timeout');
  assert.equal(err.message, '超时');
});

// ---------- Writers ----------

test('Responses JSON：文本与 function call 输出项', () => {
  const res = fakeRes();
  writeResponsesJson(res, {
    id: 'resp_1', model: 'aws', text: '结果',
    calls: [{ type: 'function', name: 'shell', arguments: '{"command":"ls"}', callId: 'call_1', itemId: 'fc_1' }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    promptText: 'hi',
  });
  const obj = JSON.parse(res.body);
  assert.equal(obj.object, 'response');
  assert.equal(obj.status, 'completed');
  assert.equal(obj.output[0].type, 'message');
  assert.equal(obj.output[1].type, 'function_call');
  assert.equal(obj.output[1].call_id, 'call_1');
});

test('Responses SSE：created/delta/function_call/completed 齐全', () => {
  const res = fakeRes();
  streamResponses(res, {
    id: 'resp_2', model: 'aws', text: '你好',
    calls: [{ type: 'function', name: 'shell', arguments: '{"command":"ls"}', callId: 'call_2', itemId: 'fc_2' }],
    usage: null, promptText: 'hi',
  });
  const body = res.body;
  assert.ok(body.includes('event: response.created'));
  assert.ok(body.includes('event: response.output_text.delta'));
  assert.ok(body.includes('event: response.function_call_arguments.delta'));
  assert.ok(body.includes('event: response.completed'));
  assert.ok(body.includes('"name":"shell"'));
  const events = parseSse(body);
  assert.ok(events.every(e => e.data.type === e.event), 'event 名与 data.type 必须一致');
  const added = events.find(e => e.event === 'response.output_item.added' && e.data.item.type === 'message');
  const completed = events.find(e => e.event === 'response.completed');
  assert.equal(added.data.item.id, completed.data.response.output[0].id, '流式 item id 与 completed 输出 id 必须一致');
});

test('Chat JSON 与 SSE：tool_calls 结束状态', () => {
  const json = fakeRes();
  writeChatJson(json, {
    id: 'chat_1', model: 'aws', text: '',
    calls: [{ type: 'function', name: 'shell', arguments: '{}', callId: 'call_3', itemId: 'fc_3' }],
    usage: null, promptText: 'hi',
  });
  const obj = JSON.parse(json.body);
  assert.equal(obj.object, 'chat.completion');
  assert.equal(obj.choices[0].finish_reason, 'tool_calls');
  assert.equal(obj.choices[0].message.tool_calls[0].function.name, 'shell');

  const stream = fakeRes();
  streamChat(stream, {
    id: 'chat_2', model: 'aws', text: '好的',
    calls: [{ type: 'custom', name: 'apply_patch', input: 'patch', callId: 'call_4', itemId: 'ctc_4' }],
    usage: null, promptText: 'hi',
  });
  assert.ok(stream.body.includes('event:') === false); // Chat SSE 用 data:，不用 event:
  assert.ok(stream.body.includes('"tool_calls"'));
  assert.ok(stream.body.includes('[DONE]'));

  const usageStream = fakeRes();
  streamChat(usageStream, {
    id: 'chat_usage', model: 'aws', text: 'hi', usage: null, promptText: 'hi',
    includeUsage: true,
  });
  assert.ok(usageStream.body.includes('"choices":[]'));
  assert.ok(usageStream.body.includes('"total_tokens"'));
});

test('finishReason：超时/过滤优先于工具调用，映射到 incomplete/content_filter', () => {
  const responses = fakeRes();
  writeResponsesJson(responses, {
    id: 'resp_timeout', model: 'aws', text: '半截',
    calls: [{ type: 'function', name: 'shell', arguments: '{}', callId: 'call_5', itemId: 'fc_5' }],
    finishReason: 'timeout',
  });
  const robj = JSON.parse(responses.body);
  assert.equal(robj.status, 'incomplete');
  assert.equal(robj.incomplete_details.reason, 'timeout');

  const chat = fakeRes();
  writeChatJson(chat, {
    id: 'chat_filter', model: 'aws', text: '',
    finishReason: 'content_filter',
  });
  const cobj = JSON.parse(chat.body);
  assert.equal(cobj.choices[0].finish_reason, 'content_filter');
});

// ---------- HTTP 入口 ----------

function fakeReq(body, headers = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', ...headers };
  req.setEncoding = () => req;
  return req;
}

function makeDeps({ text = '你好', tool = false, accounts, maxQueuePerAccount = 2, chunks = null, hang = false } = {}) {
  const accountList = accounts || [{ modelId: 'aws', modelAlias: 'aws', createdAt: Date.now() }];
  // 测试环境 grace=0：detach 等价立即 release，保持既有断开断言；过渡期由专用用例用间谍 grant 验证。
  const scheduler = createAccountScheduler({ maxQueuePerAccount, maxWaitMs: 5000, detachedGraceMs: 0 });
  const activeResponses = new Map();
  const calls = [];
  const touched = [];
  return {
    getAccounts: () => accountList,
    getAccountHealth: () => ({}),
    resolveProfile: () => ({ values: { requestTimeoutSec: 900 } }),
    ensureConnection: async () => ({}),
    getConnection: () => ({}),
    scheduler,
    activeResponses,
    calls,
    touched,
    touchAccount: (id) => { touched.push(id); },
    handleChat: async ({ res, payload, account }) => {
      calls.push({ payload, accountId: account.modelId });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (chunks) {
        for (const c of chunks) {
          res.write(sse('message', { output: [c], providerSessionId: 'p1' }));
          await new Promise(r => setTimeout(r, 5));
        }
      } else {
        const t = tool
          ? '先执行\n<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>'
          : text;
        res.write(sse('message', { output: [t], providerSessionId: 'p1' }));
      }
      if (hang) await new Promise(r => setTimeout(r, 300));
      res.write(sse('done', { providerSessionId: 'p1', usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }, finishReason: 'stop' }));
      res.end();
    },
  };
}

/** 按 SSE 块顺序解析，保留事件先后（含 [DONE] 标记），用于首字早于收尾的顺序断言。 */
function orderedBlocks(body) {
  return String(body || '').split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim() || '';
    const dataLine = lines.find(l => l.startsWith('data:'))?.slice(5).trim() || '';
    if (dataLine === '[DONE]') return { event: 'done-marker', data: null };
    try { return { event, data: JSON.parse(dataLine) }; } catch { return { event, data: null }; }
  });
}

test('HTTP Responses 非流式：文本闭环', async () => {
  const res = fakeRes();
  const deps = makeDeps({ text: '你好' });
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi' }), res, pathname: '/openai/v1/responses', deps,
  });
  const obj = JSON.parse(res.body);
  assert.equal(obj.object, 'response');
  assert.equal(obj.output[0].content[0].text, '你好');
  assert.equal(deps.scheduler.statsFor('aws').active, false);
  assert.equal(deps.activeResponses.size, 0);
});

test('HTTP Responses：连接上游后刷新账号池活跃时间，避免 Chrome 被误回收', async () => {
  const res = fakeRes();
  const deps = makeDeps({ text: '你好' });
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi' }), res, pathname: '/openai/v1/responses', deps,
  });
  assert.deepEqual(deps.touched, ['aws']);
});

test('HTTP Responses 非流式：工具调用闭环', async () => {
  const res = fakeRes();
  const deps = makeDeps({ tool: true });
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'aws', input: '列目录',
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  const obj = JSON.parse(res.body);
  assert.equal(obj.output[0].type, 'message');
  assert.equal(obj.output[1].type, 'function_call');
  assert.equal(obj.output[1].name, 'shell');
  assert.equal(obj.output[1].arguments, '{"command":"ls"}');
});

test('HTTP Chat 非流式：tool_calls 闭环', async () => {
  const res = fakeRes();
  const deps = makeDeps({ tool: true });
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'aws', messages: [{ role: 'user', content: '列目录' }],
      tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }],
    }),
    res,
    pathname: '/openai/v1/chat/completions',
    deps,
  });
  const obj = JSON.parse(res.body);
  assert.equal(obj.object, 'chat.completion');
  assert.equal(obj.choices[0].finish_reason, 'tool_calls');
  assert.equal(obj.choices[0].message.tool_calls[0].function.name, 'shell');
});

test('HTTP 入口：同账号队列满时拒绝，且不泄漏槽位', async () => {
  const deps = makeDeps({ text: '慢', maxQueuePerAccount: 0 });
  const holder = await deps.scheduler.acquire({ accounts: deps.getAccounts(), alias: 'aws' });
  const res = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi' }), res, pathname: '/openai/v1/responses', deps,
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.includes('queue_full'), true);
  holder.release();
  assert.equal(deps.scheduler.statsFor('aws').active, false);
});

test('HTTP 入口：模型列表', async () => {
  const res = fakeRes();
  const deps = makeDeps();
  await handleOpenAIRequest({
    req: { method: 'GET', headers: {}, setEncoding() {} }, res, pathname: '/openai/v1/models', deps,
  });
  const obj = JSON.parse(res.body);
  assert.equal(obj.object, 'list');
  assert.equal(obj.data[0].id, 'aws');
});

test('HTTP 入口：同别名账号池聚合成一个模型，并带账号数', async () => {
  const deps = makeDeps({
    accounts: [
      { modelId: 'aws-1', modelAlias: 'quick', createdAt: 1 },
      { modelId: 'aws-2', modelAlias: 'quick', createdAt: 2 },
    ],
  });
  const res = fakeRes();
  await handleOpenAIRequest({
    req: { method: 'GET', headers: {}, setEncoding() {} }, res, pathname: '/openai/v1/models', deps,
  });
  const obj = JSON.parse(res.body);
  assert.equal(obj.data.length, 1);
  assert.equal(obj.data[0].id, 'quick');
  assert.equal(obj.data[0].meta.accounts, 2);
});

test('HTTP 入口：同别名两个账号并发，请求落到不同账号', async () => {
  const deps = makeDeps({
    accounts: [
      { modelId: 'aws-1', modelAlias: 'quick', createdAt: 1 },
      { modelId: 'aws-2', modelAlias: 'quick', createdAt: 2 },
    ],
  });
  const [a, b] = await Promise.all([
    handleOpenAIRequest({
      req: fakeReq({ model: 'quick', input: 'a' }), res: fakeRes(), pathname: '/openai/v1/responses', deps,
    }).then(() => null),
    handleOpenAIRequest({
      req: fakeReq({ model: 'quick', input: 'b' }), res: fakeRes(), pathname: '/openai/v1/responses', deps,
    }).then(() => null),
  ]);
  assert.equal(deps.calls.length, 2);
  assert.equal(new Set(deps.calls.map(c => c.accountId)).size, 2);
  assert.equal(deps.scheduler.statsFor('aws-1').active, false);
  assert.equal(deps.scheduler.statsFor('aws-2').active, false);
});

test('HTTP Responses 续接：previous_response_id 粘住同一账号', async () => {
  const deps = makeDeps({
    accounts: [
      { modelId: 'aws-1', modelAlias: 'quick', createdAt: 1 },
      { modelId: 'aws-2', modelAlias: 'quick', createdAt: 2 },
    ],
  });
  const first = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'quick', input: '第一轮' }), res: first, pathname: '/openai/v1/responses', deps,
  });
  const firstObj = JSON.parse(first.body);
  assert.equal(firstObj.model, 'quick', '响应必须回显对外别名，不能泄露内部账号 ID');
  const second = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'quick', previous_response_id: firstObj.id,
      input: [{ type: 'function_call_output', call_id: 'call_1', output: '工具结果' }],
    }), res: second, pathname: '/openai/v1/responses', deps,
  });
  assert.equal(deps.calls.length, 2);
  assert.equal(deps.calls[0].accountId, 'aws-1');
  assert.equal(deps.calls[1].accountId, 'aws-1');
  assert.equal(deps.calls[1].payload.providerSessionId, 'p1');
  assert.equal(JSON.parse(second.body).model, 'quick');
});

test('HTTP 路由：尾斜杠和错误方法', async () => {
  const deps = makeDeps();
  const slash = fakeRes();
  await handleOpenAIRequest({
    req: { method: 'GET', headers: {}, setEncoding() {} }, res: slash, pathname: '/openai/v1/models/', deps,
  });
  const slashObj = JSON.parse(slash.body);
  assert.equal(slashObj.object, 'list');
  const wrong = fakeRes();
  await handleOpenAIRequest({
    req: { method: 'GET', headers: {}, setEncoding() {} }, res: wrong, pathname: '/openai/v1/responses', deps,
  });
  assert.equal(wrong.statusCode, 405);
  const unknown = fakeRes();
  await handleOpenAIRequest({ req: fakeReq({}), res: unknown, pathname: '/openai/v1/nope', deps });
  assert.equal(unknown.statusCode, 404);
});

test('HTTP Responses 流式：事件头不重复写，且 completed 收尾', async () => {
  const res = fakeRes();
  const deps = makeDeps({ text: '流式结果' });
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  assert.equal(res.headersSent, true);
  assert.ok(res.body.includes(': keepalive') === false);
  assert.ok(res.body.includes('event: response.created'));
  assert.ok(res.body.includes('event: response.output_text.delta'));
  assert.ok(res.body.includes('event: response.completed'));
});

test('HTTP Responses 续接：previous_response_id 命中 Quick 会话，只发工具结果', async () => {
  const deps = makeDeps({ text: '第一轮' });
  const first = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: '第一轮' }), res: first, pathname: '/openai/v1/responses', deps,
  });
  const firstObj = JSON.parse(first.body);
  const second = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'aws',
      previous_response_id: firstObj.id,
      input: [{ type: 'function_call_output', call_id: 'call_1', output: '工具结果' }],
    }),
    res: second,
    pathname: '/openai/v1/responses',
    deps,
    });
  const secondObj = JSON.parse(second.body);
  assert.equal(secondObj.output[0].content[0].text, '第一轮');
  assert.equal(deps.calls.length, 2);
  assert.equal(deps.calls[1].payload.providerSessionId, 'p1');
  assert.ok(deps.calls[1].payload._text.includes('Tool result (call_1)'));
  assert.ok(!deps.calls[1].payload._text.includes('外部工具调用规则'));
});

test('HTTP Chat 流式：data: 分块与 [DONE] 收尾', async () => {
  const res = fakeRes();
  const deps = makeDeps({ text: '流式' });
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'aws', messages: [{ role: 'user', content: 'hi' }], stream: true,
    }),
    res,
    pathname: '/openai/v1/chat/completions',
    deps,
  });
  assert.ok(res.body.includes('"object":"chat.completion.chunk"'));
  assert.ok(res.body.includes('"delta":{"role":"assistant"}'));
  const first = parseSse(res.body)[0];
  assert.ok(first.data.id.startsWith('chatcmpl-'));
  assert.ok(res.body.includes('data: [DONE]'));
});

test('HTTP Responses：previous_response_id 过期且只有工具结果时明确报错', async () => {
  const res = fakeRes();
  const deps = makeDeps();
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'aws',
      previous_response_id: 'resp_does_not_exist',
      input: [{ type: 'function_call_output', call_id: 'call_x', output: '结果' }],
    }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  const obj = JSON.parse(res.body);
  assert.equal(res.statusCode, 400);
  assert.equal(obj.error.code, 'previous_response_id_not_found');
  assert.equal(deps.calls.length, 0);
});

test('HTTP Responses：previous_response_id 过期时带用户文本也不静默新建线程', async () => {
  const res = fakeRes();
  const deps = makeDeps();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', previous_response_id: 'resp_ghost', input: '新问题' }),
    res, pathname: '/openai/v1/responses', deps,
  });
  const obj = JSON.parse(res.body);
  assert.equal(res.statusCode, 400);
  assert.equal(obj.error.code, 'previous_response_id_not_found');
  assert.equal(deps.calls.length, 0);
});

test('HTTP Responses 流式错误：先 error 再 response.failed，锁释放', async () => {
  const res = fakeRes();
  const deps = makeDeps();
  deps.handleChat = async () => {
    const e = new Error('Quick 挂了');
    e.code = 'provider_unavailable';
    throw e;
  };
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('event: error'));
  assert.ok(res.body.includes('event: response.failed'));
  assert.equal(deps.scheduler.statsFor('aws').active, false);
  assert.equal(deps.activeResponses.size, 0);
});

// ---------- 增量流式回归 ----------

test('Responses 流式：首段正文 delta 早于 done 收尾写出，增量顺序正确', async () => {
  const res = fakeRes();
  const deps = makeDeps({ chunks: ['你好', '，世界'] });
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  const blocks = orderedBlocks(res.body);
  const firstDelta = blocks.findIndex(b => b.event === 'response.output_text.delta');
  const completed = blocks.findIndex(b => b.event === 'response.completed');
  assert.ok(firstDelta >= 0, '必须有正文 delta');
  assert.ok(completed > firstDelta, '第一段正文必须早于 completed 收尾写出');
  const deltas = blocks.filter(b => b.event === 'response.output_text.delta').map(b => b.data.delta);
  assert.equal(deltas.join(''), '你好，世界');
  const deltaSeq = blocks.find(b => b.event === 'response.output_text.delta').data.sequence_number;
  const completedSeq = blocks.find(b => b.event === 'response.completed').data.sequence_number;
  assert.ok(completedSeq > deltaSeq, 'sequence_number 随事件递增');
});

test('Responses 流式：sequence_number 严格单调递增、不重号不跳号', async () => {
  const res = fakeRes();
  const deps = makeDeps({ chunks: ['甲', '乙', '丙'] });
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  const seqs = orderedBlocks(res.body)
    .map(b => b.data && b.data.sequence_number)
    .filter(n => typeof n === 'number');
  assert.ok(seqs.length > 3);
  for (let i = 1; i < seqs.length; i++) {
    assert.equal(seqs[i], seqs[i - 1] + 1, 'sequence_number 必须连续递增');
  }
});

test('Chat 流式：正文 chunk 逐段写出，include_usage 与 [DONE] 保留', async () => {
  const res = fakeRes();
  const deps = makeDeps({ chunks: ['流式', '输出'] });
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'aws', messages: [{ role: 'user', content: 'hi' }], stream: true,
      stream_options: { include_usage: true },
    }),
    res,
    pathname: '/openai/v1/chat/completions',
    deps,
  });
  const blocks = orderedBlocks(res.body);
  const contents = blocks
    .filter(b => b.data && b.data.choices && b.data.choices[0] && b.data.choices[0].delta && b.data.choices[0].delta.content)
    .map(b => b.data.choices[0].delta.content);
  assert.equal(contents.join(''), '流式输出');
  const firstContent = blocks.findIndex(b => b.data && b.data.choices && b.data.choices[0] && b.data.choices[0].delta && b.data.choices[0].delta.content);
  const doneMarker = blocks.findIndex(b => b.event === 'done-marker');
  assert.ok(firstContent >= 0 && doneMarker > firstContent);
  assert.ok(blocks.some(b => b.data && Array.isArray(b.data.choices) && b.data.choices.length === 0 && b.data.usage));
  assert.ok(res.body.includes('data: [DONE]'));
});

test('Responses 流式中途错误：已开正文 item 先关闭，再 error + response.failed，锁释放', async () => {
  const res = fakeRes();
  const deps = makeDeps();
  deps.handleChat = async ({ res: sink }) => {
    sink.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sink.write(sse('message', { output: ['半截话'], providerSessionId: 'p1' }));
    sink.write(sse('error', { code: 'provider_unavailable', message: 'Quick 挂了' }));
    sink.end();
  };
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  const blocks = orderedBlocks(res.body);
  const itemDone = blocks.findIndex(b => b.event === 'response.output_item.done' && b.data.item.type === 'message');
  const error = blocks.findIndex(b => b.event === 'error');
  const failed = blocks.findIndex(b => b.event === 'response.failed');
  assert.ok(itemDone >= 0, '异常前已打开的正文 item 必须被关闭');
  assert.ok(error > itemDone, 'error 必须在正文 item 关闭之后');
  assert.ok(failed > error, 'response.failed 跟在 error 之后');
  assert.equal(deps.scheduler.statsFor('aws').active, false);
  assert.equal(deps.activeResponses.size, 0);
});

test('Responses 流式：纯工具调用空正文不发 content_part，工具项正常补发', async () => {
  const res = fakeRes();
  const deps = makeDeps();
  deps.handleChat = async ({ res: r }) => {
    r.writeHead(200, { 'Content-Type': 'text/event-stream' });
    r.write(sse('message', { output: ['<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>'] }));
    r.write(sse('done', { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }, finishReason: 'stop' }));
    r.end();
  };
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'aws', input: '列目录', stream: true,
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  assert.ok(!res.body.includes('response.content_part.added'));
  assert.ok(!res.body.includes('response.output_text.delta'));
  assert.ok(res.body.includes('response.function_call_arguments.delta'));
  assert.ok(res.body.includes('event: response.completed'));
  const completed = orderedBlocks(res.body).find(b => b.event === 'response.completed');
  assert.equal(completed.data.response.output[0].type, 'function_call');
});

test('Chat 流式：空正文纯工具调用 finish_reason 为 tool_calls，无 content delta', async () => {
  const res = fakeRes();
  const deps = makeDeps();
  deps.handleChat = async ({ res: sink }) => {
    sink.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sink.write(sse('message', { output: ['<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>'] }));
    sink.write(sse('done', { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }, finishReason: 'stop' }));
    sink.end();
  };
  await handleOpenAIRequest({
    req: fakeReq({
      model: 'aws', messages: [{ role: 'user', content: '列目录' }], stream: true,
      tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }],
    }),
    res,
    pathname: '/openai/v1/chat/completions',
    deps,
  });
  assert.ok(!res.body.includes('"content"'));
  const finishChunk = orderedBlocks(res.body)
    .find(b => b.data && b.data.choices && b.data.choices[0] && b.data.choices[0].finish_reason);
  assert.equal(finishChunk.data.choices[0].finish_reason, 'tool_calls');
  assert.ok(res.body.includes('data: [DONE]'));
});

test('流式中途断开：不抛未捕获异常，槽位释放，sink 清空', async () => {
  const res = fakeRes();
  const deps = makeDeps({ hang: true });
  const p = handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  await new Promise(r => setImmediate(r));
  res.emit('close');
  await p; // 不得 reject 出未捕获异常
  assert.equal(deps.scheduler.statsFor('aws').active, false);
  assert.equal(deps.activeResponses.size, 0);
});

// ---------- F1：普通 < 不再被永久压住 ----------

/** 按固定长度切分文本，模拟 Quick 逐段到达的增量。 */
function splitBy(text, size = 3) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function chatContentConcat(body) {
  return orderedBlocks(body)
    .filter(b => b.data && b.data.choices && b.data.choices[0] && b.data.choices[0].delta && b.data.choices[0].delta.content)
    .map(b => b.data.choices[0].delta.content)
    .join('');
}

function responsesDeltaConcat(body) {
  return orderedBlocks(body)
    .filter(b => b.event === 'response.output_text.delta')
    .map(b => b.data.delta)
    .join('');
}

function responsesFinalText(body) {
  const done = orderedBlocks(body).find(b => b.event === 'response.completed' || b.event === 'response.incomplete');
  return done.data.response.output.find(o => o.type === 'message').content[0].text;
}

const F1_PLAIN_CASES = [
  '今天天气不错，适合出门散步。',
  '比较 a < b 的大小关系。',
  '返回 HTML：<div>hello</div> 就是这样。',
];

test('F1 Chat：纯中文/比较符号/HTML 标签的 < 照常下发，content 拼接 == 最终文本', async () => {
  for (const text of F1_PLAIN_CASES) {
    const deps = makeDeps({ chunks: splitBy(text) });
    const res = fakeRes();
    await handleOpenAIRequest({
      req: fakeReq({ model: 'aws', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      res,
      pathname: '/openai/v1/chat/completions',
      deps,
    });
    assert.equal(chatContentConcat(res.body), text, 'Chat content delta 拼接必须等于最终文本: ' + text);
  }
});

test('F1 Responses：纯中文/比较符号/HTML 标签的 < 照常下发，delta 拼接 == 干净正文', async () => {
  for (const text of F1_PLAIN_CASES) {
    const deps = makeDeps({ chunks: splitBy(text) });
    const res = fakeRes();
    await handleOpenAIRequest({
      req: fakeReq({ model: 'aws', input: 'hi', stream: true }),
      res,
      pathname: '/openai/v1/responses',
      deps,
    });
    assert.equal(responsesDeltaConcat(res.body), responsesFinalText(res.body), 'Responses delta 拼接必须等于干净正文: ' + text);
    assert.equal(responsesFinalText(res.body), text);
  }
});

test('F1：部分 opener 后来被证伪（<tool 变成 <toolx）立刻解除压住并补发', async () => {
  const expect = '<toolx 是普通内容。';
  // Chat
  const chatDeps = makeDeps({ chunks: ['<tool', 'x 是普通内容。'] });
  const chatRes = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    res: chatRes,
    pathname: '/openai/v1/chat/completions',
    deps: chatDeps,
  });
  assert.equal(chatContentConcat(chatRes.body), expect);

  // Responses
  const respDeps = makeDeps({ chunks: ['<tool', 'x 是普通内容。'] });
  const respRes = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true }),
    res: respRes,
    pathname: '/openai/v1/responses',
    deps: respDeps,
  });
  assert.equal(responsesDeltaConcat(respRes.body), responsesFinalText(respRes.body));
  assert.equal(responsesFinalText(respRes.body), expect);
});

test('F1：完整 <tool_call> 工具块不泄漏到正文流，正文只保留干净文本', async () => {
  const tools = [{ type: 'function', name: 'shell', parameters: { type: 'object' } }];
  const toolBlock = '<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>';

  // Chat
  const chatDeps = makeDeps({ chunks: ['先说一句。', toolBlock] });
  const chatRes = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', messages: [{ role: 'user', content: '列目录' }], stream: true, tools: [{ type: 'function', function: { name: 'shell' } }] }),
    res: chatRes,
    pathname: '/openai/v1/chat/completions',
    deps: chatDeps,
  });
  assert.equal(chatContentConcat(chatRes.body), '先说一句。');
  assert.ok(!chatRes.body.includes('<tool_call>'));

  // Responses
  const respDeps = makeDeps({ chunks: ['先说一句。', toolBlock] });
  const respRes = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: '列目录', stream: true, tools }),
    res: respRes,
    pathname: '/openai/v1/responses',
    deps: respDeps,
  });
  assert.equal(responsesDeltaConcat(respRes.body), '先说一句。');
  assert.equal(responsesFinalText(respRes.body), '先说一句。');
  assert.ok(!respRes.body.includes('<tool_call>'));
  assert.ok(respRes.body.includes('response.function_call_arguments.delta'));
});

// ---------- F2：断开优先 detach 过渡期，不立即 release ----------

test('F5：闭合工具块之后的正文照常下发，delta 拼接 == 前后正文且不泄漏协议', async () => {
  const raw = '正文A<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>正文B';
  const expect = '正文A正文B';
  const tools = [{ type: 'function', name: 'shell', parameters: { type: 'object' } }];

  // Chat
  const chatDeps = makeDeps({ chunks: splitBy(raw, 5) });
  const chatRes = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', messages: [{ role: 'user', content: 'hi' }], stream: true, tools: [{ type: 'function', function: { name: 'shell' } }] }),
    res: chatRes,
    pathname: '/openai/v1/chat/completions',
    deps: chatDeps,
  });
  assert.equal(chatContentConcat(chatRes.body), expect);
  assert.ok(!chatRes.body.includes('<tool_call>'));
  assert.ok(!chatRes.body.includes('```tool_call'));

  // Responses
  const respDeps = makeDeps({ chunks: splitBy(raw, 5) });
  const respRes = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true, tools }),
    res: respRes,
    pathname: '/openai/v1/responses',
    deps: respDeps,
  });
  assert.equal(responsesDeltaConcat(respRes.body), expect);
  assert.equal(responsesFinalText(respRes.body), expect);
  assert.ok(!respRes.body.includes('<tool_call>'));
  assert.ok(!respRes.body.includes('```tool_call'));
});

test('F5：未闭合工具块继续抑制到收尾，delta 只有前文，不泄漏内部协议', async () => {
  const raw = '正文A<tool_call>{"partial"';
  const tools = [{ type: 'function', name: 'shell', parameters: { type: 'object' } }];

  // Chat
  const chatDeps = makeDeps({ chunks: splitBy(raw, 5) });
  const chatRes = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', messages: [{ role: 'user', content: 'hi' }], stream: true, tools: [{ type: 'function', function: { name: 'shell' } }] }),
    res: chatRes,
    pathname: '/openai/v1/chat/completions',
    deps: chatDeps,
  });
  assert.equal(chatContentConcat(chatRes.body), '正文A');
  assert.ok(!chatRes.body.includes('<tool_call>'));
  assert.ok(!chatRes.body.includes('```tool_call'));

  // Responses
  const respDeps = makeDeps({ chunks: splitBy(raw, 5) });
  const respRes = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true, tools }),
    res: respRes,
    pathname: '/openai/v1/responses',
    deps: respDeps,
  });
  assert.equal(responsesDeltaConcat(respRes.body), '正文A');
  assert.ok(!respRes.body.includes('<tool_call>'));
  assert.ok(!respRes.body.includes('```tool_call'));
});

test('F2：客户端断开优先调 detach，而非立即 release；activeResponses 仍被清理', async () => {
  const deps = makeDeps({ hang: true });
  let detached = 0;
  let released = 0;
  const grant = {
    account: { modelId: 'aws', modelAlias: 'aws', createdAt: Date.now() },
    release: () => { released += 1; },
    detach: () => { detached += 1; },
  };
  deps.scheduler = {
    acquire: async () => grant,
    statsFor: () => ({ active: detached === 0, queued: 0, lastUsedAt: 0, detached: detached > 0 }),
  };

  const res = fakeRes();
  const p = handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi', stream: true }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  await new Promise(r => setImmediate(r));
  res.emit('close');
  await p;

  assert.ok(detached >= 1, '断开时必须优先走 detach 过渡期');
  assert.equal(released, 0, 'detach 路径下不能立即 release 释放槽位');
  assert.equal(deps.activeResponses.size, 0, '断开后 activeResponses 条目必须清理');
});

// ---------- F3：回收中账号不参与调度 ----------

test('F3：isRecycling 标记回收中的账号被跳过，返回 503 account_unavailable', async () => {
  const deps = makeDeps();
  deps.isRecycling = (accountId) => accountId === 'aws';
  const res = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi' }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  assert.equal(res.statusCode, 503);
  const obj = JSON.parse(res.body);
  assert.equal(obj.error.code, 'account_unavailable');
  assert.equal(deps.calls.length, 0);
});

test('F3：未提供 isRecycling 时行为不变（健康过滤照旧）', async () => {
  const deps = makeDeps({ text: '正常回答' });
  const res = fakeRes();
  await handleOpenAIRequest({
    req: fakeReq({ model: 'aws', input: 'hi' }),
    res,
    pathname: '/openai/v1/responses',
    deps,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(deps.calls.length, 1);
});
