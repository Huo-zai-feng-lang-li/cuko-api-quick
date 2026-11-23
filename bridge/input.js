/**
 * 输入归一化
 *
 * Cuko 客户端发来的 input 数组形态不稳定（见过 {type:'user'}、content 字符串、
 * content 数组等），旧实现只认 type === 'text'，会把整条消息静默丢掉。
 * 这里统一成 { kind: 'text' | 'file' }，未识别的项不会被静默丢弃，
 * 记进 unknown 供日志和报错使用。
 */

/**
 * @param {any} input Cuko 请求里的 input
 * @returns {{ items: Array<{kind:'text'|'file', [k:string]:any}>, unknown: string[] }}
 */
export function normalizeInputItems(input) {
  const items = [];
  const unknown = [];
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') { unknown.push('非对象:' + typeof raw); continue; }

    let text = '';
    if (typeof raw.text === 'string') text = raw.text;
    else if (typeof raw.content === 'string') text = raw.content;
    else if (Array.isArray(raw.content)) {
      text = raw.content
        .map(c => (typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : '')))
        .filter(Boolean)
        .join('');
      const nonText = raw.content.filter(c => !(typeof c === 'string' || (c && typeof c.text === 'string')));
      if (nonText.length) unknown.push('content-part:' + nonText.map(c => (c && c.type) || typeof c).join('|'));
    }

    if (text) { items.push({ kind: 'text', text, rawType: raw.type }); continue; }
    if (raw.data) {
      items.push({ kind: 'file', data: raw.data, filename: raw.filename || 'file', mimeType: raw.mimeType || '', rawType: raw.type });
      continue;
    }
    unknown.push((raw.type || 'no-type') + '[' + Object.keys(raw).join('|') + ']');
  }
  return { items, unknown };
}
