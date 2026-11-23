/**
 * Windows 系统剪贴板读写（PowerShell 实现）+ 全局锁 + 备份/恢复
 *
 * 为什么用系统剪贴板：Quick 网页端的输入框是富文本编辑器，
 * 直接把长文本/Ctrl+V 注入最稳；纯 Input.insertText 会被前端 React 状态机吞掉。
 * 剪贴板是全局资源，多账号并发时必须串行化，并在用完后恢复用户原内容。
 */
import { execFileSync, execFile } from 'node:child_process';

/** 剪贴板操作全局锁 */
let clipboardLock = Promise.resolve();

export async function withClipboardLock(fn) {
  const prev = clipboardLock;
  let release;
  clipboardLock = new Promise(r => { release = r; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

const PS = 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-STA', '-Command'];

/** 在 PowerShell 内部重试，避免 Node 侧 busy-wait 卡住事件循环 */
const CLIP_RETRY = { maxAttempts: 10, intervalMs: 100 };

/**
 * 写文本到剪贴板
 * @param {string} text
 * @returns {boolean} 是否成功
 */
export function setClipboardText(text) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  const ps = [
    '$ErrorActionPreference = "Stop";',
    'Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue;',
    'Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue;',
    '$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + b64 + '"));',
    '$ok = $false;',
    'for ($i = 0; $i -lt ' + CLIP_RETRY.maxAttempts + '; $i++) {',
    '  try { [System.Windows.Forms.Clipboard]::SetText($text); $ok = $true; break }',
    '  catch { Start-Sleep -Milliseconds ' + CLIP_RETRY.intervalMs + ' }',
    '}',
    'if ($ok) { "OK" } else { "FAIL" }',
  ].join(' ');
  try {
    const out = execFileSync(PS, PS_ARGS.concat([ps]), { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return String(out).trim().endsWith('OK');
  } catch (e) {
    console.warn('[剪贴板] 写文本失败:', e.message);
    return false;
  }
}

/**
 * 写文件路径到剪贴板（作为 FileDrop 列表，资源管理器粘贴语义）
 * @param {string} filePath
 * @returns {boolean}
 */
export function setClipboardFile(filePath) {
  const b64 = Buffer.from(String(filePath), 'utf8').toString('base64');
  const ps = [
    '$ErrorActionPreference = "Stop";',
    'Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue;',
    '$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("' + b64 + '"));',
    'if (-not (Test-Path -LiteralPath $p)) { "NOFILE"; exit 0 }',
    '$ok = $false;',
    'for ($i = 0; $i -lt ' + CLIP_RETRY.maxAttempts + '; $i++) {',
    '  try {',
    '    $col = New-Object System.Collections.Specialized.StringCollection;',
    '    [void]$col.Add($p);',
    '    [System.Windows.Forms.Clipboard]::SetFileDropList($col);',
    '    $ok = $true; break',
    '  } catch { Start-Sleep -Milliseconds ' + CLIP_RETRY.intervalMs + ' }',
    '}',
    'if ($ok) { "OK" } else { "FAIL" }',
  ].join(' ');
  try {
    const out = execFileSync(PS, PS_ARGS.concat([ps]), { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return String(out).trim().endsWith('OK');
  } catch (e) {
    console.warn('[剪贴板] 写文件失败:', e.message);
    return false;
  }
}

/**
 * 读取当前剪贴板（用于发送前备份）。
 * 返回 { type: 'text'|'files'|'image'|'empty', text?, files? }
 */
export function readClipboard() {
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue";',
    'Add-Type -AssemblyName System.Windows.Forms;',
    'try {',
    '  if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
    '    $files = [System.Windows.Forms.Clipboard]::GetFileDropList();',
    '    "FILES\t" + ($files -join "|")',
    '  } elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {',
    '    $t = [System.Windows.Forms.Clipboard]::GetText();',
    '    "TEXT\t" + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t))',
    '  } elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
    '    "IMAGE"',
    '  } else { "EMPTY" }',
    '} catch { "EMPTY" }',
  ].join(' ');
  try {
    const out = execFileSync(PS, PS_ARGS.concat([ps]), { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
    if (out.startsWith('FILES\t')) {
      const files = out.slice(6).split('|').filter(Boolean);
      return files.length ? { type: 'files', files } : { type: 'empty' };
    }
    if (out.startsWith('TEXT\t')) {
      return { type: 'text', text: Buffer.from(out.slice(5), 'base64').toString('utf8') };
    }
    if (out.startsWith('IMAGE')) return { type: 'image' };
    return { type: 'empty' };
  } catch (e) {
    console.warn('[剪贴板] 读取失败:', e.message);
    return null;
  }
}

/** 恢复发送前备份的剪贴板内容 */
export function restoreClipboard(backup) {
  if (!backup) return false;
  try {
    if (backup.type === 'text') return setClipboardText(backup.text);
    if (backup.type === 'files' && backup.files && backup.files.length) return setClipboardFile(backup.files[0]);
    // image / empty：不主动清空（清空会破坏用户剪贴板），仅记录
    return false;
  } catch (e) {
    console.warn('[剪贴板] 恢复失败:', e.message);
    return false;
  }
}
