/**
 * 新增账号的入参校验与内部 ID 生成（纯函数，不碰 HTTP / Chrome，便于单测）。
 *
 * 内部 ID（modelId）是账号唯一身份；对外模型名（modelAlias）只用于组成账号池。
 */
import fs from 'node:fs';

export const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const ALIAS_PATTERN = /^[a-zA-Z0-9._:-]+$/;

const ALIAS_MAX = 80;
const AUTO_ID_PREFIX = 'acct-';

/**
 * 校验新增账号入参。
 *
 * - `modelId` 可选：省略时在锁内自动生成唯一内部 ID；显式传入则原样保留。
 * - `modelAlias` 必填：同别名账号自动组成一个池，可并行。
 *
 * @param {any} data 已 JSON.parse 的请求体
 * @returns {{ok:true, modelId:string|undefined, modelAlias:string} | {ok:false, status:number, error:string}}
 */
export function validateAccountInput(data) {
  const raw = data && typeof data === 'object' ? data : {};
  const providedId = raw.modelId == null ? '' : String(raw.modelId).trim();
  if (providedId && !ID_PATTERN.test(providedId)) {
    return { ok: false, status: 400, error: 'modelId 仅支持英文、数字、下划线、中划线' };
  }

  const alias = String(raw.modelAlias == null ? '' : raw.modelAlias).trim();
  if (!alias) {
    return {
      ok: false,
      status: 400,
      error: 'modelAlias 必填：同别名账号会自动组成一个池，可并行；别名仅支持英文、数字、点、下划线、冒号、中划线，且不超过 80 字符',
    };
  }
  if (alias.length > ALIAS_MAX || !ALIAS_PATTERN.test(alias)) {
    return { ok: false, status: 400, error: 'modelAlias 仅支持英文、数字、点、下划线、冒号、中划线，且不超过 80 字符' };
  }

  return { ok: true, modelId: providedId || undefined, modelAlias: alias };
}

/**
 * 已用 `acct-N` 编号的最大值；非 `acct-N` 的历史 ID（如 `aws`）不参与编号计算。
 * @param {Iterable<string>} occupied
 * @returns {number}
 */
function maxAutoSuffix(occupied) {
  let max = 0;
  const re = new RegExp('^' + AUTO_ID_PREFIX + '(\\d+)$');
  for (const id of occupied) {
    const m = String(id).match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * 生成唯一内部 ID：`acct-1`、`acct-2`…
 *
 * 唯一性同时排除 accounts.json 已有 ID 与 profiles 目录下已存在的目录名；
 * 不按别名生成（同别名多账号会撞）。生成与去重必须在调用方的串行锁内执行。
 *
 * @param {Array<object>} accounts 已登记账号
 * @param {Iterable<string>} existingDirNames profiles 目录下已存在的目录名
 * @returns {string}
 */
export function generateUniqueAccountId(accounts, existingDirNames) {
  const occupied = new Set();
  for (const a of accounts) {
    if (a && a.modelId) occupied.add(a.modelId);
  }
  for (const d of existingDirNames) {
    if (d) occupied.add(d);
  }
  let n = maxAutoSuffix(occupied) + 1;
  let candidate = AUTO_ID_PREFIX + n;
  while (occupied.has(candidate)) {
    n += 1;
    candidate = AUTO_ID_PREFIX + n;
  }
  return candidate;
}

/**
 * 列出 profiles 目录下已存在的子目录名；目录缺失或不可读时返回空列表。
 * @param {string} profilesDir
 * @returns {string[]}
 */
export function listProfileDirNames(profilesDir) {
  try {
    return fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
