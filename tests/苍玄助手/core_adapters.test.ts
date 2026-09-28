/**
 * 验收补充：core/adapters.ts —— 界面适配层「不进正文」、宿主失败的降级、模型列表归一化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const core = '../../src/苍玄助手/core/';
const { loadRoles, loadWorlds, loadEntries, toUiTools, fetchModels, parsePortraitFile, defaultWorldbookSelection } = await import(core + 'adapters.ts');
const { setHostBridge } = await import(core + 'storage.ts');

function installHost(over = {}) {
  const worlds = new Map();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  setHostBridge({
    getWorldbookNames: () => [...worlds.keys()],
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getChatWorldbookName: () => null,
    getWorldbook: name => structuredClone(worlds.get(name) ?? []),
    replaceWorldbook: () => {},
    createWorldbook: () => {},
    deleteWorldbook: () => true,
    ...over,
  });
  return {
    worlds,
    warnings,
    restore() {
      console.warn = originalWarn;
      setHostBridge(null);
    },
  };
}

/* ============================ loadEntries：不许把正文带进界面 ============================ */

test('adapters: loadEntries 只回 uid/name/group，正文一个字都不许进界面模型', async () => {
  const host = installHost();
  try {
    host.worlds.set('甲本', [
      { uid: 1, name: '====角色设定====', content: '这只是分隔条目' },
      { uid: 2, name: '潮听澜', content: 'SECRET-A', enabled: true },
      { uid: 3, name: '凌霄真人', content: 'SECRET-B', group: '自定义组' },
      { uid: 2, name: '重复 uid 的条目', content: 'SECRET-C' },
      { uid: '', name: '没有 uid', content: 'SECRET-E' },
      { uid: 5, name: '   ', content: 'SECRET-F' },
    ]);
    host.worlds.set('乙本', [{ uid: 4, name: '苍梧山', content: 'SECRET-D' }]);

    const rows = await loadEntries(['甲本', '乙本']);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes('SECRET'), '正文绝不能出现在界面模型里：' + text);
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['group', 'name', 'uid']);

    assert.deepEqual(rows, [
      { uid: '2', name: '潮听澜', group: '角色设定' },
      { uid: '3', name: '凌霄真人', group: '自定义组' },
      { uid: '5', name: '', group: '角色设定' },
      { uid: '4', name: '苍梧山', group: '' },
    ]);
    assert.equal(host.warnings.length, 0, '正常路径不该 warn');
  } finally {
    host.restore();
  }
});

test('adapters: loadEntries 空入参 / 非数组 / 单本读失败都不炸，失败本只 warn 跳过', async () => {
  const host = installHost({
    getWorldbook: name => {
      if (name === '坏本') throw new Error('读不到');
      return structuredClone(host.worlds.get(name) ?? []);
    },
  });
  try {
    host.worlds.set('好本', [{ uid: 1, name: '甲', content: 'x' }]);
    assert.deepEqual(await loadEntries([]), []);
    assert.deepEqual(await loadEntries(null), []);
    assert.deepEqual(await loadEntries('不是数组'), []);
    assert.deepEqual(await loadEntries(['  ']), []);

    const rows = await loadEntries(['坏本', '好本']);
    assert.deepEqual(rows, [{ uid: '1', name: '甲', group: '' }]);
    assert.equal(host.warnings.length, 1);
    assert.match(host.warnings[0], /读取世界书条目失败：坏本/);
  } finally {
    host.restore();
  }
});

test('adapters: 宿主整个不可用时 loadEntries / loadWorlds / loadRoles 都回空数组（不抛）', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    setHostBridge({});
    assert.deepEqual(await loadEntries(['天枢阁']), []);
    assert.deepEqual(await loadWorlds(), []);
    assert.ok(Array.isArray(await loadRoles()));
  } finally {
    console.warn = originalWarn;
    setHostBridge(null);
  }
});

/* ============================ loadWorlds / toUiTools ============================ */

