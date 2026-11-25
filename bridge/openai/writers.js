/**
 * OpenAI Responses / Chat Completions 输出层。
 *
 * 只负责把已经拿到的最终文本 + 工具调用 + usage 写成 OpenAI 形状；
 * 不负责调用 Quick，也不解析 Quick 事件。
 */
import { makeId } from './protocol.js';

function writeJson(res, status, obj) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function sse(res, type, data) {
  if (res.writableEnded) return;
  res.write('event: ' + type + '\n');
  // Open Responses 规范要求 event 名与 data.type 一致；
  // OpenAI 官方流也带 type，客户端有些会按 data.type 分支。
  res.write('data: ' + JSON.stringify({ type, ...(data || {}) }) + '\n\n');
}

const graphemeSegmenter = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
  ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
  : null;

function chunks(text, size = 240) {
  const s = String(text || '');
  if (!s) return [];
  const limit = Math.max(1, Number(size) || 240);
  // 按 grapheme cluster 切，避免 emoji ZWJ 组合、旗帜、变体选择符被拆开。
  if (graphemeSegmenter) {
    const out = [];
    let part = '';
    for (const { segment } of graphemeSegmenter.segment(s)) {
      if (part && part.length + segment.length > limit) { out.push(part); part = ''; }
      part += segment;
    }
    if (part) out.push(part);
    return out;
  }
  const out = [];
  for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit));
  return out;
}

function normalizeUsage(usage, promptText, outText) {
  const rawInput = Number(usage && usage.input_tokens);
  const rawOutput = Number(usage && usage.output_tokens);
  const rawTotal = Number(usage && usage.total_tokens);
  const input = Number.isFinite(rawInput) ? rawInput : Math.ceil(String(promptText || '').length / 4);
  const output = Number.isFinite(rawOutput) ? rawOutput : Math.ceil(String(outText || '').length / 4);
  const total = Number.isFinite(rawTotal) ? rawTotal : (input + output);
  return {
    responses: {
      input_tokens: input,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: total,
    },
    chat: { prompt_tokens: input, completion_tokens: output, total_tokens: total },
  };
}

function messageItem(id, text, status = 'completed') {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
  };
}

function callItem(call) {
  if (call.type === 'custom') {
    return {
      id: call.itemId,
      type: 'custom_tool_call',
      status: 'completed',
      call_id: call.callId,
      name: call.name,
      input: call.input || '',
    };
  }
  return {
    id: call.itemId,
    type: 'function_call',
    status: 'completed',
    call_id: call.callId,
    name: call.name,
    arguments: call.arguments || '{}',
  };
}

function buildResponseOutput(text, calls, messageId) {
  const output = [];
  if (text) output.push(messageItem(messageId || makeId('msg'), text));
  for (const call of calls || []) output.push(callItem(call));
  return output;
}

function responseBase({ id, model, status, output, usage, incompleteDetails }) {
  const obj = {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage,
    parallel_tool_calls: true,
    tool_choice: 'auto',
  };
  if (incompleteDetails) obj.incomplete_details = incompleteDetails;
  return obj;
}

function responseStatus(text, calls, finishReason) {
  // 异常收尾优先于“有工具调用”，否则超时回合会被误报成 completed。
  if (finishReason === 'timeout' || finishReason === 'max_tokens' || finishReason === 'content_filter') {
    return 'incomplete';
  }
  return 'completed';
}

function responseIncomplete(finishReason) {
  if (finishReason === 'timeout') return { reason: 'timeout' };
  if (finishReason === 'max_tokens') return { reason: 'max_output_tokens' };
  if (finishReason === 'content_filter') return { reason: 'content_filter' };
  return null;
}

const TAG_OPEN = '<tool_call>';
const TAG_CLOSE = '</tool_call>';
const FENCE_OPEN = '```tool_call';
const FENCE_CLOSE = '```';

/**
 * 工具块抑制状态机：普通正文照常下发；命中 opener 后只抑制「工具块本身」，
 * 遇到配对结束标记（`</tool_call>` 或围栏 ``` ）立刻解除抑制，其后正文照常下发。
 * 回合结束仍未闭合的块继续抑制，由 parseToolCalls 的干净文本兜底，不泄漏内部协议。
 */
