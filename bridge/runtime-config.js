/**
 * 运行时配置（端口等）
 *
 * 为什么需要它：环境变量 CUKO_HTTP_PORT 只对「命令行启动」有效，
 * 双击 exe 的用户没法设环境变量。所以再加一层配置文件 data/config.json，
 * 让用户改完重启就能生效。
 *
 * 优先级（后者覆盖前者）：
 *   内置默认值  <  data/config.json  <  环境变量 CUKO_HTTP_PORT
 *
 * 环境变量优先级最高，方便临时改端口、也方便在 CI/脚本里覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './app-paths.js';

export const RUNTIME_CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** 内置默认值 */
export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  /** HTTP 监听端口 */
  port: 3000,
  /** 监听地址；默认只本机可访问，改成 0.0.0.0 可让局域网访问（不推荐，无鉴权） */
  host: '127.0.0.1',
  /** 启动后是否自动用默认浏览器打开管理后台 */
  autoOpenAdmin: true,
  /** 每个账号最多允许几个请求排队（同一账号只能一轮对话） */
  maxQueuePerAccount: 8,
  /** 排队最长等待秒数；超过就返回 429，避免请求无限挂住 */
  queueMaxWaitSec: 60,
  /** 启动后是否后台预热账号（打开 Chrome + Quick 页签） */
  warmupOnStart: true,
  /** 最多预热几个账号，控制内存；其余账号等第一次请求再拉起 */
  warmupLimit: 2,
  /**
   * 账号闲置多少秒后回收其受管 Chrome（保留 profile 目录与登录态）。
   * 0 = 关闭空闲回收；默认 600s 足够宽松，刚用完还要复用不会被立刻关掉。
   */
  idleChromeSec: 600,
  /** 同时常驻的 Chrome 数量上限；超出时按最久未用回收。0 = 不限制 */
  maxResidentChrome: 4,
  /** 后台回收轮询间隔（秒）；0 = 关闭后台轮询（只在请求/删除时触发整理） */
  sweepIntervalSec: 60,
  /**
   * 回合进行中客户端断开后，槽位过渡期（秒）；正常收尾后的 close 不进入过渡期。
   * 过渡期内旧回合跑完即释放；到点仍未结束则强制释放，避免无人接收的回合永久占槽。
   * 0 = 断开立即释放槽位。
   */
  detachedGraceSec: 15,
});

/**
 * 读取 data/config.json。
 * 文件不存在返回空对象；JSON 坏了也返回空对象并告警（不能因为配置坏了起不来）。
 */
