/**
 * 验收回归：脚本变量作用域（{ type: 'script' } + script_id）、导入 / 导出。
 *
 * 背景：用户要求数据放**脚本变量**，卸载脚本不留残留；作用域参数从 { type: 'global' } 改成了 { type: 'script' }。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const core = '../../src/苍玄助手/core/';
const { resolveScriptId, scriptScope, exportAll, importAll, setHostBridge, defaultRootData, loadData, saveData } =
  await import(core + 'storage.ts');
const { GLOBAL_KEY, RootDataSchema } = await import(core + 'types.ts');

function clearScriptId() {
  delete globalThis.__CX_SCRIPT_ID__;
}

test('scope: resolveScriptId 解析链 —— globalThis.__CX_SCRIPT_ID__ 优先于 getScriptId()，都取到后去首尾空白', () => {
  try {
    globalThis.__CX_SCRIPT_ID__ = '  panel-script-1  ';
    const called = [];
    setHostBridge({
      getScriptId: () => {
        called.push(1);
        return 'tavern-id';
      },
    });
    assert.equal(resolveScriptId(), 'panel-script-1', '注入的 id 优先，且去掉首尾空白');
    assert.equal(called.length, 0, '注入了就不该再问 getScriptId');

    // 注入的是空白串 → 视为没有，继续问 getScriptId
    globalThis.__CX_SCRIPT_ID__ = '   ';
    assert.equal(resolveScriptId(), 'tavern-id');

    // 注入的不是字符串 → 视为没有
    globalThis.__CX_SCRIPT_ID__ = 42;
    assert.equal(resolveScriptId(), 'tavern-id');

    // 注入 null → 视为没有
    globalThis.__CX_SCRIPT_ID__ = null;
    assert.equal(resolveScriptId(), 'tavern-id');
  } finally {
    clearScriptId();
    setHostBridge(null);
  }
});

test('scope: getScriptId 抛错 / 返回空 / 返回非字符串 → 降级为 undefined（省略 script_id）', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    clearScriptId();

    setHostBridge({
      getScriptId: () => {
        throw new Error('宿主没有这个接口');
      },
    });
    assert.equal(resolveScriptId(), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /getScriptId 失败/);
    assert.deepEqual(scriptScope(), { type: 'script' }, '解析不到就省略 script_id');

    setHostBridge({ getScriptId: () => '   ' });
    assert.equal(resolveScriptId(), undefined);
    assert.deepEqual(scriptScope(), { type: 'script' });

    setHostBridge({ getScriptId: () => 12345 });
    assert.equal(resolveScriptId(), undefined);

    setHostBridge({ getScriptId: () => null });
    assert.equal(resolveScriptId(), undefined);

    setHostBridge({});
    assert.equal(resolveScriptId(), undefined, '完全没有宿主接口也不能抛');
  } finally {
    console.warn = originalWarn;
    clearScriptId();
    setHostBridge(null);
  }
});

test('scope: scriptScope 带上 script_id（有 id 时）', () => {
  try {
    clearScriptId();
    assert.deepEqual(scriptScope(), { type: 'script' });

    globalThis.__CX_SCRIPT_ID__ = ' cx-9 ';
    assert.equal(resolveScriptId(), 'cx-9');
    assert.deepEqual(scriptScope(), { type: 'script', script_id: 'cx-9' });
  } finally {
    clearScriptId();
    setHostBridge(null);
  }
});

test('scope: 三级写兜底三条路（insertOrAssign / replace / updateWith）都带脚本作用域和 script_id', () => {
  const expected = { type: 'script', script_id: 'cx-write-1' };
  const seen = { insert: [], replace: [], update: [], read: [] };
  try {
    clearScriptId();
    globalThis.__CX_SCRIPT_ID__ = 'cx-write-1';

    setHostBridge({
      insertOrAssignVariables: (payload, options) => seen.insert.push({ payload, options }),
    });
    saveData(defaultRootData());
    assert.deepEqual(seen.insert[0].options, expected);
    assert.ok(seen.insert[0].payload[GLOBAL_KEY], '还是只写我们那一个 key');

    setHostBridge({
      getVariables: scope => {
        seen.read.push(scope);
        return { someone_else: 1 };
      },
      replaceVariables: (next, options) => seen.replace.push({ next, options }),
    });
    saveData(defaultRootData());
    assert.deepEqual(seen.replace[0].options, expected);
    assert.equal(seen.replace[0].next.someone_else, 1);
    assert.deepEqual(seen.read, [expected], '整表接口读的时候也用同一个作用域');

    setHostBridge({
      updateVariablesWith: (updater, options) => seen.update.push({ value: updater({ someone_else: 2 }), options }),
    });
    saveData(defaultRootData());
    assert.deepEqual(seen.update[0].options, expected);
    assert.equal(seen.update[0].value.someone_else, 2);
  } finally {
    clearScriptId();
    setHostBridge(null);
  }
});

test('io: exportAll(true) 保留 api.key；exportAll(false) 抹成空串且不改入参', () => {
  const data = defaultRootData();
  data.api.key = 'sk-secret';
  data.api.url = 'https://api.test/v1';
  data.selection.demand = '整理天枢阁';
  const snapshot = structuredClone(data);

  const withKey = JSON.parse(exportAll(true, data));
  assert.equal(withKey.api.key, 'sk-secret');
  assert.equal(withKey.selection.demand, '整理天枢阁');
  assert.equal(withKey.version, data.version);

  const withoutKey = JSON.parse(exportAll(false, data));
  assert.equal(withoutKey.api.key, '', '不导出 key');
  assert.equal(withoutKey.api.url, 'https://api.test/v1', '只抹 key，别的字段不动');
  assert.equal(withoutKey.selection.demand, '整理天枢阁');
  assert.deepEqual(data, snapshot, 'exportAll 不许改入参');

  // 不传 data → 从脚本变量读（读出来已逐块恢复）
  try {
    setHostBridge({ getVariables: () => ({ [GLOBAL_KEY]: { api: { key: 'sk-host' }, active_tab: 'chat' } }) });
    const fromStore = JSON.parse(exportAll(false));
    assert.equal(fromStore.api.key, '');
    assert.equal(fromStore.active_tab, 'chat');
    assert.equal(fromStore.gen.image_concurrency, 4, '缺的块要补默认值');
  } finally {
    setHostBridge(null);
  }
});

test('io: importAll 合法往返 ok:true；坏输入一律 ok:false 带 error 且不抛', () => {
  const data = defaultRootData();
  data.api.key = 'sk-round';
  data.api.url = 'https://api.test/v1';
  data.active_tab = 'worldbook';
  data.selection.worldbook_names = ['天枢阁'];
  data.presets = [
    {
      id: 'p1',
      name: '预设',
      builtin: false,
      output: 'none',
      items: [{ type: 'message', id: 'p1-sys', role: 'system', content: 's' }],
      use_global_caps: true,
      tools: ['wb_read'],
      skills: [],
      max_rounds: 3,
    },
  ];

  const text = exportAll(true, data);
  const back = importAll(text);
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(back.data.api.key, 'sk-round');
  assert.deepEqual(back.data.selection.worldbook_names, ['天枢阁']);
  assert.deepEqual(back.data.presets[0].id, 'p1');
  assert.equal(RootDataSchema.safeParse(back.data).success, true, '导入结果必须能过 RootDataSchema');

  const cases = [
    ['', /为空/],
    ['   ', /为空/],
    ['不是 JSON', /不是合法的 JSON/],
    ['{"api":', /不是合法的 JSON/],
    ['[]', /数据结构不对/],
    ['"字符串"', /数据结构不对/],
    ['{"api":{"timeout_sec":-1}}', /数据结构不对/],
    ['{"active_tab":"nope"}', /数据结构不对/],
    ['{"drafts":[{"kind":"nope"}]}', /数据结构不对/],
  ];
  for (const [input, pattern] of cases) {
    let result;
    assert.doesNotThrow(() => {
      result = importAll(input);
    }, 'importAll 不许抛：' + JSON.stringify(input));
    assert.equal(result.ok, false, '应判为坏输入：' + JSON.stringify(input));
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    assert.match(result.error, pattern, JSON.stringify(input));
  }

  // 非字符串输入也不抛
  for (const bad of [null, undefined, 42, {}, []]) {
    const result = importAll(bad);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  }
});

test('io: importAll 只解析不落盘（落盘要调用方自己 saveData）', () => {
  const writes = [];
  try {
    setHostBridge({ insertOrAssignVariables: (...args) => writes.push(args) });
    const result = importAll(exportAll(true, defaultRootData()));
    assert.equal(result.ok, true);
    assert.equal(writes.length, 0, 'importAll 不许自己写存储');
  } finally {
    setHostBridge(null);
  }
});

test('io: 读入口走脚本变量（loadData 不碰 global 作用域）', () => {
  const scopes = [];
  try {
    setHostBridge({
      getVariables: scope => {
        scopes.push(scope);
        // 历史数据里存的页签名：'skills' 读出来要落到 'capability'（页签扩容改名）
        return { [GLOBAL_KEY]: { active_tab: 'skills' } };
      },
    });
    assert.equal(loadData().active_tab, 'capability');
    assert.deepEqual(scopes, [{ type: 'script' }]);
  } finally {
    setHostBridge(null);
  }
});

/* ============================ 源码级防回归 ============================ */

function sourceFiles(dir) {
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|vue|js|css|html)$/.test(item.name)) out.push(full);
  }
  return out;
}

test('源码级: src/苍玄助手 下不存在 type: \'global\' 作用域（防回归）', () => {
  const files = sourceFiles('src/苍玄助手');
  assert.ok(files.length > 20, '源码文件数不对：' + files.length);
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (/type\s*:\s*['"]global['"]/.test(line)) offenders.push(file + ':' + (index + 1) + ': ' + line.trim());
    });
  }
  assert.deepEqual(offenders, [], '变量作用域必须一律用脚本作用域');

  const storage = readFileSync('src/苍玄助手/core/storage.ts', 'utf8');
  assert.match(storage, /type: 'script'/);
  assert.match(storage, /__CX_SCRIPT_ID__/);
  assert.match(storage, /script_id/);
});
