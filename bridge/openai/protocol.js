/**
 * OpenAI 兼容层的纯协议函数。
 *
 * 这一层不碰 HTTP / CDP / Chrome，只负责：
 *   - 把 OpenAI Responses / Chat Completions 请求整理成 Quick 能接受的提示词
 *   - 把客户端 tools 写进提示词，并解析 Quick 返回的 <tool_call> 块
 *   - 生成稳定的 response / tool call 标识
 *
 * 内部工具协议故意用 XML + JSON，而不是 cuckoo JS：
 *   - JSON 参数对 Codex / dsh 的 function schema 更直接
 *   - 不需要在网关里执行 JS，安全边界更小
 *   - 后续要兼容 cuckoo 代码块，只需在 parseToolCalls 里加一个解析器
 */
import crypto from 'node:crypto';

const MAX_TOOL_SCHEMA_CHARS = 1200;
const MAX_TOOL_DESCRIPTION_CHARS = 300;
const MAX_TOOL_INSTRUCTION_CHARS = 8000;
const MAX_PROMPT_CHARS = 32000;
const MAX_TOOL_CALLS = 8;

const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** 把 Responses 的 content 数组压成文本；图片内容会被提取成附件，这里只留占位。 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return asText(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') { parts.push(part); continue; }
    if (!part || typeof part !== 'object') continue;
    const type = String(part.type || '');
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      if (typeof part.text === 'string') parts.push(part.text);
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      parts.push('[图片输入暂不支持：当前只转发文本]');
      continue;
    }
    if (type === 'input_file' || type === 'file') {
      parts.push('[文件输入暂不支持：当前只转发文本]');
      continue;
    }
    if (type === 'refusal') {
      if (typeof part.refusal === 'string') parts.push(part.refusal);
      continue;
    }
    if (typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

/**
 * Responses input → 统一 item 列表。
 * @returns {Array<{kind:'message'|'tool'|'assistant_tool', role?:string, text?:string, callId?:string, name?:string}>}
 */
export function normalizeResponsesInput(input) {
  if (typeof input === 'string') {
    return [{ kind: 'message', role: 'user', text: input }];
  }
  if (!Array.isArray(input)) return [];

  const items = [];
  for (const raw of input) {
    if (typeof raw === 'string') { items.push({ kind: 'message', role: 'user', text: raw }); continue; }
    if (!raw || typeof raw !== 'object') continue;

    const type = String(raw.type || '');
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      items.push({
        kind: 'tool',
        callId: String(raw.call_id || ''),
        text: contentToText(raw.output),
        name: raw.name ? String(raw.name) : '',
      });
      continue;
    }
    if (type === 'function_call') {
      items.push({
        kind: 'assistant_tool',
        name: String(raw.name || ''),
        text: asText(raw.arguments),
      });
      continue;
    }
    if (type === 'custom_tool_call') {
      items.push({
        kind: 'assistant_tool',
        name: String(raw.name || ''),
        text: asText(raw.input),
      });
      continue;
    }
    if (type === 'message' || raw.role) {
      const role = String(raw.role || 'user');
      items.push({ kind: 'message', role, text: contentToText(raw.content) });
      continue;
    }
    if (type === 'input_text' || type === 'text') {
      items.push({ kind: 'message', role: 'user', text: asText(raw.text) });
      continue;
    }
    if (type === 'input_image' || type === 'image_url') {
      items.push({ kind: 'message', role: 'user', text: '[图片输入暂不支持：当前只转发文本]' });
      continue;
    }
    if (typeof raw.text === 'string') {
      items.push({ kind: 'message', role: 'user', text: raw.text });
    }
  }
  return items;
}