function createBlockSplitter() {
  let mode = 'normal'; // normal | suppressed
  let kind = ''; // tag | fence
  let pending = '';

  /** 尾部最长的 opener 合法前缀长度；普通 `<` / HTML / 比较符号不算，返回 0。 */
  function openerPrefixSuffixLen(s) {
    const openers = [TAG_OPEN, FENCE_OPEN];
    const maxLen = Math.max(...openers.map(o => o.length));
    for (let k = Math.min(s.length, maxLen); k >= 1; k--) {
      const suffix = s.slice(s.length - k);
      if (openers.some(op => op.startsWith(suffix))) return k;
    }
    return 0;
  }

  /** normal 态扫描：切出可下发前缀，返回剩余待判定部分与命中的块类型。 */
  function scanNormal(s) {
    let index = s.length;
    let hitKind = '';
    for (const [open, k] of [[TAG_OPEN, 'tag'], [FENCE_OPEN, 'fence']]) {
      const i = s.indexOf(open);
      if (i >= 0 && i < index) { index = i; hitKind = k; }
    }
    if (hitKind) return { safe: s.slice(0, index), rest: s.slice(index), kind: hitKind };
    const k = openerPrefixSuffixLen(s);
    if (k > 0) return { safe: s.slice(0, s.length - k), rest: s.slice(s.length - k), kind: '' };
    return { safe: s, rest: '', kind: '' };
  }

  /** suppressed 态扫描：找到结束标记则返回其后正文；否则整块继续压住。 */
  function scanSuppressed(s) {
    const close = kind === 'fence' ? FENCE_CLOSE : TAG_CLOSE;
    const i = s.indexOf(close);
    if (i >= 0) return { after: s.slice(i + close.length), closed: true };
    return { after: '', closed: false };
  }

  return {
    /** 追加一段增量，返回本轮可立即下发的安全文本。 */
    push(t) {
      pending += String(t || '');
      const out = [];
      while (pending) {
        if (mode === 'normal') {
          const r = scanNormal(pending);
          if (r.safe) out.push(r.safe);
          pending = r.rest;
          if (r.kind) { mode = 'suppressed'; kind = r.kind; }
          else break; // 剩余是待证伪的 opener 前缀，先压住
        } else {
          const r = scanSuppressed(pending);
          if (r.closed) {
            pending = r.after;
            mode = 'normal';
            kind = '';
          } else {
            break; // 未闭合，整块继续压住
          }
        }
      }
      return out.join('');
    },
    /** 回合结束时仍压住的内容（未闭合块或待证伪前缀）。 */
    held() { return pending; },
    /** 是否处于未闭合工具块内：是则收尾也不得下发压住内容。 */
    isSuppressed() { return mode === 'suppressed'; },
    /** 异常收尾：清空缓冲，不再下发任何压住内容。 */
    clear() { pending = ''; mode = 'normal'; kind = ''; },
  };
}

function chatFinishReason(finishReason, calls) {
  if (finishReason === 'content_filter') return 'content_filter';
  if (finishReason === 'timeout' || finishReason === 'max_tokens') return 'length';
  if ((calls || []).length) return 'tool_calls';
  return 'stop';
}

/**
 * 补发一组 Responses 工具调用事件（整轮结束后才解析，正文不等它）。
 * @param {(type:string, data:object)=>void} send 事件发送函数
 * @param {Array<object>} calls 解析后的工具调用
 * @param {number} outputIndex 起始 output_index
 * @returns {number} 下一个可用的 output_index
 */
function emitResponsesCalls(send, calls, outputIndex) {
  let index = outputIndex;
  for (const call of calls || []) {
    if (call.type === 'custom') {
      send('response.output_item.added', {
        output_index: index,
        item: {
          id: call.itemId, type: 'custom_tool_call', status: 'in_progress',
          call_id: call.callId, name: call.name, input: '',
        },
      });
      for (const part of chunks(call.input || '')) {
        send('response.custom_tool_call_input.delta', {
          item_id: call.itemId,
          output_index: index,
          delta: part,
        });
      }
      send('response.custom_tool_call_input.done', {
        item_id: call.itemId,
        output_index: index,
        input: call.input || '',
      });
      send('response.output_item.done', {
        output_index: index,
        item: callItem(call),
      });
    } else {
      send('response.output_item.added', {
        output_index: index,
        item: {
          id: call.itemId, type: 'function_call', status: 'in_progress',
          call_id: call.callId, name: call.name, arguments: '',
        },
      });
      for (const part of chunks(call.arguments || '{}')) {
        send('response.function_call_arguments.delta', {
          item_id: call.itemId,
          output_index: index,
          delta: part,
        });
      }
      send('response.function_call_arguments.done', {
        item_id: call.itemId,
        output_index: index,
        arguments: call.arguments || '{}',
      });
      send('response.output_item.done', {
        output_index: index,
        item: callItem(call),
      });
    }
    index++;
  }
  return index;
}

