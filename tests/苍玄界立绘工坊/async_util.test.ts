import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../../src/苍玄界立绘工坊/core/async_util.ts';

test('mapWithConcurrency 保持结果顺序', async () => {
  const items = [5, 1, 4, 2, 3];
  const out = await mapWithConcurrency(items, 2, async (n, i) => {
    await new Promise(r => setTimeout(r, n));
    return i + ':' + n;
  });
  assert.deepEqual(out, ['0:5', '1:1', '2:4', '3:2', '4:3']);
});

test('mapWithConcurrency 遵守并发上限', async () => {
  let running = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 5));
    running -= 1;
    return 0;
  });
  assert.ok(peak <= 3, '并发峰值不应超过上限，实际 ' + peak);
  assert.ok(peak >= 2, '应真的并发，实际 ' + peak);
});

test('mapWithConcurrency 支持中止', async () => {
  let done = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async () => {
    done += 1;
    return done;
  }, { shouldStop: () => done >= 2 });
  assert.ok(done < 6, '应提前停止，实际处理了 ' + done);
  assert.equal(out.filter(v => v !== undefined).length, 2);
});

test('mapWithConcurrency 处理空数组与非法并发数', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  const out = await mapWithConcurrency([1, 2, 3], 0, async n => n * 2);
  assert.deepEqual(out, [2, 4, 6]);
});