/** Chat messages → 统一 item 列表。 */
export function normalizeChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const items = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const role = String(raw.role || 'user');
    if (role === 'tool' || role === 'function') {
      items.push({
        kind: 'tool',
        callId: String(raw.tool_call_id || ''),
        name: String(raw.name || ''),
        text: contentToText(raw.content),
      });
      continue;
    }
    if (role === 'assistant' && Array.isArray(raw.tool_calls) && raw.tool_calls.length) {
      const text = contentToText(raw.content);
      if (text) items.push({ kind: 'message', role, text });
      for (const call of raw.tool_calls) {
        const fn = call && (call.function || call.custom) || {};
        items.push({
          kind: 'assistant_tool',
          name: String(fn.name || ''),
          text: asText(fn.arguments != null ? fn.arguments : fn.input),
        });
      }
      continue;
    }
    items.push({ kind: 'message', role, text: contentToText(raw.content) });
  }
  return items;
}

/** 图片 data URL 的最大 base64 长度（约 9MB 原图）；超过则跳过，避免撑爆请求体。 */
const MAX_IMAGE_DATA_URL_CHARS = 12 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENTS = 8;

const IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

function imageUrlOf(part) {
  if (!part || typeof part !== 'object') return '';
  const raw = part.image_url;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url;
  if (typeof part.url === 'string') return part.url;
  return '';
}

/**
 * 从本轮最后一条 user 消息里提取 data URL 图片，交给 Quick 附件通道。
 *
 * 只取最后一条 user：续接时网关只发最后一条用户消息，旧历史图片不应被重复上传。
 * http(s) 图片不主动下载，避免网关变成任意 URL 代理；Cuckoo Code 发送的是 data URL。
 *
 * @param {object} body OpenAI Chat/Responses 请求体
 * @param {'chat'|'responses'} mode 入口类型
 * @returns {Array<{kind:'file', filename:string, mimeType:string, data:string}>}
 */
export function extractImageAttachments(body, mode = 'chat') {
  const out = [];
  if (!body || typeof body !== 'object') return out;

  const collect = (content) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type || '');
      if (type !== 'image_url' && type !== 'input_image') continue;
      if (out.length >= MAX_IMAGE_ATTACHMENTS) return;
      const url = imageUrlOf(part);
      if (!url.startsWith('data:')) continue;
      if (url.length > MAX_IMAGE_DATA_URL_CHARS) {
        console.warn('[openai] 图片过大，已跳过附件提取（' + url.length + ' 字符）');
        continue;
      }
      const m = url.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
      if (!m) continue;
      const mimeType = m[1].toLowerCase();
      const ext = IMAGE_EXT[mimeType];
      if (!ext) continue;
      out.push({
        kind: 'file',
        filename: 'image-' + (out.length + 1) + '.' + ext,
        mimeType,
        data: url,
      });
    }
  };

  if (mode === 'responses') {
    const input = Array.isArray(body.input) ? body.input : [];
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (!item || typeof item !== 'object') continue;
      const type = String(item.type || '');
      if (type === 'input_image' || type === 'image_url') {
        collect([item]);
        break;
      }
      if (type === 'message' || item.role) {
        if (String(item.role || 'user') !== 'user') continue;
        collect(item.content);
        break;
      }
    }
  } else {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;
      if (String(msg.role || 'user') !== 'user') continue;
      collect(msg.content);
      break;
    }
  }
  return out;
}

function itemToLine(item) {
  if (!item) return '';
  if (item.kind === 'tool') {
    return 'Tool result' + (item.callId ? ' (' + item.callId + ')' : '') + ':\n' + (item.text || '');
  }
  if (item.kind === 'assistant_tool') {
    return 'Assistant tool call: ' + item.name + '(' + (item.text || '') + ')';
  }
  // 只有空白的用户消息不参与拼接，避免入口把它当成有效提问。
  if (item.kind === 'message' && !String(item.text || '').trim()) return '';
  const role = String(item.role || 'user');
  const label = role === 'system' || role === 'developer' ? 'System'
    : role === 'assistant' ? 'Assistant'
      : role === 'tool' ? 'Tool'
        : 'User';
  return label + ':\n' + (item.text || '');
}