/** 补发一组 Chat 工具调用 chunk（整轮结束后解析）。 */
function emitChatCalls(send, calls) {
  const toolCalls = chatToolCalls(calls);
  toolCalls.forEach((call, index) => {
    const fn = call.type === 'custom'
      ? { custom: { name: call.custom.name, input: '' } }
      : { function: { name: call.function.name, arguments: '' } };
    send({ tool_calls: [{ index, id: call.id, type: call.type, ...fn }] });
    const body = call.type === 'custom' ? call.custom.input : call.function.arguments;
    for (const part of chunks(body || '')) {
      const delta = call.type === 'custom'
        ? { tool_calls: [{ index, custom: { input: part } }] }
        : { tool_calls: [{ index, function: { arguments: part } }] };
      send(delta);
    }
  });
}

export function writeResponsesJson(res, { id, model, text, calls, usage, promptText, finishReason }) {
  const u = normalizeUsage(usage, promptText, text);
  const output = buildResponseOutput(text, calls);
  const status = responseStatus(text, calls, finishReason);
  const obj = responseBase({
    id, model, status, output, usage: u.responses,
    incompleteDetails: responseIncomplete(finishReason),
  });
  writeJson(res, 200, obj);
}

export function writeResponsesStart(res, { id, model }) {
  if (res.writableEnded) return 0;
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
  let seq = 0;
  const send = (type, data) => sse(res, type, { ...data, sequence_number: seq++ });
  send('response.created', {
    response: responseBase({ id, model, status: 'in_progress', output: [], usage: null }),
  });
  send('response.in_progress', {
    response: responseBase({ id, model, status: 'in_progress', output: [], usage: null }),
  });
  return seq;
}

/**
 * 一次性 Responses 流式输出（整轮文本已知的兼容路径；在线边收边写走 createResponsesStream）。
 */
export function streamResponses(res, { id, model, text, calls, usage, promptText, finishReason, started = false, sequenceStart = 0 }) {
  if (res.writableEnded) return;
  const seq = started ? Number(sequenceStart) || 0 : writeResponsesStart(res, { id, model });
  const streamer = createResponsesStream(res, { id, model, sequenceStart: seq });
  if (text) streamer.pushText(text);
  streamer.finish({ text, calls, usage, promptText, finishReason });
}

function chatToolCalls(calls) {
  const out = [];
  for (const call of calls || []) {
    if (call.type === 'custom') {
      out.push({
        id: call.callId,
        type: 'custom',
        custom: { name: call.name, input: call.input || '' },
      });
    } else {
      out.push({
        id: call.callId,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      });
    }
  }
  return out;
}

export function writeChatJson(res, { id, model, text, calls, usage, promptText, finishReason }) {
  const u = normalizeUsage(usage, promptText, text);
  const toolCalls = chatToolCalls(calls);
  const message = {
    role: 'assistant',
    content: text || null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  writeJson(res, 200, {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: chatFinishReason(finishReason, calls),
    }],
    usage: u.chat,
  });
}

export function writeChatStart(res, { id, model }) {
  if (res.writableEnded) return 0;
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
  const created = Math.floor(Date.now() / 1000);
  res.write('data: ' + JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  }) + '\n\n');
  return created;
}

/**
 * 一次性 Chat 流式输出（整轮文本已知的兼容路径；在线边收边写走 createChatStream）。
 */
export function streamChat(res, { id, model, text, calls, usage, promptText, finishReason, started = false, created: createdAt, includeUsage = false }) {
  if (res.writableEnded) return;
  const created = started ? Number(createdAt) || Math.floor(Date.now() / 1000) : writeChatStart(res, { id, model });
  const streamer = createChatStream(res, { id, model, created, includeUsage });
  if (text) streamer.pushText(text);
  streamer.finish({ text, calls, usage, promptText, finishReason });
}

/**
 * Responses 增量写入器：边收边写正文，工具调用与最终状态在 finish() 补发。
 *
 * 状态机：idle（未开正文 item）→ opened（已发 output_item/content_part.added）→ finished。
 * 首段正文到达前不发任何正文事件；空正文回合不会留下“开了 content_part 没 done”的坏收尾。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{id:string, model:string, sequenceStart?:number}} opts
 */
