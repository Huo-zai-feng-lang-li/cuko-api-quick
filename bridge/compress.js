/**
 * 历史压缩请求（type: "compress"）
 *
 * Cuko 协议里，客户端切换模型时会把历史压成一次 compress 请求，
 * 让新模型重建上下文。对 Quick 来说这就是「一条包含完整历史的普通消息」，
 * 因此实现上是：把 input 各段拼成一条消息发出去，SSE 输出格式与普通轮次一致。
 *
 * 与普通轮次的差别：
 *  - 必须新建对话（历史本身就是完整上下文）
 *  - 不落历史、不做增量续接
 *  - done 事件里必须带新的 providerSessionId
 */
import { handleChat } from './chat.js';

/**
 * @param {object} args 与 handleChat 相同的上下文
 */
export async function handleCompress({ res, payload, account, conn, cfg, profile, release }) {
  const parts = Array.isArray(payload.input) ? payload.input : [];
  const text = parts
    .map(p => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      if (p && typeof p.content === 'string') return p.content;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');

  console.log('[Compress] 历史压缩请求，共 ' + parts.length + ' 段，合并后 ' + text.length + ' 字');

  // 压缩请求永远新建对话
  const nextPayload = { ...payload, providerSessionId: null, _text: text, type: 'tool' };
  await handleChat({ res, payload: nextPayload, account, conn, cfg, profile, release });
}