export function readRuntimeConfig() {
  if (!fs.existsSync(RUNTIME_CONFIG_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (e) {
    console.warn('[config] data/config.json 解析失败，忽略该文件:', e.message);
    return {};
  }
}

/** 首次运行时把默认配置写出来，用户能看到有哪些可改项 */
export function ensureRuntimeConfigFile() {
  if (fs.existsSync(RUNTIME_CONFIG_FILE)) return false;
  try {
    const body = {
      _说明: [
        '改完这个文件后重启程序才生效。',
        'port：HTTP 监听端口，默认 3000。客户端里的「API 地址」要填成一样的端口。',
        'host：监听地址，默认 127.0.0.1（只有本机能访问）。',
        '      改成 0.0.0.0 可以让局域网访问，但本项目没有鉴权，请自行评估风险。',
        'autoOpenAdmin：启动后是否自动打开管理后台页面，默认 true。',
        '      如果你把服务跑在服务器上、或者不想每次弹浏览器，改成 false。',
        'maxQueuePerAccount：单账号最多排几个请求，默认 8。',
        'queueMaxWaitSec：排队最长等待秒数，默认 60；超时返回 429。',
        'warmupOnStart：启动后是否后台预热账号，默认 true。',
        'warmupLimit：最多预热几个账号，默认 2；账号多时控制内存。',
        'idleChromeSec：账号闲置多少秒后回收其受管 Chrome（保留登录态目录），默认 600；0 关闭回收。',
        'maxResidentChrome：同时常驻 Chrome 数量上限，超出按最久未用回收，默认 4；0 不限制。',
        'sweepIntervalSec：后台回收轮询间隔秒数，默认 60；0 关闭后台轮询。',
        'detachedGraceSec：回合进行中断开后槽位过渡期秒数，默认 15；0 断开立即释放。',
        '环境变量 CUKO_HTTP_PORT 优先级高于本文件。',
      ],
      port: DEFAULT_RUNTIME_CONFIG.port,
      host: DEFAULT_RUNTIME_CONFIG.host,
      autoOpenAdmin: DEFAULT_RUNTIME_CONFIG.autoOpenAdmin,
      maxQueuePerAccount: DEFAULT_RUNTIME_CONFIG.maxQueuePerAccount,
      queueMaxWaitSec: DEFAULT_RUNTIME_CONFIG.queueMaxWaitSec,
      warmupOnStart: DEFAULT_RUNTIME_CONFIG.warmupOnStart,
      warmupLimit: DEFAULT_RUNTIME_CONFIG.warmupLimit,
      idleChromeSec: DEFAULT_RUNTIME_CONFIG.idleChromeSec,
      maxResidentChrome: DEFAULT_RUNTIME_CONFIG.maxResidentChrome,
      sweepIntervalSec: DEFAULT_RUNTIME_CONFIG.sweepIntervalSec,
      detachedGraceSec: DEFAULT_RUNTIME_CONFIG.detachedGraceSec,
    };
    fs.writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(body, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[config] 写入默认配置失败:', e.message);
    return false;
  }
}

/**
 * 解析最终生效的运行时配置。
 * @returns {{ port:number, host:string, portSource:string }}
 *   portSource 用于启动日志里告诉用户「这个端口是从哪来的」
 */
export function resolveRuntimeConfig() {
  const file = readRuntimeConfig();
  let port = DEFAULT_RUNTIME_CONFIG.port;
  let host = DEFAULT_RUNTIME_CONFIG.host;
  let autoOpenAdmin = DEFAULT_RUNTIME_CONFIG.autoOpenAdmin;
  let maxQueuePerAccount = DEFAULT_RUNTIME_CONFIG.maxQueuePerAccount;
  let queueMaxWaitSec = DEFAULT_RUNTIME_CONFIG.queueMaxWaitSec;
  let warmupOnStart = DEFAULT_RUNTIME_CONFIG.warmupOnStart;
  let warmupLimit = DEFAULT_RUNTIME_CONFIG.warmupLimit;
  let idleChromeSec = DEFAULT_RUNTIME_CONFIG.idleChromeSec;
  let maxResidentChrome = DEFAULT_RUNTIME_CONFIG.maxResidentChrome;
  let sweepIntervalSec = DEFAULT_RUNTIME_CONFIG.sweepIntervalSec;
  let detachedGraceSec = DEFAULT_RUNTIME_CONFIG.detachedGraceSec;
  let portSource = '默认值';

  const readInt = (value, fallback, min, max) => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) return fallback;
    return n;
  };
  const readBool = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return !(value === false || value === 'false' || value === 0 || value === '0');
  };

  // 1) 配置文件
  if (file.port !== undefined) {
    const n = Number(file.port);
    if (Number.isInteger(n) && n > 0 && n < 65536) { port = n; portSource = 'data/config.json'; }
    else console.warn('[config] data/config.json 里的 port 不合法（' + JSON.stringify(file.port) + '），已忽略');
  }
  if (typeof file.host === 'string' && file.host.trim()) host = file.host.trim();

  // 2) 环境变量优先
  const envPort = process.env.CUKO_HTTP_PORT;
  if (envPort !== undefined && envPort !== '') {
    const n = Number(envPort);
    if (Number.isInteger(n) && n > 0 && n < 65536) { port = n; portSource = '环境变量 CUKO_HTTP_PORT'; }
    else console.warn('[config] 环境变量 CUKO_HTTP_PORT 不合法（' + JSON.stringify(envPort) + '），已忽略');
  }

  // 布尔开关：字符串 'false' 也当 false 处理（方便手工编辑 json）
  if (file.autoOpenAdmin !== undefined) {
    autoOpenAdmin = readBool(file.autoOpenAdmin, autoOpenAdmin);
  }
  maxQueuePerAccount = readInt(file.maxQueuePerAccount, maxQueuePerAccount, 0, 100);
  queueMaxWaitSec = readInt(file.queueMaxWaitSec, queueMaxWaitSec, 1, 600);
  warmupOnStart = readBool(file.warmupOnStart, warmupOnStart);
  warmupLimit = readInt(file.warmupLimit, warmupLimit, 0, 50);
  idleChromeSec = readInt(file.idleChromeSec, idleChromeSec, 0, 3600);
  maxResidentChrome = readInt(file.maxResidentChrome, maxResidentChrome, 0, 50);
  sweepIntervalSec = readInt(file.sweepIntervalSec, sweepIntervalSec, 0, 600);
  detachedGraceSec = readInt(file.detachedGraceSec, detachedGraceSec, 0, 120);

  return {
    port, host, portSource, autoOpenAdmin,
    maxQueuePerAccount, queueMaxWaitSec, warmupOnStart, warmupLimit,
    idleChromeSec, maxResidentChrome, sweepIntervalSec, detachedGraceSec,
  };
}

/** 端口被占用时给用户的建议（写进错误信息里） */
export function portInUseHint(port) {
  return [
    '端口 ' + port + ' 已被占用。可以：',
    '  1) 关掉占用该端口的程序（Windows 下用 netstat -ano | findstr :' + port + ' 查 PID）',
    '  2) 换个端口：编辑 ' + RUNTIME_CONFIG_FILE + '，把 port 改成别的值，然后重启',
    '  3) 或临时用环境变量：set CUKO_HTTP_PORT=3002 && npm start',
  ].join('\n');
}
