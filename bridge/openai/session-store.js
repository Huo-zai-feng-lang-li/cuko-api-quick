/**
 * OpenAI 入口的会话映射。
 *
 * Quick 是有状态的网页会话；OpenAI 客户端通常是无状态的。
 * 这里只做一件事：把客户端给的会话句柄（previous_response_id /
 * X-Session-Id / conversation_id / metadata.session_id）映射到 Quick 的 providerSessionId。
 * 没有显式句柄时不做消息指纹复用，避免不同客户端串到同一个网页会话。
 *
 * 映射默认 24 小时滑动过期；传入 filePath 时同步落盘，网关重启后旧句柄
 * 仍能续接同一个网页线程。没有 filePath 时保持纯内存，方便测试和临时运行。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX = 1000;
const FILE_VERSION = 1;

/**
 * @param {{ttlMs?:number, maxEntries?:number, filePath?:string, now?:()=>number}} [opts]
 */
export function createSessionStore(opts = {}) {
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  const maxEntries = Number(opts.maxEntries) > 0 ? Number(opts.maxEntries) : DEFAULT_MAX;
  const filePath = typeof opts.filePath === 'string' ? opts.filePath : '';
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const map = new Map();
  let loaded = false;

  const persist = () => {
    if (!filePath) return;
    const tmp = filePath + '.tmp-' + process.pid;
    try {
      const entries = [];
      for (const [key, entry] of map) {
        if (!entry) continue;
        entries.push({ key, value: entry.value, expiresAt: entry.expiresAt });
      }
      const json = JSON.stringify({ version: FILE_VERSION, entries });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, json, 'utf8');
      try {
        fs.renameSync(tmp, filePath);
      } catch (e) {
        // Windows 上目标文件被 Defender/索引器短暂占用时 rename 会 EPERM/EBUSY。
        // 这时降级为就地覆盖，保住本次映射，不因持久化失败影响请求。
        if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EEXIST')) {
          fs.writeFileSync(filePath, json, 'utf8');
          try { fs.unlinkSync(tmp); } catch (_) { /* 清理临时文件 */ }
        } else {
          throw e;
        }
      }
    } catch (e) {
      console.warn('[openai] 会话映射落盘失败:', e && e.message ? e.message : e);
      try { fs.unlinkSync(tmp); } catch (_) { /* 清理临时文件 */ }
    }
  };

  const load = () => {
    if (loaded || !filePath) return;
    loaded = true;
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const entries = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : []);
      for (const item of entries) {
        if (!item || typeof item.key !== 'string' || !item.key) continue;
        if (!('value' in item) || item.value == null) continue;
        const expiresAt = Number(item.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= now()) continue;
        map.set(item.key, { value: item.value, expiresAt });
      }
    } catch (e) {
      console.warn('[openai] 会话映射文件读取失败，按空仓库处理:', e && e.message ? e.message : e);
      map.clear();
    }
  };

  /** 删除过期项并按插入顺序裁掉最旧项；返回是否有变化。 */
  const prune = () => {
    let changed = false;
    const current = now();
    for (const [key, entry] of map) {
      if (!entry || entry.expiresAt <= current) {
        map.delete(key);
        changed = true;
      }
    }
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest == undefined) break;
      map.delete(oldest);
      changed = true;
    }
    return changed;
  };

  load();
  prune();

  return {
    get(key) {
      if (!key) return null;
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        persist();
        return null;
      }
      // 触碰后移到队尾，近似 LRU；同时刷新滑动过期时间。
      map.delete(key);
      entry.expiresAt = now() + ttlMs;
      map.set(key, entry);
      persist();
      return entry.value;
    },
    set(key, value) {
      if (!key || !value) return false;
      map.delete(key);
      // 值可以是字符串，也可以是 { providerSessionId, accountId }；
      // 不能统一 String()，否则对象会变成 "[object Object]"。
      map.set(key, { value, expiresAt: now() + ttlMs });
      prune();
      persist();
      return true;
    },
    delete(key) {
      const existed = map.delete(key);
      if (existed) persist();
      return existed;
    },
    clear() {
      map.clear();
      persist();
    },
    get size() {
      if (prune()) persist();
      return map.size;
    },
  };
}

/** 哈希一段文本，作为没有显式会话 ID 时的稳定键。 */
export function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 24);
}

/** Responses 的 previous_response_id → 内部键。 */
export function responseSessionKey(previousResponseId) {
  return previousResponseId ? 'resp:' + String(previousResponseId) : '';
}

/**
 * Chat Completions 的会话键：
 *   1. 显式 header：x-session-id / x-conversation-id
 *   2. body 的 conversation_id / metadata.session_id
 *   3. 没有显式键时返回空串：入口不强行按消息指纹复用 Quick 会话，
 *      避免两个陌生客户端发同一句开场白时串到同一个网页会话。
 *
 * Chat 客户端多轮对话应带 X-Session-Id 或 conversation_id；
 * 不带时入口会把完整 messages 当新对话发送，语义仍可用，只是不复用网页线程。
 */
export function chatSessionKey(body, headers = {}) {
  const h = headers || {};
  const b = body || {};
  // 所有 Chat 键都带模型前缀：同一个会话 ID 被不同模型复用时不能互相覆盖。
  const prefix = b.model ? 'chat:' + String(b.model) + ':' : 'chat:';
  const fromHeader = h['x-session-id'] || h['x-conversation-id'] || h['conversation-id'];
  if (fromHeader) return prefix + String(fromHeader);

  if (typeof b.conversation_id === 'string' && b.conversation_id) return prefix + b.conversation_id;
  if (b.metadata && typeof b.metadata === 'object' && b.metadata.session_id) {
    return prefix + String(b.metadata.session_id);
  }

  return '';
}
