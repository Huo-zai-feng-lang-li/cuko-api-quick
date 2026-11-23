import fs from 'node:fs';
import path from 'node:path';

const REQ_DIR = path.join(import.meta.dirname, '..', 'docs', 'requirements');
const INDEX_FILE = path.join(REQ_DIR, 'INDEX.md');

const files = fs.readdirSync(REQ_DIR)
  .filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'README.md');

const rows = [];

for (const file of files) {
  // [261114-config-profile] 规范化 CRLF：git 在 Windows 上会把 LF 转 CRLF，
  // 而下面的 frontmatter 正则以 ^---\n 匹配，CRLF 文件会被静默跳过（曾导致 261114-dxy8if 从 INDEX 消失）。
  // 详见 docs/requirements/261114-config-profile.md
  const content = fs.readFileSync(path.join(REQ_DIR, file), 'utf8').replace(/\r\n/g, '\n');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) continue;

  const fm = {};
  for (const line of fmMatch[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }

  if (!fm.id) continue;

  const title = fm.title || '(无标题)';
  const status = fm.status || '-';
  const type = fm.type || '-';
  const branch = fm.branch || '-';
  const updated = fm.updated || '-';

  rows.push('| ' + fm.id + ' | ' + type + ' | [' + title + '](./' + file + ') | ' + status + ' | ' + branch + ' | ' + updated + ' |');
}

rows.sort((a, b) => a.localeCompare(b));

const header = ['# 需求索引', '', '> 本文件由 scripts/build-docs-index.mjs 自动生成，请勿手改。', '', '| ID | 类型 | 标题 | 状态 | 分支 | 更新 |', '|---|---|---|---|---|---|'];
const md = header.join('\n') + '\n' + rows.join('\n') + '\n\n共 ' + rows.length + ' 个需求。\n';

fs.writeFileSync(INDEX_FILE, md, 'utf8');
console.log('[build-docs-index] 已更新 INDEX.md，共 ' + rows.length + ' 个需求');