/** 全量 transcript；过长时保留头尾，避免把 Quick 输入框撑爆。 */
function formatTranscript(items) {
  const text = items.map(itemToLine).filter(Boolean).join('\n\n');
  if (text.length <= MAX_PROMPT_CHARS) return text;
  const head = text.slice(0, 12000);
  const tail = text.slice(-16000);
  return head + '\n\n…（中间省略 ' + (text.length - 28000) + ' 字符）…\n\n' + tail;
}

/** 续接时只发新增内容：优先最后一批 tool 结果，否则最后一条 user 消息。 */
function formatContinuation(items) {
  if (!items.length) return '';
  let lastTool = -1;
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (lastTool < 0 && items[i].kind === 'tool') lastTool = i;
    if (lastUser < 0 && items[i].kind === 'message' && (items[i].role === 'user' || !items[i].role)) lastUser = i;
    if (lastTool >= 0 && lastUser >= 0) break;
  }

  // 工具结果比最后一条 user 新：只发这批结果（含用户随后补的话）。
  if (lastTool >= 0 && lastTool > lastUser) {
    const tail = items.slice(lastUser + 1);
    const tools = tail.filter(it => it.kind === 'tool');
    if (tools.length) return formatTranscript(tools);
    return formatTranscript(tail);
  }

  // 正常新用户回合：只发最后一条用户消息，避免把旧工具结果重复灌进去。
  if (lastUser >= 0) return items[lastUser].text || '';

  if (lastTool >= 0) return formatTranscript(items.filter(it => it.kind === 'tool'));
  return '';
}

function normalizeToolList(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const type = String(tool.type || '');
    if (type === 'function') {
      const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
      const name = String(fn.name || tool.name || '');
      if (!name) continue;
      out.push({
        type: 'function',
        name,
        description: String(fn.description || tool.description || ''),
        parameters: fn.parameters || tool.parameters || { type: 'object', properties: {} },
      });
      continue;
    }
    if (type === 'custom' || type === 'freeform') {
      const name = String(tool.name || (tool.custom && tool.custom.name) || '');
      if (!name) continue;
      out.push({
        type: 'custom',
        name,
        description: String(tool.description || (tool.custom && tool.custom.description) || ''),
        format: tool.format || (tool.custom && tool.custom.format),
      });
      continue;
    }
    // 内置 web_search / apply_patch 等没有 name 的，跳过；客户端自己处理。
  }
  return out;
}

/** 工具名 → 工具定义。 */
function toolMap(tools) {
  const map = new Map();
  for (const t of normalizeToolList(tools)) map.set(t.name, t);
  return map;
}

/**
 * 生成给 Quick 的工具调用说明。没有工具或 tool_choice=none 时返回空串。
 */
export function buildToolInstruction(tools, toolChoice) {
  if (toolChoice === 'none') return '';
  const list = normalizeToolList(tools);
  if (!list.length) return '';

  let force = '';
  if (toolChoice === 'required') {
    force = '\n本轮必须调用至少一个工具，不要直接给最终回答。';
  } else if (toolChoice && typeof toolChoice === 'object') {
    const name = toolChoice.name
      || (toolChoice.function && toolChoice.function.name)
      || (toolChoice.custom && toolChoice.custom.name)
      || (toolChoice.type === 'function' && toolChoice.function && toolChoice.function.name)
      || '';
    if (name) force = '\n本轮必须调用工具 `' + name + '`，不要直接给最终回答。';
  }

  const lines = [
    '【外部工具调用规则】',
    '你可以调用下面这些外部工具。需要调用时，必须只输出一个或多个如下格式的块，块外不要写解释：',
    TOOL_OPEN + '{"name":"工具名","arguments":{...}}' + TOOL_CLOSE,
    '自由文本工具（custom）改用 "input" 字段：',
    TOOL_OPEN + '{"name":"工具名","input":"自由文本"}' + TOOL_CLOSE,
    '一次可以输出多个块；工具结果会以 Tool result 消息返回。不要编造工具结果，不要输出 JSON/XML 以外的工具格式。' + force,
    '',
    '可用工具：',
  ];

  for (const t of list.slice(0, 24)) {
    if (t.type === 'custom') {
      lines.push('- ' + t.name + '：' + clip(t.description || '自由文本输入工具', MAX_TOOL_DESCRIPTION_CHARS));
      lines.push('  input: string（自由文本）');
    } else {
      lines.push('- ' + t.name + '：' + clip(t.description || '函数工具', MAX_TOOL_DESCRIPTION_CHARS));
      let schema = '';
      try { schema = JSON.stringify(t.parameters || {}); } catch { schema = '{}'; }
      lines.push('  arguments JSON Schema: ' + clip(schema, MAX_TOOL_SCHEMA_CHARS));
    }
  }
  if (list.length > 24) lines.push('- …还有 ' + (list.length - 24) + ' 个工具未展开');

  return clip(lines.join('\n'), MAX_TOOL_INSTRUCTION_CHARS);
}

