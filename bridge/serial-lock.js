/**
 * 串行锁：把会互相覆盖的异步写操作排成一条链。
 *
 * 账号/方案接口都是“读文件 → 改数组 → 写文件”，Node 单线程也挡不住 await 交错，
 * 两个请求同时进来会互相覆盖（典型：删除 A 的同时添加 B，B 的旧数组把 A 又写回去）。
 * 这里只串行写操作，读请求和聊天不受影响。
 *
 * @returns {(task:()=>Promise<any>)=>Promise<any>}
 */
export function createSerialLock() {
  let tail = Promise.resolve();
  return function run(task) {
    const result = tail.then(task, task);
    // 前一个任务失败不能让整条队列断掉
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
