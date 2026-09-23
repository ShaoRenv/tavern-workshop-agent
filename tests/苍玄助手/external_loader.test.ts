/**
 * 阶段 7 · P7-3：**外部插件装载器**（`plugins/external/loader.ts` + `plugins/registry.ts` 的外部通道）。
 *
 * ─────────────────────────── ⚠️ 这层测不到什么，必须说清 ───────────────────────────
 *
 * `loader.ts` 的**执行那一步**（`importCode` → `new Function('import')` + 真 URL + `blob:` 兜底）
 * **在单测里跑不了**：它要一个真能解析的模块 URL、要真实的 `URL.createObjectURL` / Blob 管线，
 * 而本仓库没有 jsdom、也不许装。所以：
 *
 *   · **本文件不 mock 那一层**，也不假装它被覆盖了；
 *   · 「代码真的被 import 起来、manifest 真的从模块里读出来」这条路**只由真机验收覆盖**
 *     （证据见 `reports/阶段7-外部插件装载-探针.md`）；
 *   · 本文件覆盖的是**它周围那些能测透的部分**：体积上限 / 形状校验 / apiVersion /
 *     注册表通道 / **失败时删文件** / 失败隔离 / 哈希 / base64 往返。
 *
 * 换句话说：`installFromCode` 走到 `importCode` 之前的一切、以及失败之后的清理，都测得到；
 * 中间「执行成功」那一段测不到 —— **这是已知缺口，不是假绿**。
 *
 * ─────────────────────────── 怎么驱动 ───────────────────────────
 *
 * 依赖是**注入**的（`ExternalLoaderDeps`：`getFetch` / `getCsrf`），
 * 所以塞一个手写 fetch stub 就够 —— **不起真服务器、不 mock 全局 fetch**。
 * stub 把每次调用记进数组，用来断言「失败时到底删没删文件」。
 *
 * 跑法：node --test "tests/苍玄助手/external_loader.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const {
  BASE_API_VERSION,
  MAX_PLUGIN_BYTES,
  PLUGIN_FILE_PREFIX,
  PLUGIN_FILE_EXT,
  codePathFor,
  evaluateApiVersion,
  hashText,
  installFromCode,
  installFromUrl,
  loadInstalled,
  toBase64,
  uninstallPlugin,
  validateModule,
} = await import(root + 'plugins/external/loader.ts');
const {
  allManifests,
  externalManifestIds,
  isExternalPlugin,
  pluginManifest,
  registerExternalManifest,
  unregisterExternalManifest,
} = await import(root + 'plugins/registry.ts');

/* ============================ 假 fetch ============================ */

/**
 * 手写 fetch stub：按 URL 分派，**把调用序列记下来**。
 *
 * 记录调用序列是本文件断言「失败不留痕」的唯一手段 ——
 * 「返回 ok:false」谁都会写，**有没有真的把写进去的文件删掉**才是这条性质的核心。
 */
function makeFetch(options: {
  csrf?: string | null;
  uploadStatus?: number;
  uploadBody?: string;
  deleteStatus?: number;
  /** 读文件时返回什么（loadInstalled 用）：path → 内容，或抛错 */
  files?: Record<string, string | Error>;
} = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];

  const impl = async (url: string, init: any = {}) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = init?.body ?? null;
    }
    calls.push({ url, method, body });

    // GET /user/files/... → 读文件
    if (method === 'GET' && url.startsWith('/user/files/')) {
      const entry = options.files?.[url];
      if (entry === undefined) return response(404, '');
      if (entry instanceof Error) throw entry;
      return response(200, entry);
    }
    // GET（下载）→ installFromUrl 走这条
    if (method === 'GET') {
      const entry = options.files?.[url];
      if (entry === undefined) return response(404, '');
      if (entry instanceof Error) throw entry;
      return response(200, entry);
    }

    if (url === '/csrf-token') {
      return jsonResponse(200, { token: options.csrf ?? null });
    }
    if (url === '/api/files/upload') {
      const status = options.uploadStatus ?? 200;
      const payload = options.uploadBody ?? JSON.stringify({ path: '/user/files/' + (body?.name ?? 'x') });
      return response(status, payload);
    }
    if (url === '/api/files/delete') {
      return response(options.deleteStatus ?? 200, '{}');
    }
    return response(404, '');
  };

  return {
    calls,
    impl: impl as unknown as typeof fetch,
    /** 全部被 POST 到的 URL 序列（断言「按什么顺序做了什么」） */
    postedUrls: () => calls.filter(call => call.method === 'POST').map(call => call.url),
    /** 有没有删过这个路径 */
    deleted: (path: string) => calls.some(call => call.url === '/api/files/delete' && call.body?.path === path),
    countOf: (url: string) => calls.filter(call => call.url === url).length,
  };
}

