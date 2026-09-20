/**
 * 阶段 3 · T3-7：manual_meta 落盘往返 —— **只存 URL，不存 base64**。
 *
 * 老坑（reports/苍玄助手-底座化实施计划.md §2.2）：以前的「传图」结果只存在 App.vue 的
 * 内存 ref 里，**刷新就没了**。阶段 3 搬进 plugins.cangxuan.manual_meta 才真的存下来。
 *
 * S0 探针（reports/苍玄助手-真文件存储探针.md §17.6）定死了形态：
 * 立绘 / 素材走 ST 原生 /api/images/upload 传成真文件，变量里**只留路径字符串**。
 * settings.json 已经 50MB，再往里塞 base64 会把宿主撑爆 —— 这条断言就是防它。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { codeOnly } from './_helpers.ts';

const root = '../../src/苍玄助手/';
const { GLOBAL_KEY, CangxuanConfigSchema, RootDataSchema, DATA_VERSION } = await import(root + 'core/types.ts');
const { recoverRootData, importAll, setHostBridge, defaultRootData } = await import(root + 'core/storage.ts');
const { useAppStore } = await import(root + 'stores/app.ts');

/** 上传成功后拿到的真 URL 形态（探针实测：/user/images/cx-assets/xxx.png） */
const REAL_URL = '/user/images/cx-assets/cx-from-panel.png';
/** 探针里的 1×1 PNG，base64 —— 这是**绝对不许**进变量的东西 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = 'data:image/png;base64,' + PNG_BASE64;

/** 每个用例一份干净的 store（pinia 全局单例，必须重建） */
function freshStore() {
  const writes: any[] = [];
  setHostBridge({ insertOrAssignVariables: (payload: any) => writes.push(payload) });
  setActivePinia(createPinia());
  const store = useAppStore();
  store.load();
  return { store, writes };
}

/* ==================== schema ==================== */

test('CangxuanConfigSchema：manual_meta 默认空数组，只接受字符串 URL', () => {
  const cfg = CangxuanConfigSchema.parse({});
  assert.deepEqual(cfg.manual_meta, [], '默认空数组（老数据零字段也能跑）');
  assert.equal(cfg.gallery, 'chat');
  assert.equal(cfg.meta_rule, '');

  // 存 URL：过
  assert.deepEqual(CangxuanConfigSchema.parse({ manual_meta: [REAL_URL] }).manual_meta, [REAL_URL]);

  // 非字符串（比如手滑塞了对象 / base64 数组）被 schema 挡住
  assert.equal(CangxuanConfigSchema.safeParse({ manual_meta: [{ url: REAL_URL }] }).success, false);
  assert.equal(CangxuanConfigSchema.safeParse({ manual_meta: 123 }).success, false);

  // 插件的设置里**不该**有 enabled（开关在 plugin_state）
  assert.equal('enabled' in cfg, false, '开关不在这份 schema 里');
});

test('RootDataSchema.parse({}) 带出 plugins.cangxuan 的完整默认（老数据零迁移）', () => {
  const data = RootDataSchema.parse({});
  assert.deepEqual(data.plugins.cangxuan, { gallery: 'chat', meta_rule: '', manual_meta: [] });
  assert.equal(DATA_VERSION, 5, '阶段 3 只加字段不涨版本（结构没搬）');
  assert.equal('enabled' in data.plugins.cangxuan, false);
});

/* ==================== 落盘往返 ==================== */

test('manual_meta 落盘往返：store 写入 → save(true) → 读回来一模一样（刷新不丢）', () => {
  const { store, writes } = freshStore();

  // 老坑的复现条件：写进内存
  assert.deepEqual(store.pluginConfig('cangxuan').manual_meta, [], '一进来是空的');

  store.setPluginConfig('cangxuan', { manual_meta: ['潮听澜:' + REAL_URL] });
  store.save(true);

  const last = writes[writes.length - 1][GLOBAL_KEY];
  assert.deepEqual(last.plugins.cangxuan.manual_meta, ['潮听澜:' + REAL_URL], '落盘了');

  // 模拟整页刷新：拿刚落盘的 JSON 重新走读入口
  const reloaded = recoverRootData(JSON.parse(JSON.stringify(last)));
  assert.deepEqual(reloaded.data.plugins.cangxuan.manual_meta, ['潮听澜:' + REAL_URL], '刷新后还在（这才是修掉的老坑）');
  assert.equal(reloaded.data.plugins.cangxuan.gallery, 'chat', '同一段里其它字段不丢');
});

