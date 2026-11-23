/**
 * 运行目录解析 + 内置页面读取
 *
 * [261123-exe] 打包成单文件 exe（Node SEA）后，import.meta.dirname 指向 exe 所在目录；
 * 开发时指向 bridge/。两者差一层，集中在这里算「安装根目录」，避免各模块各写一份。
 *
 * 为什么 exe 放在 dist 根目录也能找到 data/：
 *   Node SEA 的 "mainFormat": "module" 下，import.meta.dirname === exe 所在目录，
 *   据此算出的 APP_ROOT 就是 exe 同级目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);

/** 是否运行在 Node SEA 单文件 exe 里（取不到 node:sea 时按开发模式处理） */
let isSea = false;
try { isSea = !!req('node:sea').isSea(); } catch (_) { isSea = false; }

export const IS_SEA = isSea;
export const APP_ROOT = isSea ? import.meta.dirname : path.join(import.meta.dirname, '..');
export const DATA_DIR = path.join(APP_ROOT, 'data');
export const UI_DIR = path.join(APP_ROOT, 'ui');

/**
 * 读取管理页 HTML。
 * - exe：页面作为 SEA asset 内嵌（构建脚本 assets: { 'ui/index.html': ... }）
 * - 开发：直接读 ui/index.html
 */
export function readUiIndexHtml() {
  if (isSea) {
    try { return req('node:sea').getAsset('ui/index.html', 'utf8'); }
    catch (e) { console.warn('[ui] 读取内嵌页面失败，回退到磁盘:', e.message); }
  }
  return fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
}
