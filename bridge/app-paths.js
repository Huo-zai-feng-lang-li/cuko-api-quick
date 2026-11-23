/**
 * 运行目录解析
 * 开发时 import.meta.dirname 指向 bridge/，安装根目录是其上一级。
 * 所有数据目录/UI 路径都从这里取，避免各模块各写一份。
 */
import fs from 'node:fs';
import path from 'node:path';

export const APP_ROOT = path.join(import.meta.dirname, '..');
export const DATA_DIR = path.join(APP_ROOT, 'data');
export const UI_DIR = path.join(APP_ROOT, 'ui');

/** 读取管理页 HTML */
export function readUiIndexHtml() {
  return fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
}