test('manual_meta 只存 URL：写进去的字符串里不许出现 base64 / dataURL（撑爆 settings.json 的老路）', () => {
  const { store, writes } = freshStore();

  store.setPluginConfig('cangxuan', { manual_meta: [REAL_URL] });
  store.save(true);

  const saved = writes[writes.length - 1][GLOBAL_KEY];
  const serialized = JSON.stringify(saved.plugins.cangxuan);

  assert.equal(serialized.includes('data:image/'), false, '变量里不许出现 dataURL');
  assert.equal(serialized.includes(PNG_BASE64), false, '变量里不许出现 base64 正文');
  assert.ok(serialized.includes(REAL_URL), '存的必须是路径字符串');

  // 直接塞一份 dataURL 进 manual_meta：schema 放行（它是字符串），
  // 但**体积**是要防的 —— 所以真正落盘的那份必须小到不可能装下一张图。
  assert.ok(serialized.length < 2000, '这段设置体积必须是几十字节级，不能是几十 KB（一张图的 base64 就是几十 KB）');

  // 反证：真的把图当 base64 存进去会长什么样 —— 这就是要避免的量级
  const base64AsStored = DATA_URL.replace('data:image/png;base64,', '');
  // 这是**最小的** 1×1 PNG（真实立绘的 base64 是几十万字符）；这里只证明「量级完全不同」
  assert.ok(base64AsStored.length > 50, '一张最小 PNG 的 base64 也有几十字符；真实立绘是几十万');
  assert.equal(serialized.includes(base64AsStored), false, '上面那份落盘数据里没有它');
});

test('manual_meta 往返：导出 → 导入一份完整数据，这段设置一字不差', () => {
  const { store } = freshStore();
  const entries = ['潮听澜:' + REAL_URL, '江念:/user/images/cx-assets/jn.png'];
  store.setPluginConfig('cangxuan', { manual_meta: entries, meta_rule: 'json:char_captions' });
  store.save(true);

  const exported = JSON.stringify(store.data);
  const imported = importAll(exported);
  assert.equal(imported.ok, true, imported.error);
  assert.deepEqual(imported.data.plugins.cangxuan.manual_meta, entries, '导入导出往返一字不差');
  assert.equal(imported.data.plugins.cangxuan.meta_rule, 'json:char_captions');
});

test('resetPluginConfig(cangxuan) 清设置：manual_meta 回空，但**不动**插件开关', () => {
  const { store, writes } = freshStore();
  store.setPluginConfig('cangxuan', { manual_meta: [REAL_URL] });
  assert.equal(store.pluginEnabled('cangxuan'), true);

  store.resetPluginConfig('cangxuan');
  assert.deepEqual(store.pluginConfig('cangxuan').manual_meta ?? [], [], '设置回默认');
  assert.equal(store.pluginEnabled('cangxuan'), true, 'reset 只清设置，开关是底座的');

  store.save(true);
  const last = writes[writes.length - 1][GLOBAL_KEY];
  assert.deepEqual(last.plugins.cangxuan.manual_meta ?? [], []);
});

test('manual_meta 与开关互不干扰：关掉苍玄助手，设置照旧留着（重开还在）', () => {
  const { store, writes } = freshStore();
  store.setPluginConfig('cangxuan', { manual_meta: [REAL_URL] });
  store.setPluginEnabled('cangxuan', false);
  store.save(true);

  const saved = writes[writes.length - 1][GLOBAL_KEY];
  assert.deepEqual(saved.plugin_state.cangxuan, { enabled: false }, '开关落盘');
  assert.deepEqual(saved.plugins.cangxuan.manual_meta, [REAL_URL], '关插件不回收它自己的设置');

  const reloaded = recoverRootData(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.data.plugin_state.cangxuan.enabled, false, '刷新后仍是关着的');
  assert.deepEqual(reloaded.data.plugins.cangxuan.manual_meta, [REAL_URL], '设置也还在');
});

test('v4 老数据（plugins.cangxuan 不存在）读进来：补默认，不炸、不报警', () => {
  const old = {
    version: 4,
    plugins: { image: { enabled: true, api_key: 'k' } },
  };
  const result = recoverRootData(old);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.data.plugins.cangxuan, { gallery: 'chat', meta_rule: '', manual_meta: [] }, '缺块补默认');
  assert.equal(result.data.plugin_state.image.enabled, true, 'v4→v5 的搬家照旧');

  // 老数据里 cangxuan 段已经有半截字段：好字段保留，缺的补默认
  const partial = recoverRootData({ version: 5, plugins: { cangxuan: { manual_meta: ['角色:' + REAL_URL] } } });
  assert.equal(partial.data.plugins.cangxuan.gallery, 'chat', '缺的字段补默认');
  assert.deepEqual(partial.data.plugins.cangxuan.manual_meta, ['角色:' + REAL_URL], '有的字段一个字不丢');
});

test('defaultRootData：cangxuan 段默认值齐全（不靠 parse 兜）', () => {
  const data = defaultRootData();
  assert.ok(data.plugins.cangxuan, '默认数据里要有 cangxuan 段');
  assert.deepEqual(data.plugins.cangxuan.manual_meta, []);
});

/* ==================== 源码级：落盘链路不许走 base64 ==================== */

test('源码级：manual_meta 的 schema 是字符串数组（URL / 路径），不是对象、不是二进制', () => {
  const raw = readFileSync(new URL('../../src/苍玄助手/core/types.ts', import.meta.url), 'utf8');
  // schema 本体看剥掉注释的代码
  assert.match(
    codeOnly(raw),
    /manual_meta:\s*z\.array\(z\.string\(\)\)/,
    'manual_meta 必须是 z.array(z.string()) —— 只放路径字符串',
  );
  // 口径看**注释原文**（注释里才写得出「为什么不许存 base64」这件事）
  assert.match(raw, /不存 base64/, 'schema 注释里要写清「只存 URL、不存 base64」的口径');
});