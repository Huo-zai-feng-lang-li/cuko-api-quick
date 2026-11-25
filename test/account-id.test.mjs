/**
 * 新增账号：自动生成唯一内部 ID + 别名必填。
 *
 * 全部在临时目录 / 内存假数据上跑，不碰用户真实 data/，不拉起 Chrome、不登录 Quick。
 * 路由层的读-改-写顺序用真实串行锁 + 临时 accounts.json 复现。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateAccountInput,
  generateUniqueAccountId,
  listProfileDirNames,
} from '../bridge/account-id.js';
import { createSerialLock } from '../bridge/serial-lock.js';
import { listModelAliases } from '../bridge/account-scheduler.js';

const test = (name, fn) => globalThis.__test(name, fn);
const assert = globalThis.__assert;

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuko-acct-id-'));
  return dir;
}

test('别名缺失/空白 → 400，错误信息说明同别名组成池', () => {
  for (const bad of [{}, { modelAlias: '' }, { modelAlias: '   ' }]) {
    const r = validateAccountInput(bad);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /必填/);
    assert.match(r.error, /池/);
  }
});

test('别名含非法字符 → 400', () => {
  const r = validateAccountInput({ modelAlias: 'bad alias!' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('显式 modelId 合法时原样保留；非法字符 → 400', () => {
  const ok = validateAccountInput({ modelId: 'my-acc_1', modelAlias: 'pool-a' });
  assert.equal(ok.ok, true);
  assert.equal(ok.modelId, 'my-acc_1');
  assert.equal(ok.modelAlias, 'pool-a');

  const bad = validateAccountInput({ modelId: 'bad id', modelAlias: 'pool-a' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
});

test('省略 modelId：连续两次新增得到 acct-1、acct-2', () => {
  const firstId = generateUniqueAccountId([], []);
  assert.equal(firstId, 'acct-1');
  const secondId = generateUniqueAccountId([{ modelId: firstId }], []);
  assert.equal(secondId, 'acct-2');
});

test('历史 ID（aws / aws-2）不参与 acct-N 编号计算', () => {
  const id = generateUniqueAccountId([{ modelId: 'aws' }, { modelId: 'aws-2' }], []);
  assert.equal(id, 'acct-1');
});

test('profiles 目录已占用 acct-1 时，自动跳到 acct-2', () => {
  const id = generateUniqueAccountId([], ['acct-1']);
  assert.equal(id, 'acct-2');
});

test('profiles 目录读取：子目录名列出，缺失目录返回空列表', () => {
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'acct-1'));
    fs.writeFileSync(path.join(dir, 'some-file.txt'), 'x');
    const names = listProfileDirNames(dir);
    assert.deepEqual(names, ['acct-1']);
    assert.deepEqual(listProfileDirNames(path.join(dir, 'nope')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('并发新增 5 个：串行锁内读-改-写，ID 不撞、accounts.json 不丢写', async () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, '[]', 'utf8');
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const write = (accounts) => fs.writeFileSync(file, JSON.stringify(accounts), 'utf8');

    // 复现路由层：withConfigLock 内读 accounts.json → 生成唯一 ID → 追加 → 落盘
    const lock = createSerialLock();
    const ids = await Promise.all(Array.from({ length: 5 }, () => lock(async () => {
      const accounts = read();
      const id = generateUniqueAccountId(accounts, listProfileDirNames(dir));
      accounts.push({ modelId: id, modelAlias: 'pool-a', createdAt: Date.now() });
      write(accounts);
      return id;
    })));

    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5, '5 个 ID 必须互不相同');
    const saved = read();
    assert.equal(saved.length, 5, 'accounts.json 不能丢写');
    assert.deepEqual(saved.map((a) => a.modelId).sort(), [...ids].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同别名两个账号：模型列表只出现一个（池语义）', () => {
  const accounts = [
    { modelId: 'acct-1', modelAlias: 'pool-a', createdAt: 1 },
    { modelId: 'acct-2', modelAlias: 'pool-a', createdAt: 2 },
  ];
  const aliases = listModelAliases(accounts);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].alias, 'pool-a');
  assert.equal(aliases[0].accounts, 2);

  const mixed = [...accounts, { modelId: 'acct-3', modelAlias: 'pool-b', createdAt: 3 }];
  assert.equal(listModelAliases(mixed).length, 2);
});