/**
 * 生成 Responses 请求的 Quick 提示词。
 * @param {object} body OpenAI Responses 请求体
 * @param {{continuation?:boolean}} [opts]
 */
export function formatResponsesPrompt(body, opts = {}) {
  const items = normalizeResponsesInput(body && body.input);
  const instructions = typeof (body && body.instructions) === 'string' ? body.instructions.trim() : '';
  const toolsText = buildToolInstruction(body && body.tools, body && body.tool_choice);

  if (opts.continuation) {
    const cont = formatContinuation(items);
    if (cont) return clip(cont, MAX_PROMPT_CHARS);
    return '';
  }

  const parts = [];
  if (instructions) parts.push('System:\n' + instructions);
  if (toolsText) parts.push(toolsText);
  const transcript = formatTranscript(items);
  if (transcript) parts.push(transcript);
  return clip(parts.join('\n\n'), MAX_PROMPT_CHARS);
}

/**
 * 生成 Chat Completions 请求的 Quick 提示词。
 */
export function formatChatPrompt(body, opts = {}) {
  const items = normalizeChatMessages(body && body.messages);
  const toolsText = buildToolInstruction(body && body.tools, body && body.tool_choice);

  if (opts.continuation) {
    const cont = formatContinuation(items);
    if (cont) return clip(cont, MAX_PROMPT_CHARS);
    return '';
  }

  const parts = [];
  if (toolsText) parts.push(toolsText);
  const transcript = formatTranscript(items);
  if (transcript) parts.push(transcript);
  return clip(parts.join('\n\n'), MAX_PROMPT_CHARS);
}

function stripCodeFence(text) {
  const s = String(text || '').trim();
  const m = s.match(/^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/i);
  return m ? m[1].trim() : s;
}

/** 清掉被截断、没有闭合的工具标记，避免内部 XML/JSON 泄漏到正文。 */
function stripDanglingToolSyntax(text) {
  let s = String(text || '');
  const openTag = s.lastIndexOf('<tool_call>');
  if (openTag >= 0 && s.toLowerCase().indexOf('</tool_call>', openTag) < 0) {
    s = s.slice(0, openTag);
  }
  const openFence = s.lastIndexOf('```tool_call');
  if (openFence >= 0 && s.indexOf('```', openFence + 3) < 0) {
    s = s.slice(0, openFence);
  }
  return s;
}

/**
 * 从 Quick 输出里提取工具调用块。
 * 支持：
 *   <tool_call>{...}</tool_call>
 *   ```tool_call\n{...}\n```
 *   ```json\n{"name":...}\n```（只有 JSON 对象带 name 时才当工具调用）
 *
 * @returns {{calls:Array<object>, text:string}}
 */
