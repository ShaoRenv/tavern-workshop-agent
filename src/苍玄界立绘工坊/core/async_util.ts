/** 并发控制与通用异步小工具（纯逻辑，可单测） */

/**
 * 以受限并发对数组各项执行异步任务，并保持结果顺序与输入一致。
 *
 * 用于图片下载等 IO 密集场景：串行太慢，全并发又可能被图床限流。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { shouldStop?: () => boolean } = {},
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit) || 1);
  const results = new Array<R>(items.length);
  let cursor = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      if (options.shouldStop?.()) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  const runners: Promise<void>[] = [];
  const workerCount = Math.min(size, Math.max(items.length, 1));
  for (let index = 0; index < workerCount; index++) runners.push(run());
  await Promise.all(runners);

  return results;
}

/** 让出事件循环，便于界面刷新进度 */
export function yieldToUi(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
