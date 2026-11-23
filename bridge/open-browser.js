/**
 * 启动后用系统默认浏览器打开管理后台
 *
 * 为什么需要：exe 双击启动后只弹一个命令行窗口，用户不知道要去浏览器里
 * 敲地址。自动打开能省掉这一步。
 *
 * 三种方式按顺序尝试，任一成功即可：
 *   1. Windows 的 start 命令（最轻量，走 ShellExecute）
 *   2. rundll32 url.dll,FileProtocolHandler
 *   3. PowerShell 的 Start-Process
 *
 * 注意：这是个「锦上添花」的功能，任何一步失败都不能影响服务本身，
 * 所以所有异常都被吞掉，只打日志。
 */
import { execFile, exec } from 'node:child_process';

/**
 * 用默认浏览器打开一个 URL。
 * @param {string} url 要打开的地址
 * @returns {Promise<boolean>} 是否成功发起打开动作（不代表浏览器真的起来了）
 */
export function openInBrowser(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(false); return; }

    if (process.platform === 'win32') {
      // 方式 1：cmd /c start "" "<url>"
      // 第一个空字符串是 start 的「窗口标题」占位，不能省，
      // 否则 URL 会被当成标题、打不开。
      try {
        exec('start "" "' + url.replace(/"/g, '') + '"', { windowsHide: true }, (err) => {
          if (!err) { resolve(true); return; }
          // 方式 2
          execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, (err2) => {
            if (!err2) { resolve(true); return; }
            // 方式 3
            execFile('powershell.exe', [
              '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
              '-Command', 'Start-Process "' + url.replace(/"/g, '') + '"',
            ], { windowsHide: true }, (err3) => {
              resolve(!err3);
            });
          });
        });
      } catch (_) {
        resolve(false);
      }
      return;
    }

    // macOS / Linux：尽力而为
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      execFile(cmd, [url], { windowsHide: true }, (err) => resolve(!err));
    } catch (_) {
      resolve(false);
    }
  });
}