export function parseToolCalls(text, tools) {
  const raw = String(text == null ? '' : text);
  const map = toolMap(tools);
  if (!map.size) {
    const stripped = stripDanglingToolSyntax(raw)
      .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, '')
      .replace(/```tool_call\s*\n[\s\S]*?```/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { calls: [], text: stripped };
  }

  const matches = [];
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m;
  while ((m = tagRe.exec(raw)) !== null) {
    matches.push({ start: m.index, end: tagRe.lastIndex, body: m[1] });
  }

  const fenceRe = /```tool_call\s*\n([\s\S]*?)```/gi;
  while ((m = fenceRe.exec(raw)) !== null) {
    const body = stripCodeFence('```json\n' + m[1] + '\n```');
    if (!body) continue;
    let obj;
    try { obj = JSON.parse(body); } catch { continue; }
    if (!obj || typeof obj !== 'object' || !obj.name) continue;
    // 避免和 <tool_call> 重叠
    if (matches.some(x => m.index >= x.start && m.index < x.end)) continue;
    matches.push({ start: m.index, end: fenceRe.lastIndex, body });
  }

  // 裸 ```json 只有「整条回复就是这一个 JSON 块」时才当工具调用；
  // 避免把回复里的示例 JSON 误执行。
  const whole = raw.trim();
  const wholeJson = whole.match(/^```(?:json|jsonc)\s*\n([\s\S]*?)```$/i);
  if (wholeJson) {
    try {
      const obj = JSON.parse(wholeJson[1]);
      if (obj && typeof obj === 'object' && typeof obj.name === 'string') {
        matches.push({ start: raw.indexOf(whole), end: raw.indexOf(whole) + whole.length, body: wholeJson[1] });
      }
    } catch (_) {}
  }

  const calls = [];
  let clean = raw;
  // 从后往前删，保证下标不漂移
  matches.sort((a, b) => b.start - a.start);
  for (const hit of matches) {
    // 先删块，再校验：未知/畸形块也不能把内部协议泄漏给客户端
    clean = clean.slice(0, hit.start) + clean.slice(hit.end);
    if (calls.length >= MAX_TOOL_CALLS) continue;
    let obj;
    try { obj = JSON.parse(stripCodeFence(hit.body)); } catch { obj = null; }
    if (!obj || typeof obj !== 'object' || typeof obj.name !== 'string') {
      console.warn('[openai] 工具块 JSON 解析失败，已忽略');
      continue;
    }
    const tool = map.get(obj.name);
    if (!tool) {
      console.warn('[openai] 未知工具，已忽略:', obj.name);
      continue;
    }

    const callId = makeId('call');
    const itemId = makeId(tool.type === 'custom' ? 'ctc' : 'fc');
    if (tool.type === 'custom') {
      const input = typeof obj.input === 'string' ? obj.input
        : typeof obj.arguments === 'string' ? obj.arguments
          : asText(obj.arguments);
      calls.push({ type: 'custom', name: tool.name, input, callId, itemId });
    } else {
      let args = '';
      if (typeof obj.arguments === 'string') {
        if (!obj.arguments.trim()) {
          args = '{}';
        } else {
          try {
            JSON.parse(obj.arguments);
            args = obj.arguments;
          } catch {
            console.warn('[openai] 工具参数不是合法 JSON，已忽略该调用:', obj.name);
            continue;
          }
        }
      } else if (obj.arguments && typeof obj.arguments === 'object') args = JSON.stringify(obj.arguments);
      else if (obj.input && typeof obj.input === 'object') args = JSON.stringify(obj.input);
      else args = '{}';
      calls.push({ type: 'function', name: tool.name, arguments: args, callId, itemId });
    }
  }

  clean = stripDanglingToolSyntax(clean);
  clean = clean.replace(/\n{3,}/g, '\n\n').trim();
  calls.reverse(); // 按原文顺序
  return { calls, text: clean };
}

/** 生成 OpenAI 风格 ID；Chat 官方前缀用连字符。 */
export function makeId(prefix, separator = '_') {
  return String(prefix || 'id') + separator + crypto.randomUUID().replace(/-/g, '');
}

/** 粗略 token 估算，仅在 Quick 没返回 usage 时兜底。 */
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

/** OpenAI 风格错误对象。 */
export function openaiError(message, type = 'invalid_request_error', code = 'invalid_request') {
  return { error: { message: String(message || '请求失败'), type, code } };
}

export const __internals = {
  contentToText,
  normalizeToolList,
  formatTranscript,
  formatContinuation,
  MAX_PROMPT_CHARS,
};