test('adapters: loadWorlds 标出当前启用的世界书', async () => {
  const host = installHost({ getGlobalWorldbookNames: () => ['乙本'] });
  try {
    host.worlds.set('甲本', []);
    host.worlds.set('乙本', []);
    host.worlds.set('丙本', []);
    assert.deepEqual(await loadWorlds(), [
      { name: '甲本', current: false },
      { name: '乙本', current: true },
      { name: '丙本', current: false },
    ]);
  } finally {
    host.restore();
  }
});

test('adapters: toUiTools 只挑界面要的字段', () => {
  const rows = [
    { name: 'wb_read', title: '读条目', desc: '读', group: 'knowledge', default_on: true, 多余的: 1 },
    { name: 'submit' },
  ];
  assert.deepEqual(toUiTools(rows), [
    { name: 'wb_read', title: '读条目', desc: '读', group: 'knowledge', default_on: true },
    { name: 'submit', title: undefined, desc: undefined, group: undefined, default_on: undefined },
  ]);
});

/* ============================ fetchModels ============================ */

test('adapters: fetchModels 没填地址直接回空；优先用酒馆 getModelList 并归一化', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  const calls = [];
  try {
    setHostBridge({
      getModelList: async request => {
        calls.push(request);
        return { data: [{ id: 'm1' }, { id: 'm1' }, { name: 'm2' }, 'm3', { model: 'm4' }, { 没名字: 1 }] };
      },
    });
    assert.deepEqual(await fetchModels({ url: '' }), [], '没地址就不打扰接口');
    assert.equal(calls.length, 0);

    const models = await fetchModels({ url: 'https://api.test/v1/', key: 'sk-1', timeout_sec: 5 });
    assert.deepEqual(models, ['m1', 'm2', 'm3', 'm4']);
    assert.deepEqual(calls, [{ apiurl: 'https://api.test/v1/', key: 'sk-1' }]);
  } finally {
    console.warn = originalWarn;
    setHostBridge(null);
  }
});

test('adapters: getModelList 失败时直连 {url}/models，失败一律回空数组', async () => {
  const originalWarn = console.warn;
  const originalFetch = globalThis.fetch;
  const seen = [];
  console.warn = () => {};
  try {
    setHostBridge({
      getModelList: async () => {
        throw new Error('酒馆接口没有');
      },
    });
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'glm-4' }, { id: 'glm-4' }, { id: 'glm-5' }] }) };
    };
    const models = await fetchModels({ url: 'https://api.test/v1', key: 'sk-1', timeout_sec: 99 });
    assert.deepEqual(models, ['glm-4', 'glm-5']);
    assert.equal(seen[0].url, 'https://api.test/v1/models');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer sk-1');

    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.deepEqual(await fetchModels({ url: 'https://api.test/v1' }), []);

    globalThis.fetch = async () => {
      throw new Error('网络炸了');
    };
    assert.deepEqual(await fetchModels({ url: 'https://api.test/v1' }), []);

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => '不是数组' });
    assert.deepEqual(await fetchModels({ url: 'https://api.test/v1' }), []);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    setHostBridge(null);
  }
});

test('adapters: getModelList 返回空表时继续直连兜底', async () => {
  const originalWarn = console.warn;
  const originalFetch = globalThis.fetch;
  console.warn = () => {};
  try {
    setHostBridge({ getModelList: async () => [] });
    let fetched = 0;
    globalThis.fetch = async () => {
      fetched++;
      return { ok: true, status: 200, json: async () => ['来自直连'] };
    };
    assert.deepEqual(await fetchModels({ url: 'https://api.test/v1' }), ['来自直连']);
    assert.equal(fetched, 1);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    setHostBridge(null);
  }
});

/* ============================ 世界书默认勾选（B4） ============================ */

/** 造一条勾选状态（schema 默认值 + 覆盖项） */
function sel(over = {}) {
  return { character_ids: [], worldbook_names: [], entry_uid: [], demand: '', user_edited: false, ...over };
}

