/**
 * 运行时数据持久化：账号 / 配置方案 / 健康检查 / 日志
 *
 * 全部落在 data/ 下，data/ 已在 .gitignore 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './app-paths.js';
import { DEFAULT_PROFILE_VALUES } from './default-config.js';

export const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
export const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
export const CONFIG_PROFILES_FILE = path.join(DATA_DIR, 'config-profiles.json');
export const ACCOUNT_HEALTH_FILE = path.join(DATA_DIR, 'account-health.json');
export const LOG_DIR = path.join(DATA_DIR, 'logs');

/** 确保数据目录存在（进程启动时调用一次） */
export function ensureDataDirs() {
  for (const d of [DATA_DIR, PROFILES_DIR, LOG_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, '[]', 'utf8');
  if (!fs.existsSync(CONFIG_PROFILES_FILE)) {
    fs.writeFileSync(CONFIG_PROFILES_FILE, JSON.stringify({ profiles: [] }, null, 2), 'utf8');
  }
}

// ============ 日志落盘 ============
// 控制台日志同时写 data/logs/bridge-YYYYMMDD.log：
// 真机出问题时可以直接读文件，不依赖用户复制终端输出。
let LOG_FD = null;

export function initLogFile() {
  const d = new Date();
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const file = path.join(LOG_DIR, 'bridge-' + stamp + '.log');
  try { LOG_FD = fs.openSync(file, 'a'); } catch (_) { LOG_FD = null; }
  return file;
}

const logStamp = () => new Date().toLocaleString('sv-SE', { hour12: false });

function logArg(a) {
  try {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    return JSON.stringify(a);
  } catch (_) { return String(a); }
}

/** 把 console.* 同时 tee 到日志文件 */
export function teeConsoleToFile() {
  const orig = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  const write = (fn, args) => {
    if (LOG_FD != null) {
      try { fs.writeSync(LOG_FD, logStamp() + ' ' + args.map(logArg).join(' ') + '\n'); } catch (_) {}
    }
    fn.apply(console, args);
  };
  console.log = (...a) => write(orig.log, a);
  console.warn = (...a) => write(orig.warn, a);
  console.error = (...a) => write(orig.error, a);
}

// ============ 账号 ============
export function getAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return []; }
}

export function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}

// ============ 配置方案 ============
/** 默认方案的只读视图（id 固定为 'default'） */
export const DEFAULT_PROFILE = Object.freeze({
  id: 'default',
  name: '默认方案',
  isDefault: true,
  values: DEFAULT_PROFILE_VALUES,
});

/** 读取用户配置方案列表（只含用户新建的，不含默认） */
export function getProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PROFILES_FILE, 'utf8'));
    if (raw && Array.isArray(raw.profiles)) return raw.profiles;
    return [];
  } catch { return []; }
}

export function saveProfiles(profiles) {
  fs.writeFileSync(CONFIG_PROFILES_FILE, JSON.stringify({ profiles }, null, 2), 'utf8');
}

/**
 * 根据账号的 profileId 解析出实际生效的方案。
 * profileId 为空 / 找不到 / 指向默认 → 返回默认方案。
 */
export function resolveProfile(account) {
  const pid = account && account.profileId;
  if (!pid || pid === 'default') return DEFAULT_PROFILE;
  const found = getProfiles().find(p => p.id === pid);
  if (!found) return DEFAULT_PROFILE;
  return { id: found.id, name: found.name, isDefault: false, values: found.values };
}

// ============ 账号健康检查结果 ============
export function getAccountHealth() {
  try {
    if (!fs.existsSync(ACCOUNT_HEALTH_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(ACCOUNT_HEALTH_FILE, 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (_) { return {}; }
}

export function saveAccountHealth(health) {
  try {
    fs.mkdirSync(path.dirname(ACCOUNT_HEALTH_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNT_HEALTH_FILE, JSON.stringify(health, null, 2), 'utf8');
  } catch (e) { console.warn('[health] 保存失败:', e.message); }
}