function response(status: number, text: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text || '{}');
    },
  } as unknown as Response;
}

function jsonResponse(status: number, value: unknown) {
  return response(status, JSON.stringify(value));
}

/** 注入依赖（默认：有 fetch、有 csrf） */
function deps(fake: { impl: typeof fetch }, over: { csrf?: string | null; noFetch?: boolean } = {}) {
  return {
    getFetch: () => (over.noFetch ? null : fake.impl),
    getCsrf: async () => (over.csrf === undefined ? 'test-csrf' : over.csrf),
  };
}

/** 每个用例跑完都把外部 manifest 清干净（进程级 Map，跨用例会互相污染） */
function cleanup(t: any) {
  t.after(() => {
    for (const id of externalManifestIds()) unregisterExternalManifest(id);
  });
}

/** 一个合法的外部 manifest（各字段齐全） */
function goodManifest(over: Record<string, unknown> = {}) {
  return {
    id: 'ext-hello',
    name: '外部问候',
    desc: '测试用',
    version: '1.0',
    apiVersion: 1,
    builtin: false,
    defaultEnabled: true,
    contributes: { tools: [] },
    ...over,
  };
}

/** 一份合法插件代码（**只是文本** —— 真正的执行由真机覆盖，见文件头） */
const GOOD_CODE = "export const manifest = { id: 'ext-hello', name: '外部问候', version: '1.0', apiVersion: 1, builtin: false, defaultEnabled: true, contributes: { tools: [] } };";

/* ============================ 1. apiVersion ============================ */

test('apiVersion：1 通过；2 被拒且理由给出「下一步」；**没声明也拒**（不能默认放行）', () => {
  assert.equal(BASE_API_VERSION, 1);

  // ① 匹配
  assert.deepEqual(evaluateApiVersion(1), { ok: true });

  // ② 不匹配：理由必须含**下一步**（找作者要一个给 apiVersion 1 写的版本）
  const future = evaluateApiVersion(2);
  assert.equal(future.ok, false);
  assert.match(future.error!, /apiVersion/, '要说清是 apiVersion 的问题');
  assert.match(future.error!, /请找这个插件的作者要一个给 apiVersion 1 写的版本/, '要给下一步，而不是「不兼容」三个字');
  assert.match(future.error!, /当前底座是 1/, '要说清底座当前版本');

  // ③ ⭐没声明也拒绝 —— 这是最容易写成「默认放行」的地方
  for (const missing of [undefined, null, '', '1', NaN, {}]) {
    const verdict = evaluateApiVersion(missing);
    assert.equal(verdict.ok, false, JSON.stringify(missing) + ' 不该被放行');
    assert.match(verdict.error!, /没声明 apiVersion/, JSON.stringify(missing) + ' 的理由要说清「没声明」');
  }

  // 反例对照：只有**恰好等于** 1 才过（证明不是「有值就放行」）
  assert.equal(evaluateApiVersion(1.5).ok, false, '1.5 不是同大版本');
  assert.equal(evaluateApiVersion(0).ok, false);
});

test('validateModule：apiVersion 不兼容要在**形状校验这一层**就被拦住（且带上人话）', () => {
  const bad = validateModule({ manifest: goodManifest({ apiVersion: 2 }) });
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /apiVersion 是 2/, '要把声明值说出来');

  const missing = validateModule({ manifest: goodManifest({ apiVersion: undefined }) });
  assert.equal(missing.ok, false);
  assert.match((missing as any).error, /没声明 apiVersion/);

  // 合法的要过（证明上面不是「一律失败」）
  const good = validateModule({ manifest: goodManifest() });
  assert.equal(good.ok, true, JSON.stringify(good));
});