function w(name, current) {
  return { name, current };
}

test('B4: 从没勾过 → 勾上当前生效的那几本', () => {
  const worlds = [w('甲', true), w('乙', false), w('丙', true)];
  assert.deepEqual(defaultWorldbookSelection(worlds, sel()), ['甲', '丙']);
});

test('B4: 用户亲手动过（含「一本都不要」）→ 一律不动', () => {
  const worlds = [w('甲', true), w('丙', true)];
  // 勾 0 本 + 动过 = 明确的选择，刷新不许替他勾回来
  assert.equal(defaultWorldbookSelection(worlds, sel({ user_edited: true })), null);
  // 勾着东西但没标 user_edited（老数据手写的选择）也不动
  assert.equal(defaultWorldbookSelection(worlds, sel({ worldbook_names: ['乙'] })), null);
  // 动过且勾着东西，同样不动
  assert.equal(defaultWorldbookSelection(worlds, sel({ user_edited: true, worldbook_names: ['乙'] })), null);
});

test('B4: 一本当前生效的都没有 / 读不到世界书 → 不动（不用空数组覆盖）', () => {
  assert.equal(defaultWorldbookSelection([], sel()), null, '没读到世界书');
  assert.equal(defaultWorldbookSelection([w('甲', false), w('乙', false)], sel()), null, '一本都没启用');
});

test('B4: 契约 —— App.vue 在 refreshAll 里、refreshEntries 之前补默认值', () => {
  // 这三条是**顺序**契约，写错了不报错但会闪空列表 / 白跑一次宿主 IO
  const app = readFileSync('src/苍玄助手/App.vue', 'utf8');
  assert.ok(app.includes('defaultWorldbookSelection'), 'App.vue 要真的调它');
  const body = /async function refreshAll\(\)[\s\S]*?\n}/.exec(app);
  assert.ok(body, '找不到 refreshAll');
  const iDefault = body[0].indexOf('applyWorldbookDefault()');
  const iEntries = body[0].indexOf('await refreshEntries()');
  assert.ok(iDefault >= 0 && iEntries >= 0, 'refreshAll 里两件事都要有');
  assert.ok(iDefault < iEntries, '先补默认值再读条目（否则先按空选择读一遍）');
  // 世界书页的三个写点都要记 user_edited，否则「清空后刷新又被勾回来」
  const page = readFileSync('src/苍玄助手/plugins/builtin/worldbook/Page.vue', 'utf8');
  assert.ok(page.includes('user_edited = true'), '世界书页要记用户动过');
  for (const fn of ['toggleWorld', 'selectAllWorlds', 'clearWorlds']) {
    const body = new RegExp('function ' + fn + '\\([^)]*\\)[\\s\\S]*?\\n}').exec(page);
    assert.ok(body, '找不到 ' + fn);
    assert.ok(body[0].includes('markWorldsEdited()'), fn + ' 要记 user_edited（不能只 touch）');
  }
});

/* ============================ parsePortraitFile ============================ */

test('adapters: parsePortraitFile 对不是 PNG 的文件回 ok:false + 人话错误', async () => {
  const result = await parsePortraitFile({ name: '不是图.png', arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer });
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.match(result.error, /PNG/);
});

test('adapters: parsePortraitFile 读得到没有元数据的真 PNG 时给出可读提示（不抛）', async () => {
  // 用仓库里现成的立绘 fixture：图里没有 AI 元数据块，应走「读到了但没字段」那条分支
  const bytes = new Uint8Array(readFileSync('tests/苍玄界立绘工坊/fixtures/江念-立绘.png'));
  const result = await parsePortraitFile({ name: '江念-立绘.png', arrayBuffer: async () => bytes.buffer.slice(0) });
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.text, 'string');
  if (!result.ok) assert.ok(result.error && result.error.length > 0, '失败也要有人话原因');
});
