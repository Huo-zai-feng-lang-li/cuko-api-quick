/**
 * Chrome 启动参数里的 profile 归属校验
 *
 * 为什么需要它：调试端口是账号的“地址”，但地址本身不证明身份。
 * 删除账号后旧 Chrome 可能还占着端口，新账号若只看 probePort 通不通，
 * 就会连到旧账号的登录态上，出现串号。这里用 Chrome 自己的启动参数
 * `--user-data-dir=<PROFILES_DIR>/<modelId>` 做归属校验。
 *
 * 纯函数，便于单测；不碰 CDP / HTTP。
 */
import path from 'node:path';
import { PROFILES_DIR } from './store.js';

/**
 * 判断 Chrome 命令行是否属于指定账号的 profile。
 *
 * @param {string} commandLine Chrome 进程启动命令行（CDP SystemInfo.getInfo 的 commandLine）
 * @param {string} modelId 账号 ID
 * @param {string} [profilesDir] profile 根目录，默认 data/profiles
 * @returns {boolean}
 */
export function commandLineMatchesProfile(commandLine, modelId, profilesDir = PROFILES_DIR) {
  const cmd = String(commandLine || '');
  const id = String(modelId || '');
  if (!cmd || !id) return false;

  // 统一引号、斜杠和大小写；路径里可能带空格，所以不能按空格切分
  const normalizedCmd = cmd.replace(/["']/g, '').replace(/\\/g, '/').toLowerCase();
  const wanted = path.join(profilesDir, id).replace(/\\/g, '/').toLowerCase();
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 只认 --user-data-dir 的完整值，避免 aws 误匹配 aws-2 / aws2
  const re = new RegExp('--user-data-dir\\s*=\\s*' + escaped + '(?:/)?(?=\\s|$)', 'i');
  return re.test(normalizedCmd);
}
