/**
 * 账号健康检查
 *
 * 判据（尽量只用页面自身可观测的信号，不额外发请求，避免指纹异常）：
 *  - 未登录：页面 URL 跳到了登录/注册页
 *  - 可用：聊天输入区存在且可用
 *  - 异常：页面打不开 / CDP 连不上
 *
 * 额度与封禁状态当前版本不主动探测（Quick 的额度接口需要租户侧凭据，
 * 换了实现方式后再补）；这里返回 ok / login_required / error 三态，
 * 足以挡住「没登录还在傻等」这条最常见的失败路径。
 */
import { ensureChrome } from './chrome.js';
import { getConnection } from './cdp-connection.js';
import { readComposer, currentUrl, dumpState } from './quick-sender.js';

/** 登录相关 URL 片段 */
const LOGIN_MARKS = ['/login', '/signin', '/sign-in', '/auth', '/start?'];

/** 判断当前 URL 是否像登录页 */
export function looksLikeLoginPage(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  // /sn/account/<id>/start/chat 是正常聊天地址，不能误判成登录
  if (u.includes('/start/chat')) return false;
  return LOGIN_MARKS.some(m => u.includes(m));
}

/**
 * @param {object} account
 * @param {object} cfg
 * @returns {Promise<{state:'ok'|'login_required'|'error', message?:string, url?:string}>}
 */
export async function checkAccountHealth(account, cfg) {
  if (!(await ensureChrome(account, cfg))) {
    return { state: 'error', message: 'Chrome 启动超时或无法连接调试端口' };
  }
  let conn;
  try {
    conn = await getConnection(account, 'quick.aws.com');
  } catch (e) {
    return { state: 'error', message: 'CDP 连接失败: ' + e.message };
  }

  const url = await currentUrl(conn);
  if (looksLikeLoginPage(url)) {
    return { state: 'login_required', message: '页面在登录页，请在此 Chrome 窗口里登录', url };
  }

  const st = await readComposer(conn);
  if (st && st.ok) {
    return { state: 'ok', message: '输入区可用', url };
  }

  await dumpState(conn, '健康检查未找到输入区');
  return { state: 'error', message: '未找到聊天输入区（可能页面未加载完成或未登录）', url };
}