export function createResponsesStream(res, { id, model, sequenceStart = 0 }) {
  let seq = Number(sequenceStart) || 0;
  let opened = false;
  let finished = false;
  let msgId = '';
  let outputIndex = 0;
  let rawText = '';
  const splitter = createBlockSplitter();

  const send = (type, data) => {
    if (res.writableEnded) return;
    try { sse(res, type, { ...data, sequence_number: seq++ }); } catch (_) {}
  };

  const openItem = () => {
    if (opened || res.writableEnded) return;
    opened = true;
    msgId = makeId('msg');
    send('response.output_item.added', {
      output_index: outputIndex,
      item: messageItem(msgId, '', 'in_progress'),
    });
    send('response.content_part.added', {
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const closeItem = (finalText) => {
    if (!opened) return;
    opened = false;
    send('response.output_text.done', {
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      text: finalText,
    });
    send('response.content_part.done', {
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: finalText, annotations: [] },
    });
    send('response.output_item.done', {
      output_index: outputIndex,
      item: messageItem(msgId, finalText),
    });
    outputIndex++;
  };

  return {
    /** 收到一段 Quick 正文增量：安全前缀立即开 item 并写 output_text.delta。 */
    pushText(delta) {
      const t = String(delta || '');
      if (!t || finished) return;
      rawText += t;
      const safe = splitter.push(t);
      if (!safe) return;
      openItem();
      for (const part of chunks(safe)) {
        send('response.output_text.delta', {
          item_id: msgId,
          output_index: outputIndex,
          content_index: 0,
          delta: part,
        });
      }
    },
    /** 异常收尾前关闭已打开的正文 item；没有开过则无操作。 */
    abort() {
      if (finished) return;
      finished = true;
      splitter.clear();
      closeItem(rawText);
    },
    /** 整轮结束：关闭正文 item，补发工具调用、usage 与最终 completed/incomplete。 */
    finish({ text, calls, usage, promptText, finishReason }) {
      if (finished) return;
      finished = true;
      const cleanText = String(text == null ? rawText : text);
      // 未闭合块继续抑制（干净文本兜底）；待证伪的 opener 前缀按普通文本补发。
      const held = splitter.held();
      if (held && !splitter.isSuppressed()) {
        openItem();
        for (const part of chunks(held)) {
          send('response.output_text.delta', {
            item_id: msgId,
            output_index: outputIndex,
            content_index: 0,
            delta: part,
          });
        }
      }
      splitter.clear();
      if (cleanText && !opened) openItem();
      closeItem(cleanText);
      emitResponsesCalls(send, calls, outputIndex);
      const u = normalizeUsage(usage, promptText, cleanText);
      const finalOutput = buildResponseOutput(cleanText, calls, msgId || undefined);
      const finalStatus = responseStatus(cleanText, calls, finishReason);
      send(finalStatus === 'incomplete' ? 'response.incomplete' : 'response.completed', {
        response: responseBase({
          id,
          model,
          status: finalStatus,
          output: finalOutput,
          usage: u.responses,
          incompleteDetails: responseIncomplete(finishReason),
        }),
      });
      if (!res.writableEnded) res.end();
    },
  };
}

/**
 * Chat Completions 增量写入器：正文 chunk 随到随写，工具调用与收尾在 finish() 补发。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{id:string, model:string, created?:number, includeUsage?:boolean}} opts
 */
export function createChatStream(res, { id, model, created: createdAt, includeUsage = false }) {
  const created = Number(createdAt) || Math.floor(Date.now() / 1000);
  let rawText = '';
  const splitter = createBlockSplitter();
  let finished = false;

  const send = (delta, finish = null) => {
    if (res.writableEnded) return;
    try {
      res.write('data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) + '\n\n');
    } catch (_) {}
  };

  return {
    /** 收到一段 Quick 正文增量：安全前缀立即写 content chunk。 */
    pushText(delta) {
      const t = String(delta || '');
      if (!t || finished) return;
      rawText += t;
      const safe = splitter.push(t);
      for (const part of chunks(safe)) send({ content: part });
    },
    /** 异常收尾：标记结束，不再写任何正文 chunk。 */
    abort() {
      finished = true;
      splitter.clear();
    },
    /** 整轮结束：补发工具调用、finish_reason、可选 usage 与 [DONE]。 */
    finish({ text, calls, usage, promptText, finishReason }) {
      if (finished) return;
      finished = true;
      const cleanText = String(text == null ? rawText : text);
      // 未闭合块继续抑制（干净文本兜底）；待证伪的 opener 前缀按普通文本补发。
      const held = splitter.held();
      if (held && !splitter.isSuppressed()) {
        for (const part of chunks(held)) send({ content: part });
      }
      splitter.clear();
      emitChatCalls(send, calls);
      const u = normalizeUsage(usage, promptText, cleanText);
      send({}, chatFinishReason(finishReason, calls));
      if (!res.writableEnded) {
        if (includeUsage) {
          res.write('data: ' + JSON.stringify({
            id, object: 'chat.completion.chunk', created, model,
            choices: [], usage: u.chat,
          }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  };
}