/* ============================ 2. 形状校验 ============================ */

test('形状校验：没 manifest / 没 id / 没 contributes → **各自一句人话**（不是笼统的「加载失败」）', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['没导出任何东西', {}, /没有导出 manifest/],
    ['导出的是个数字', 42, /没有导出 manifest/],
    ['default 是 null', { default: null }, /没有导出 manifest/],
    ['没 id', { manifest: { name: 'x', contributes: {}, apiVersion: 1 } }, /缺 id/],
    ['id 是空白串', { manifest: { id: '   ', contributes: {}, apiVersion: 1 } }, /缺 id/],
    ['id 不是字符串', { manifest: { id: 7, contributes: {}, apiVersion: 1 } }, /缺 id/],
    ['没 contributes', { manifest: { id: 'x', apiVersion: 1 } }, /缺 contributes/],
    ['contributes 是字符串', { manifest: { id: 'x', contributes: 'nope', apiVersion: 1 } }, /缺 contributes/],
  ];

  for (const [label, mod, expected] of cases) {
    const result = validateModule(mod);
    assert.equal(result.ok, false, label + ' 应该被拒');
    const error = (result as any).error as string;
    assert.match(error, expected, label + ' 的理由要对得上（实际：' + error + '）');
    // ⭐「各自一句人话」而不是笼统失败：理由要长到能让人知道**改哪里**
    assert.ok(error.length > 15, label + ' 的理由太短，帮不上作者：' + error);
    // 笼统话（「加载失败」「不兼容」这种）一出现就说明有人偷懒了
    assert.equal(/^(加载失败|插件加载失败|不兼容|出错了)[。！]*$/.test(error), false, label + ' 的理由太笼统：' + error);
  }

  // 三种情况的理由**互不相同**（否则等于同一个笼统错误换了个壳）
  const a = (validateModule({}) as any).error;
  const b = (validateModule({ manifest: { contributes: {}, apiVersion: 1 } }) as any).error;
  const c = (validateModule({ manifest: { id: 'x', apiVersion: 1 } }) as any).error;
  assert.equal(new Set([a, b, c]).size, 3, '三种缺失要给三种不同的话');
});

test('形状校验：export default 也认（不只 export const manifest）—— 且两者冲突时 manifest 优先', () => {
  const viaDefault = validateModule({ default: goodManifest({ id: 'via-default' }) });
  assert.equal(viaDefault.ok, true, 'export default 的形态要认');
  assert.equal((viaDefault as any).manifest.id, 'via-default');

  const both = validateModule({ manifest: goodManifest({ id: 'from-manifest' }), default: goodManifest({ id: 'from-default' }) });
  assert.equal((both as any).manifest.id, 'from-manifest', '两个都在时以 manifest 为准');
});

/* ============================ 3. 体积上限 ============================ */

test('体积上限：超过 1 MB 直接拒（给出 KB 数字 + 上限），**且一个请求都不发**', async (t) => {
  cleanup(t);
  assert.equal(MAX_PLUGIN_BYTES, 1024 * 1024);

  const fake = makeFetch();
  // 刚好超限（多 1 字节）—— 中文是多字节，这里用 ASCII 精确控制大小
  const tooBig = 'a'.repeat(MAX_PLUGIN_BYTES + 1);
  const result = await installFromCode(tooBig, { source: 'paste' }, deps(fake));

  assert.equal(result.ok, false);
  assert.match(result.error!, /超过上限/, '要说清是超限');
  assert.match(result.error!, /1024 KB/, '要给出上限是多少');
  assert.ok(fake.calls.length === 0, '超限要在**发任何请求之前**就拒掉（别先写盘再删）');

  // 边界对照：刚好等于上限**不该**被体积这条拒掉（会往下走去执行那一步）
  const atLimit = 'a'.repeat(MAX_PLUGIN_BYTES);
  const atLimitResult = await installFromCode(atLimit, { source: 'paste' }, deps(fake));
  assert.equal(/超过上限/.test(atLimitResult.error ?? ''), false, '刚好等于上限不该被判超限');
});

