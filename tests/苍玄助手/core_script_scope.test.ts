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
const { resolveScriptId, scriptScope, exportAll, importAll, setHostBridge, defaultRootData, loadData, saveData, resetDataScope, resetLoadOutcome } =
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

  // 未知字符串 id：导入照样 ok，schema 不清洗（画不画得出来由 availablePages + store.setTab 兜底）
  const oddTab = importAll('{"active_tab":"nope"}');
  assert.equal(oddTab.ok, true, oddTab.error);
  assert.equal(oddTab.data.active_tab, 'nope');

  const cases = [
    ['', /为空/],
    ['   ', /为空/],
    ['不是 JSON', /不是合法的 JSON/],
    ['{"api":', /不是合法的 JSON/],
    ['[]', /数据结构不对/],
    ['"字符串"', /数据结构不对/],
    ['{"api":{"timeout_sec":-1}}', /数据结构不对/],
    // active_tab 放宽成 string 之后，未知字符串不再是坏数据（页面兜底在 store）；
    // 非字符串仍然是坏数据
    ['{"active_tab":123}', /数据结构不对/],
    ['{"active_tab":["records"]}', /数据结构不对/],
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

test('io: 读入口**按形态选作用域**（脚本形态走 script，扩展形态走 global）', () => {
  // ⚠️ P4-10 改：本条原名「读入口走脚本变量（loadData 不碰 global 作用域）」——
  // 那个名字与现在的契约**正好相反**（扩展形态必须碰 global 才读得回来），
  // 所以连用例名一起改。一个名字与断言相反的测试比没有测试更坏。
  const saved = {
    scriptId: globalThis.__CX_SCRIPT_ID__,
    helper: globalThis.TavernHelper,
    bare: globalThis.getScriptId,
  };
  try {
    // ---- 形态一：脚本形态（有 __CX_SCRIPT_ID__）→ 必须用带 script_id 的脚本作用域 ----
    delete globalThis.TavernHelper;
    delete globalThis.getScriptId;
    globalThis.__CX_SCRIPT_ID__ = 'sid-read';
    resetDataScope();
    resetLoadOutcome();
    const scriptScopes = [];
    setHostBridge({
      getVariables: scope => {
        scriptScopes.push(scope);
        return { [GLOBAL_KEY]: { active_tab: 'skills' } };
      },
    });
    // 历史数据里存的页签名：阶段 2 起 'skills'（老「能力」页）读出来要落到 'settings'
    assert.equal(loadData().active_tab, 'settings');
    assert.deepEqual(scriptScopes, [{ type: 'script', script_id: 'sid-read' }], '脚本形态：老数据原地读，作用域不变');

    // ---- 形态二：扩展形态（两者都无）→ 必须用 global，否则真机读不回来 ----
    delete globalThis.__CX_SCRIPT_ID__;
    resetDataScope();
    resetLoadOutcome();
    const extScopes = [];
    setHostBridge({
      getVariables: scope => {
        extScopes.push(scope);
        return { [GLOBAL_KEY]: { active_tab: 'skills' } };
      },
    });
    assert.equal(loadData().active_tab, 'settings');
    assert.deepEqual(extScopes, [{ type: 'global' }], '扩展形态：必须走 global（P4-10 数据丢失的根因）');
  } finally {
    setHostBridge(null);
    if (saved.scriptId === undefined) delete globalThis.__CX_SCRIPT_ID__;
    else globalThis.__CX_SCRIPT_ID__ = saved.scriptId;
    if (saved.helper !== undefined) globalThis.TavernHelper = saved.helper;
    if (saved.bare !== undefined) globalThis.getScriptId = saved.bare;
    resetDataScope();
    resetLoadOutcome();
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

/**
 * 作用域字面量的**唯一合法去处**。
 *
 * P4-10 之前这条闸是「源码里不许出现 global 作用域」—— 那是「存储只走脚本变量」时代的口径。
 * P4-10 要求扩展形态用 global（否则真机读不回来、每刷新丢一次数据），旧口径**方向反了**。
 * 现在改成「作用域字面量只能出现在这两个文件的**作用域解析处**」，闸继续保留其价值：
 * 防止以后有人在别处裸写作用域（那正是「读一处写另一处」这类 bug 的温床）。
 */
const SCOPE_LITERAL_ALLOWED = ['src/苍玄助手/core/native.ts', 'src/苍玄助手/core/storage.ts'];

/** 一行里有没有作用域字面量（script / global / chat 三档都算） */
function scopeLiteralOn(line) {
  return /type\s*:\s*['"](script|global|chat)['"]/.test(line);
}

/**
 * 判定一组 {file, text} 里有没有「不该出现的作用域字面量」。
 *
 * 抽成纯函数是为了**能对假源码跑**：下面专门有一条用例喂违规片段，
 * 确认这套判定真的会报警（写不出反例的断言只会给人虚假安全感）。
 */
function findScopeLiteralOffenders(files) {
  const offenders = [];
  for (const file of files) {
    const norm = file.path.replace(/\\/g, '/');
    if (SCOPE_LITERAL_ALLOWED.some(allowed => norm.endsWith(allowed.replace('src/苍玄助手/', '')))) continue;
    file.text.split(/\r?\n/).forEach((line, index) => {
      // 注释里提到作用域不算违规（本文件 / storage / native 的注释里有大量说明）
      const code = line.replace(/^\s*\*.*$/, '').replace(/^\s*\/\/.*$/, '');
      if (scopeLiteralOn(code)) offenders.push(norm + ':' + (index + 1) + ': ' + line.trim());
    });
  }
  return offenders;
}

test('源码级: 作用域字面量只出现在 core/native.ts 与 core/storage.ts（P4-10 新口径）', () => {
  const files = sourceFiles('src/苍玄助手');
  assert.ok(files.length > 20, '源码文件数不对：' + files.length);
  const offenders = findScopeLiteralOffenders(
    files.map(file => ({ path: file, text: readFileSync(file, 'utf8') })),
  );
  assert.deepEqual(offenders, [], '作用域字面量只许出现在 core/native.ts / core/storage.ts 的作用域解析处');

});
/*
 * ⚠️ 上面那条闸**必须能失败** —— 本项目的既定要求：
 * 「写不出反例的断言只会给人虚假安全感」。
 * 这里喂三段假源码给同一套判定，确认它真的会报警 / 真的会放行。
 */

test('源码级: 作用域闸**能失败**（喂违规片段确认报警）', () => {
  // ① 在别处裸写 global → 必须报
  const bad = [{ path: 'src/苍玄助手/components/SomeView.vue', text: "const scope = { type: 'global' };" }];
  assert.equal(findScopeLiteralOffenders(bad).length, 1, '别处裸写 global 必须被闸抓到');

  // ② 在别处裸写 script → 同样必须报（闸管的是「位置」，不是「哪一档」）
  const badScript = [{ path: 'src/苍玄助手/stores/app.ts', text: "getVariables({ type: 'script' });" }];
  assert.equal(findScopeLiteralOffenders(badScript).length, 1, '别处裸写 script 也要报');

  // ③ 在别处裸写 chat → 也要报
  const badChat = [{ path: 'src/苍玄助手/core/worldbook.ts', text: "const s = { type: 'chat' };" }];
  assert.equal(findScopeLiteralOffenders(badChat).length, 1);

  // ④ 合法位置（两个文件的相对路径形态）→ 放行
  const good = [
    { path: 'C:/x/src/苍玄助手/core/native.ts', text: "return { type: 'global' };" },
    { path: 'C:/x/src/苍玄助手/core/storage.ts', text: "const scope = { type: 'script', script_id: 'x' };" },
  ];
  assert.deepEqual(findScopeLiteralOffenders(good), [], '允许位置不该误报');

  // ⑤ 注释里提到作用域不算违规
  const commented = [{ path: 'src/苍玄助手/core/ports.ts', text: " * 扩展形态下 type: 'global' 才是对的" }];
  assert.deepEqual(findScopeLiteralOffenders(commented), [], '注释不算违规');
});

test('源码级: 两个允许文件**确实**还在用作用域字面量（闸没被架空）', () => {
  const native = readFileSync('src/苍玄助手/core/native.ts', 'utf8');
  assert.match(native, /type: 'global'/, 'native.ts 的 dataScope 要给出 global（扩展形态）');
  assert.match(native, /type: 'script'/, 'native.ts 要保留 script（脚本形态）');
  const storageText = readFileSync('src/苍玄助手/core/storage.ts', 'utf8');
  assert.match(storageText, /type: 'script'/, 'storage.ts 保留脚本作用域');
  assert.match(storageText, /__CX_SCRIPT_ID__/, 'storage.ts 仍认面板注入的脚本 id');
  assert.match(storageText, /script_id/, 'storage.ts 仍传 script_id');
});