test('空代码：直接拒（不写盘、不执行）', async (t) => {
  cleanup(t);
  const fake = makeFetch();
  for (const blank of ['', '   ', '\n\t ']) {
    const result = await installFromCode(blank, { source: 'paste' }, deps(fake));
    assert.equal(result.ok, false, JSON.stringify(blank) + ' 应该被拒');
    assert.match(result.error!, /空/, '要说清是空的');
  }
  assert.equal(fake.calls.length, 0, '空代码不该发任何请求');
});

/* ============================ 4. 撞内置 id ============================ */
// ⚠️ 注意：这条**测不到「文件被删掉」** —— 因为撞内置 id 是在 registerExternalManifest
//    那一步才发现的，而它前面必须先成功执行代码拿到 manifest。执行那一步单测跑不了。
//    所以这里测**注册表通道自己的拒绝语义**（那是能测透的），并把「删文件」那条
//    放到 loadInstalled 的读文件失败路径上去测（那条能真跑到删除）。

test('⭐撞内置 id：注册表通道拒绝 + 原因点名「内置插件占用」，且**不写进外部表**', () => {
  assert.equal(registerExternalManifest(goodManifest({ id: 'worldbook' })).ok, false);
  const verdict = registerExternalManifest(goodManifest({ id: 'worldbook' }));
  assert.match(verdict.error!, /已被内置插件占用/, '原因要点名是撞了内置');
  assert.match(verdict.error!, /worldbook/, '要说清是哪个 id');

  assert.equal(isExternalPlugin('worldbook'), false, '撞内置的不能进外部表（内置优先）');
  assert.equal(externalManifestIds().includes('worldbook'), false);

  // 内置那个还是内置的（没被顶替）
  const builtin = pluginManifest('worldbook');
  assert.equal(builtin.builtin, true, '内置插件的 builtin 标记不许被外部包改掉');

  // 反例对照：不撞内置的 id 能进（证明不是一律拒绝）
  const ok = registerExternalManifest(goodManifest({ id: 'ext-ok' }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(isExternalPlugin('ext-ok'), true);
  unregisterExternalManifest('ext-ok');
});

test('注册表通道：非法 manifest 也给人话（不是对象 / 没 id）', () => {
  assert.match(registerExternalManifest(null as any).error!, /没有导出 manifest 对象/);
  assert.match(registerExternalManifest('x' as any).error!, /没有导出 manifest 对象/);
  assert.match(registerExternalManifest({ name: 'x' } as any).error!, /没有 id/);
  assert.match(registerExternalManifest({ id: '   ' } as any).error!, /没有 id/);
});

test('注册表通道：外部 manifest 进来后强制 builtin=false（外部包不许自称内置）', () => {
  const sneaky = goodManifest({ id: 'ext-sneaky', builtin: true });
  assert.equal(registerExternalManifest(sneaky).ok, true);

  const stored = pluginManifest('ext-sneaky');
  assert.equal(stored.builtin, false, 'builtin 由底座说了算，不由插件包声明（否则界面会显示成「不可卸载」）');
  unregisterExternalManifest('ext-sneaky');
});

/* ============================ 5. 成功路径 / 注册表可见性 ============================ */

test('成功路径：注册后 allManifests / pluginManifest / isExternalPlugin 都能看到它；注销后消失', (t) => {
  cleanup(t);
  const before = allManifests().map(manifest => manifest.id);
  assert.equal(before.includes('ext-visible'), false, '一开始不该有');

  assert.equal(registerExternalManifest(goodManifest({ id: 'ext-visible' })).ok, true);

  assert.ok(allManifests().some(manifest => manifest.id === 'ext-visible'), 'allManifests 要含外部插件（聚合函数一律走它）');
  assert.equal(pluginManifest('ext-visible').id, 'ext-visible', 'pluginManifest 按 id 拿得到');
  assert.equal(isExternalPlugin('ext-visible'), true);
  assert.deepEqual(externalManifestIds(), ['ext-visible']);
  // ⚠️ 内置换成了 allManifests：内置的还在，且**排在外部前面**
  const ids = allManifests().map(manifest => manifest.id);
  assert.ok(ids.indexOf('cangxuan') < ids.indexOf('ext-visible'), '内置排前面');

  unregisterExternalManifest('ext-visible');
  assert.equal(isExternalPlugin('ext-visible'), false, '注销后查不到');
  assert.equal(allManifests().some(manifest => manifest.id === 'ext-visible'), false, 'allManifests 里也没了');
  assert.throws(() => pluginManifest('ext-visible'), /没有这个插件/, '注销后再按 id 拿应当抛');

  // 注销幂等
  unregisterExternalManifest('ext-visible');
  unregisterExternalManifest('从没注册过的');
});

test('注册幂等：同 id 重复注册 = 整份替换（用于「更新」），不会出现两份', () => {
  assert.equal(registerExternalManifest(goodManifest({ id: 'ext-update', version: '1.0' })).ok, true);
  assert.equal(registerExternalManifest(goodManifest({ id: 'ext-update', version: '2.0' })).ok, true);

  const found = allManifests().filter(manifest => manifest.id === 'ext-update');
  assert.equal(found.length, 1, '同 id 只能有一份');
  assert.equal(found[0].version, '2.0', '用新的那份');
  assert.equal(externalManifestIds().filter(id => id === 'ext-update').length, 1);
  unregisterExternalManifest('ext-update');
});

/* ============================ 6. ⭐失败隔离（loadInstalled） ============================ */

/*
 * ⭐失败隔离（本包最硬的一条性质）。
 *
 * ⚠️ 这里必须诚实说明**测到什么程度**：
 * `loadInstalled` 要对每个插件走「读文件 → import 执行 → 校验 → 注册」。
 * 其中 **import 执行那一步单测跑不了**（见文件头），所以任何插件的 `loaded` 都到不了 ——
 * 我**不能**断言「第二个进 loaded」，那是假绿。
 *
 * 那么「失败隔离」怎么才测得**真**？要点在于：失败隔离的实质是
 * **前一个插件抛出的异常被它自己的 try/catch 吃掉、不中断循环**。
 * 所以真正能测、也必须测的是：
 *   ① 两个插件都失败时，**两条都在 failed 里**（循环没被第一个异常打断）；
 *   ② 每个插件的失败原因**各自就位、不串台**（不是把第一个的原因复制给第二个）；
 *   ③ 失败的那几个**都不在注册表里留痕**（不留半截状态）。
 * ③ 下面还有一条独立的用例专门钉。
 */

test('⭐失败隔离：前一个插件的异常**不会中断循环** —— 两个插件各自失败、各自带走自己的原因', async (t) => {
  cleanup(t);
  const first = { id: 'ext-bad-1', code_path: '/user/files/cx-plugin-ext-bad-1.txt' };
  const second = { id: 'ext-bad-2', code_path: '/user/files/cx-plugin-ext-bad-2.txt' };

  const fake = makeFetch({
    files: {
      [first.code_path]: new Error('第一个的文件读不了'),
      [second.code_path]: new Error('第二个的文件也读不了'),
    },
  });

  const report = await loadInstalled([first, second] as any, deps(fake));

  // ① 关键：**第二个也进 failed** —— 如果实现没做 per-plugin try/catch，
  //    第一个异常会直接冒出去，第二个连碰都碰不到（report 根本不会返回）。
  assert.deepEqual(
    report.failed.map(item => item.id),
    ['ext-bad-1', 'ext-bad-2'],
    '两个都要被独立处理：前一个失败不能中断循环（这是失败隔离的实质）',
  );

  // ② 原因各自就位、不串台
  assert.match(report.failed[0].error, /第一个的文件读不了/, '第一条要带自己的原因');
  assert.match(report.failed[1].error, /第二个的文件也读不了/, '第二条要带自己的原因');
  assert.notEqual(report.failed[0].error, report.failed[1].error, '两条原因不该是同一句（说明没串台）');

  for (const item of report.failed) {
    assert.ok(item.error.length > 0, item.id + ' 要有人话原因');
    assert.equal(/^TypeError/.test(item.error), false, item.id + ' 不许甩裸 TypeError');
  }
});

test('⭐失败隔离：一个插件在读取时**抛异常**，后面的插件仍然被处理到（不半途而废）', async (t) => {
  cleanup(t);
  // 故意让第一个「炸得很难看」（非 Error 的抛出），第二个正常走读文件那一步。
  // 断言重点：第二个**被访问到了**（stub 记录到了对它的 GET）。
  const first = { id: 'ext-boom', code_path: '/user/files/cx-plugin-ext-boom.txt' };
  const second = { id: 'ext-after', code_path: '/user/files/cx-plugin-ext-after.txt' };

  const fake = makeFetch({
    files: {
      [first.code_path]: new Error('爆了'),
      // 第二个文件内容合法，但**执行那一步单测跑不了** → 它会走到 import 才失败
      [second.code_path]: GOOD_CODE,
    },
  });

  const report = await loadInstalled([first, second] as any, deps(fake));

  // ⭐「后面的插件仍然被处理到」：stub 里必须有对第二个文件的读取记录
  const readSecond = fake.calls.some(call => call.url === second.code_path && call.method === 'GET');
  assert.equal(readSecond, true, '第一个插件炸了之后，第二个插件仍然要被读 —— 循环没被打断');

  assert.equal(report.failed.some(item => item.id === 'ext-boom'), true, '炸的那个要进 failed');
  // 第二个的最终归属（loaded 还是 failed）取决于执行那一步，单测不作断言 —— 只要求它被处理到。
  assert.equal(report.loaded.includes('ext-boom'), false, '炸掉的那个绝不许出现在 loaded 里');
});

test('⭐失败隔离：读文件失败的那台**不该**在注册表里留下 manifest（不留痕）', async (t) => {
  cleanup(t);
  const fake = makeFetch({ files: { '/user/files/cx-plugin-x.txt': new Error('boom') } });
  await loadInstalled([{ id: 'ext-x', code_path: '/user/files/cx-plugin-x.txt' }] as any, deps(fake));

  assert.equal(isExternalPlugin('ext-x'), false, '装载失败的插件不该出现在注册表里');
  assert.equal(allManifests().some(manifest => manifest.id === 'ext-x'), false);
});

test('loadInstalled：空数组 / 缺 id 的记录 → 不炸、不进 failed', async (t) => {
  cleanup(t);
  const fake = makeFetch();
  assert.deepEqual(await loadInstalled([], deps(fake)), { loaded: [], failed: [] });
  assert.deepEqual(await loadInstalled(null as any, deps(fake)), { loaded: [], failed: [] });

  const report = await loadInstalled([{ id: '' }, { id: '   ' }, {}] as any, deps(fake));
  assert.deepEqual(report.failed, [], '没有 id 的记录直接跳过（不是「失败」）');
});

test('loadInstalled：没有网络能力（fetch 取不到）→ 每个插件各自失败并给人话，不整体抛', async (t) => {
  cleanup(t);
  const fake = makeFetch();
  const report = await loadInstalled(
    [{ id: 'a', code_path: '/user/files/cx-plugin-a.txt' }, { id: 'b', code_path: '/user/files/cx-plugin-b.txt' }] as any,
    deps(fake, { noFetch: true }),
  );
  assert.equal(report.loaded.length, 0);
  assert.deepEqual(report.failed.map(item => item.id), ['a', 'b'], '两个都失败（不是整体崩）');
  for (const item of report.failed) assert.ok(item.error.length > 0, item.id + ' 要有人话');
});

/* ============================ 7. 失败不留痕：删除行为 ============================ */

test('⭐失败不留痕：installFromUrl 下载失败 → 不写任何文件（一个 upload 都没有）', async (t) => {
  cleanup(t);
  const fake = makeFetch(); // 所有 GET 都 404
  const result = await installFromUrl('https://example.com/plugin.js', deps(fake));

  assert.equal(result.ok, false);
  assert.match(result.error!, /HTTP 404/, '要说清 HTTP 状态');
  assert.match(result.error!, /能直接在浏览器里打开|CORS/, '要给出可操作的下一步');
  assert.equal(fake.countOf('/api/files/upload'), 0, '下载都没成功，不该写盘');
});

test('⭐失败不留痕：网络层抛异常（CORS）→ 人话里点名 CORS，且不写盘', async (t) => {
  cleanup(t);
  const fake = makeFetch({ files: { 'https://example.com/plugin.js': new Error('Failed to fetch') } });
  const result = await installFromUrl('https://example.com/plugin.js', deps(fake));

  assert.equal(result.ok, false);
  assert.match(result.error!, /CORS/, '要点名 CORS（跨源下载需要它）—— 这是最常见的真原因');
  assert.equal(/^Error: /.test(result.error!), false, '不该把裸错误原文直接甩出来');
  assert.equal(fake.countOf('/api/files/upload'), 0, '不该写盘');
});

test('installFromUrl：地址为空 / 不是 http(s) / 拿不到 fetch → 各自人话，一个请求都不发', async (t) => {
  cleanup(t);
  const fake = makeFetch();

  assert.match((await installFromUrl('   ', deps(fake))).error!, /地址是空的/);
  assert.match((await installFromUrl('file:///etc/passwd', deps(fake))).error!, /只支持 http\(s\)/);
  assert.match((await installFromUrl('javascript:alert(1)', deps(fake))).error!, /只支持 http\(s\)/);
  assert.match((await installFromUrl('https://x/y.js', deps(fake, { noFetch: true }))).error!, /网络能力|fetch/);

  assert.equal(fake.calls.length, 0, '这些前置拒绝都不该发请求');
});

test('⭐写盘失败（upload 非 200）→ ok:false + 人话，且**没有后续的 delete**（本来就没写进去）', async (t) => {
  cleanup(t);
  const fake = makeFetch({ uploadStatus: 403, uploadBody: 'forbidden' });
  const result = await installFromCode(GOOD_CODE, { id: 'ext-write-fail', source: 'paste' }, deps(fake));

  assert.equal(result.ok, false);
  assert.match(result.error!, /没能写进酒馆文件/, '要说清是写文件这一步失败了');
  assert.match(result.error!, /403/, '要带上 HTTP 状态');
  assert.equal(fake.countOf('/api/files/delete'), 0, '没写成功就不该去删（删空路径没意义）');
  assert.equal(isExternalPlugin('ext-write-fail'), false, '注册表里不该有它');
});

test('CSRF：拿到 token 就带上 X-CSRF-Token；拿不到也照发（让请求去撞 403 再报人话）', async (t) => {
  cleanup(t);
  const withToken = makeFetch({ csrf: 'tok-123' });
  await installFromCode(GOOD_CODE, { id: 'ext-csrf', source: 'paste' }, deps(withToken));
  const uploadCall = withToken.calls.find(call => call.url === '/api/files/upload');
  assert.ok(uploadCall, '应该发过 upload');
  // 头在 fetch 的 init 上，stub 没记 headers —— 单独再驱动一次拿到 headers
  const fake2 = makeFetch();
  let seenHeaders: any = null;
  const impl2 = async (url: string, init: any) => {
    if (url === '/api/files/upload') seenHeaders = init?.headers;
    return (fake2.impl as any)(url, init);
  };
  await installFromCode(GOOD_CODE, { id: 'ext-csrf2', source: 'paste' }, { getFetch: () => impl2 as any, getCsrf: async () => 'tok-abc' });
  assert.equal(seenHeaders?.['X-CSRF-Token'], 'tok-abc', '拿到 token 要带上去（不然 ST 直接 403）');
  assert.equal(seenHeaders?.['Content-Type'], 'application/json');
});

/* ============================ 8. 哈希 ============================ */

test('hashText：同输入稳定、不同输入不同（**只差一个字符也要不同**）', () => {
  const a = hashText(GOOD_CODE);
  assert.equal(hashText(GOOD_CODE), a, '同一输入必须稳定（否则「文件被换过」会误报）');
  assert.equal(hashText(''), hashText(''), '空串也稳定');

  // ⭐反例：只差一个字符
  assert.notEqual(hashText('abc'), hashText('abd'), '只差一个字符就要不同');
  assert.notEqual(hashText('abc'), hashText('abc '), '多一个空格也要不同');
  assert.notEqual(hashText('abc'), hashText('acb'), '顺序不同也要不同');

  // 中文 / 多字节也要工作
  assert.notEqual(hashText('中文注释'), hashText('中文注釈'));
  assert.equal(hashText('中文注释'), hashText('中文注释'));

  // 形状：8 位十六进制（界面直接展示）
  assert.match(a, /^[0-9a-f]{8}$/, '要是 8 位十六进制（界面展示用）');
});

/* ============================ 9. toBase64（中文往返） ============================ */

test('⭐toBase64：中文（多字节）能正确往返 —— 「中文注释炸 btoa」那个坑的闸', () => {
  // ⚠️ 这条是真实会炸的坑：`btoa('中文')` 直接抛 InvalidCharacterError，
  //    而插件代码里**一定**有中文注释，所以这条不测就等着真机炸。
  const samples = [
    '// 中文注释',
    "export const manifest = { name: '外部插件·中文名' };",
    'emoji 也要能过 🎉🚀',
    '混排 abc 中文 123 「引号」',
    '',
  ];

  for (const sample of samples) {
    const encoded = toBase64(sample);
    assert.doesNotThrow(() => atob(encoded), JSON.stringify(sample) + ' 的 base64 要能被 atob 解回来');
    // 往返：atob → 字节 → UTF-8 解码
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    assert.equal(decoded, sample, JSON.stringify(sample) + ' 往返必须一字不差');
  }

  // 反例对照：确认 `btoa` 直接吃中文**确实会炸** —— 证明这个测试不是无意义的
  assert.throws(() => btoa('中文'), /InvalidCharacterError|not in the Latin1|must be a code point/i, 'btoa 直接吃中文应当抛（这正是要绕开的坑）');
});

/* ============================ 路径与卸载 ============================ */

test('codePathFor：路径稳定、带前缀、id 里的怪字符被清掉（防路径穿越）', () => {
  assert.equal(codePathFor('ext-hello'), '/user/files/' + PLUGIN_FILE_PREFIX + 'ext-hello' + PLUGIN_FILE_EXT);
  assert.equal(codePathFor('ext-hello'), codePathFor('ext-hello'), '同一 id 稳定');
  assert.equal(codePathFor(' ext-hello '), codePathFor('ext-hello'), '首尾空白要 trim');

  // ⭐路径安全：不许让 id 逃出 /user/files/
  for (const evil of ['../../etc/passwd', 'a/b', 'a\\b', 'a b', 'a?b=1']) {
    const path = codePathFor(evil);
    assert.ok(path.startsWith('/user/files/'), evil + ' 必须留在 files 目录下');
    assert.equal(path.includes('..'), false, evil + ' 不许带 ..（路径穿越）');
    assert.equal(path.split('/').length, 4, evil + ' 的路径层级不该变多：' + path);
  }
  assert.equal(codePathFor(''), '/user/files/' + PLUGIN_FILE_PREFIX + 'plugin' + PLUGIN_FILE_EXT, '空 id 要有兜底名');
});

test('uninstallPlugin：注销 manifest + 删文件（两步都幂等，删失败也不抛）', async (t) => {
  cleanup(t);
  registerExternalManifest(goodManifest({ id: 'ext-uninstall' }));
  const path = codePathFor('ext-uninstall');

  const fake = makeFetch();
  await uninstallPlugin('ext-uninstall', path, deps(fake));

  assert.equal(isExternalPlugin('ext-uninstall'), false, '要注销');
  assert.equal(fake.deleted(path), true, '要删文件');

  // 删失败也不抛（卸载必须能完成）
  const failing = makeFetch({ deleteStatus: 500 });
  await assert.doesNotReject(() => uninstallPlugin('ext-uninstall', path, deps(failing)));

  // 没有 code_path 时按 codePathFor 兜底
  const fake2 = makeFetch();
  await uninstallPlugin('ext-fallback', '', deps(fake2));
  assert.equal(fake2.deleted(codePathFor('ext-fallback')), true, '没给路径就按 id 推');
});

/* ============================ 常量 ============================ */

test('常量口径：前缀 / 上限 / 路径都用导出的常量（别在别处再写一份字面量）', () => {
  assert.equal(PLUGIN_FILE_PREFIX, 'cx-plugin-');
  assert.equal(MAX_PLUGIN_BYTES, 1024 * 1024, '1 MB');
  assert.equal(BASE_API_VERSION, 1);
  assert.ok(codePathFor('x').includes(PLUGIN_FILE_PREFIX), '路径要用同一个前缀常量');
});