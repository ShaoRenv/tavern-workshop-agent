/**
 * P0-C / task-14：原生 ST 适配器（core/native.ts）的契约测试。
 *
 * 要防的回归（reports/扩展迁移-宿主能力原生映射.md、扩展迁移-宏系统与设计约束.md）：
 *  1. 底座依赖的接口全部能从 SillyTavern.getContext() 原生取到 —— 不再依赖酒馆助手；
 *  2. **晚绑定**：getContext 晚就绪 / 热重载后，表里的 fn 必须取到**当前**实现，
 *     不许在建表时把函数引用固定住（这是扩展形态最容易写错的一条）；
 *  3. **宏注册是静默失败的**：参数名必须是 unnamedArgs；注册后必须自检，
 *     自检不过要回滚 + 报人话原因（不能留一个「看起来成功、实际永不替换」的宏）；
 *  4. **宏 handler 必须同步**：返回 Promise 必须被拒绝注册（官方文档 :916）；
 *  5. 宏名带 cx 前缀（ST 自带 131 个内置宏，裸名会撞车且静默失效）；
 *  6. installNativeAdapters(null) **不抛错**（扩展外壳顶层就会调，那时可能还没就绪）；
 *  7. getScriptTrees / getModelList / getScriptId **明确标不可用**（ST 原生没有对应）；
 *  8. 变量**读路径不许碰本地缓存**（多标签页会把空缓存伪装成「没数据」→ 数据丢失）。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const core = '../../src/苍玄助手/core/';
const native = await import(core + 'native.ts');
const {
  getStContext,
  isStReady,
  installNativeAdapters,
  probeNativeCapabilities,
  registerTavernMacro,
  unregisterTavernMacro,
  verifyMacroRegistered,
  assertSyncMacroResult,
  lookupMacro,
  withMacroPrefix,
  MACRO_PREFIX,
  NATIVE_PATHS,
  NO_NATIVE_EQUIVALENT,
  hasNoNativeEquivalent,
  stEntriesToArray,
  arrayToStEntries,
  normalizeWorldbookRead,
  normalizeWorldbookWrite,
} = native;

/* ============================ 测试脚手架 ============================ */

/**
 * 造一个假 ST 上下文。
 *
 * 刻意做得**像真的**：macros.registry 是 Map + registerMacro/unregisterMacro，
 * variables 是 local/global 两档六件套 —— 因为本文件的重点就是「按真形状接」。
 * 另外内置了 ST 宏注册的**静默失败**行为（参数名不对就只存 name 不存 unnamedArgs），
 * 好让自检那几条测试真的能验出东西来。
 */
function fakeSt(over = {}) {
  const macroTable = new Map();
  const globalVars = new Map();
  const localVars = new Map();
  const calls = [];

  const scope = (store, label) => ({
    get: key => store.get(key),
    set: (key, value) => {
      calls.push(['set', label, key]);
      store.set(key, value);
    },
    has: key => store.has(key),
    del: key => store.delete(key),
  });

  const ctx = {
    generateRaw: opts => {
      calls.push(['generateRaw', opts]);
      return Promise.resolve('RAW');
    },
    substituteParams: text => 'SUB(' + text + ')',
    macros: {
      register: (name, definition) => {
        calls.push(['macros.register', name, definition]);
        // 真 ST 的行为：只认 unnamedArgs，别的参数名一律忽略（静默失败）
        macroTable.set(name, {
          name,
          handler: definition.handler,
          description: definition.description,
          unnamedArgs: definition.unnamedArgs,
          // minArgs 是产物字段（MacroRegistry.js:137），不是入参
          minArgs: Array.isArray(definition.unnamedArgs) ? definition.unnamedArgs.length : 0,
        });
      },
      registry: {
        macros: macroTable,
        unregisterMacro: name => {
          calls.push(['macros.unregister', name]);
          macroTable.delete(name);
        },
      },
    },
    variables: { local: scope(localVars, 'local'), global: scope(globalVars, 'global') },
    loadWorldInfo: name => Promise.resolve({ name, entries: {} }),
    saveWorldInfo: (name, data) => Promise.resolve(true),
    getWorldInfoNames: () => ['甲世界', '乙世界'],
    updateWorldInfoList: () => Promise.resolve(),
    reloadWorldInfoEditor: () => {},
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'tok' }),
    executeSlashCommandsWithOptions: cmd => Promise.resolve(cmd),
    stopGenerationById: () => {},
    isToolCallingSupported: () => true,
    extensionSettings: { world_info: { globalSelect: ['乙世界'] } },
  };

  return { ctx: { ...ctx, ...over }, calls, macroTable, globalVars, localVars };
}

/** 把假 ST 挂到全局（并返回还原函数） */
function withSt(st, body) {
  const previous = globalThis.SillyTavern;
  globalThis.SillyTavern = { getContext: () => st };
  try {
    return body();
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
  }
}

/** 把假 ST 挂到全局，再清干净（异步版） */
async function withStAsync(st, body) {
  const previous = globalThis.SillyTavern;
  globalThis.SillyTavern = { getContext: () => st };
  try {
    return await body();
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
  }
}/* ============================ 1. 取上下文 / 就绪判定 ============================ */

test('getStContext: 没有 SillyTavern 时返回 null（不抛）', () => {
  const previous = globalThis.SillyTavern;
  delete globalThis.SillyTavern;
  try {
    assert.equal(getStContext(), null);
    assert.equal(isStReady(), false);
  } finally {
    if (previous !== undefined) globalThis.SillyTavern = previous;
  }
});

test('getStContext: SillyTavern.getContext 抛错时按「还没就绪」处理，不把异常放出去', () => {
  const previous = globalThis.SillyTavern;
  globalThis.SillyTavern = {
    getContext: () => {
      throw new Error('酒馆还没初始化');
    },
  };
  try {
    assert.equal(getStContext(), null, '抛错要吞掉返回 null —— 扩展外壳顶层就会调它，不能让扩展加载失败');
    assert.equal(isStReady(), false);
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
  }
});

test('getStContext: 兼容 getContext 直接是对象（少数包装层形态）', () => {
  const previous = globalThis.SillyTavern;
  const marker = { generateRaw: () => 'x' };
  globalThis.SillyTavern = { getContext: marker };
  try {
    assert.equal(getStContext(), marker);
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
  }
});

test('getStContext: 没有 SillyTavern 命名空间时认裸的全局 getContext', () => {
  const prevSt = globalThis.SillyTavern;
  const prevBare = globalThis.getContext;
  delete globalThis.SillyTavern;
  const marker = { substituteParams: t => t };
  globalThis.getContext = () => marker;
  try {
    assert.equal(getStContext(), marker);
  } finally {
    delete globalThis.getContext;
    if (prevSt !== undefined) globalThis.SillyTavern = prevSt;
    if (prevBare !== undefined) globalThis.getContext = prevBare;
  }
});

/* ==================== 2. installNativeAdapters：不抛 + 覆盖的接口名 ==================== */

test('installNativeAdapters(null) 返回空表且不抛（扩展外壳顶层就会调，那时可能还没就绪）', () => {
  const table = installNativeAdapters(null);
  assert.deepEqual(table, {});
});

test('installNativeAdapters: 假 ST 下覆盖 17 个宿主依赖里能原生对应的那些', () => {
  const { ctx } = fakeSt();
  const table = installNativeAdapters(ctx);
  const names = Object.keys(table);

  // 生成（文本通道主命脉）
  assert.ok(names.includes('generateRaw'), 'generateRaw 必须原生直通（名字都一样）');
  // 宏替换：底座用老名字 substitudeMacros 调，映射到原生 substituteParams（拼写差一个 t）
  assert.ok(names.includes('substitudeMacros'));
  assert.ok(names.includes('substituteParams'));
  // 宏注册 / 注销
  assert.ok(names.includes('registerMacroLike'));
  assert.ok(names.includes('unregisterMacroLike'));
  // 世界书
  for (const name of ['getWorldbook', 'replaceWorldbook', 'createWorldbook', 'getWorldbookNames', 'getGlobalWorldbookNames']) {
    assert.ok(names.includes(name), name + ' 应该由原生映射提供');
  }
  // 变量
  for (const name of ['getVariables', 'insertOrAssignVariables', 'replaceVariables', 'updateVariablesWith']) {
    assert.ok(names.includes(name), name + ' 应该由原生映射提供');
  }
  // 请求头 / 生成控制 / 工具调用探测
  assert.ok(names.includes('getRequestHeaders'), 'getRequestHeaders 原生自带 → 手写 CSRF 获取退役');
  assert.ok(names.includes('stopGenerationById'));
  assert.ok(names.includes('isToolCallingSupported'));
});

test('installNativeAdapters: 只放取得到的接口 —— 没有的键要缺席（让链继续往下找）', () => {
  const { ctx } = fakeSt();
  delete ctx.generateRaw;
  delete ctx.getRequestHeaders;
  const table = installNativeAdapters(ctx);
  assert.equal('generateRaw' in table, false, '取不到就不该放键，免得链在这一层拿个假实现');
  assert.equal('getRequestHeaders' in table, false);
});

test('installNativeAdapters: stopGenerationById 没有时回落旧名 stopGeneration', () => {
  const { ctx } = fakeSt();
  delete ctx.stopGenerationById;
  ctx.stopGeneration = () => 'stopped';
  // 必须挂到全局：表里的 fn 是**晚绑定**的，调用时从 getStContext() 重新解引用，
  // 不是就用建表时传进来的那个对象。（这条测试第一版就是忘了挂全局，反而验出了晚绑定是对的。）
  withSt(ctx, () => {
    const table = installNativeAdapters(ctx);
    assert.equal(typeof table.stopGenerationById, 'function', 'stopGenerationById 这个键要在');
    assert.equal(table.stopGenerationById(), 'stopped', '旧名 stopGeneration 要能兜住');
  });
});/* ============================ 3. 晚绑定（扩展形态最易写错的一条） ============================ */

test('晚绑定: 建表后换掉 ctx 实现，表里的 fn 要取到**新的**那个（不许 bind 住旧引用）', () => {
  const first = fakeSt();
  const previous = globalThis.SillyTavern;
  globalThis.SillyTavern = { getContext: () => first.ctx };
  try {
    const table = installNativeAdapters(first.ctx);
    assert.equal(table.substitudeMacros('甲'), 'SUB(甲)');

    // 模拟「热重载 / 酒馆换了实现」：全局换成另一个 ctx，原生行为不同
    globalThis.SillyTavern = { getContext: () => ({ generateRaw: () => 'v2', substituteParams: t => 'NEW(' + t + ')' }) };
    assert.equal(
      table.substitudeMacros('甲'),
      'NEW(甲)',
      '晚绑定失败：表里存的是旧 ctx 的函数引用 —— 热重载后会拿到旧实现',
    );
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
  }
});

test('晚绑定: 建表时 ctx 为空（还没就绪），等就绪后同一个 fn 要能工作', () => {
  const previous = globalThis.SillyTavern;
  delete globalThis.SillyTavern;
  try {
    // 外壳就是这么用的：顶层拿到 null 也会建表
    const table = installNativeAdapters(null);
    assert.deepEqual(table, {}, '还没就绪时是空表');

    // 现在酒馆就绪了 —— 但空表里没有键，这正说明「顶层 null 就建表」不够，
    // 必须靠「每次调用重新取」：新表才有键。这里验的是「真的没就绪就诚实为空」。
    globalThis.SillyTavern = { getContext: () => ({ generateRaw: () => 'x' }) };
    const later = installNativeAdapters(getStContext());
    assert.deepEqual(Object.keys(later), ['generateRaw']);
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
  }
});

test('晚绑定: 上下文必须**每次调用**重新解引用（改一个字段立刻生效）', () => {
  const live = { generateRaw: () => 'before' };
  const previous = globalThis.SillyTavern;
  globalThis.SillyTavern = { getContext: () => live };
  try {
    const table = installNativeAdapters(live);
    assert.equal(table.generateRaw(), 'before');
    live.generateRaw = () => 'after';
    assert.equal(table.generateRaw(), 'after', '同一个 ctx 对象上换实现也要立即可见');
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
  }
});

/* ============================ 4. 宏：前缀 / 同步守卫 / 自检 ============================ */

test('宏名前缀: 统一加 cx_，且对已带前缀的名字幂等', () => {
  assert.equal(MACRO_PREFIX, 'cx');
  assert.equal(withMacroPrefix('image_prompt'), 'cx_image_prompt');
  assert.equal(withMacroPrefix('cx_image_prompt'), 'cx_image_prompt');
  assert.equal(withMacroPrefix('  '), 'cx_', '空名也要有个合法的前缀名');
});

/*
 * ⚠️ 本节所有用例的宏名都必须是 **ASCII**。
 *
 * 原因（真机实测，见 native.ts 的 MACRO_NAME_PATTERN 注释）：酒馆的宏词法器只认
 * /^[a-zA-Z][\w-]*$/，中文名**注册不进去**（hasMacro 返回 false），
 * 但 register() 又**不抛错** —— 属于最隐蔽的一类静默失败。
 *
 * 这些用例原本用的是中文名（cx_图片提示词 / cx_同步宏 …）。那在旧实现下「看着能过」，
 * 是因为旧实现压根不做名字校验、只断言「register 被调用过」；
 * 补上校验之后它们正确地红了 —— **是测试当初编码了一个不成立的假设**，不是实现回归。
 * 所以这里把名字换成 ASCII，断言与用例意图一条没改。
 */

test('宏名合法性: 中文名必须被拒绝（酒馆词法器认不出来，静默不替换）', () => {
  const { ctx } = fakeSt();
  withSt(ctx, () => {
    const result = registerTavernMacro('图片提示词', () => 'v');
    assert.equal(result.ok, false, '中文宏名不可能生效，必须明确拒绝而不是让它静默失败');
    assert.match(result.reason, /ASCII|非 ASCII/, '原因要说清是 ASCII 的问题');
    assert.match(result.reason, /永远不会被替换/, '要说清后果');
  });
});

test('宏名合法性: 带空格 / 带点 / 中文 都拒绝', () => {
  /*
   * 注意断言的是**最终注册名**（已经加了 cx_ 前缀的那个），
   * 因为 withMacroPrefix 会把 '1abc' 变成合法的 'cx_1abc' —— 前缀本身就修好了「数字开头」。
   * 所以「数字开头」不属于要拒绝的集合，真正过不去的是含**空格 / 点 / 非 ASCII** 的名字：
   * 那些字符即便加了前缀也仍在 /^[a-zA-Z][\w-]*$/ 之外。
   */
  for (const bad of ['has space', 'a.b', '中文名']) {
    const { ctx } = fakeSt();
    withSt(ctx, () => {
      const result = registerTavernMacro(bad, () => 'v');
      assert.equal(result.ok, false, JSON.stringify(bad) + ' 应该被拒绝');
    });
  }
  // 数字开头会被前缀救回来，属于**合法**：断言它不是因为「名字不合法」被拒
  const digit = fakeSt();
  withSt(digit.ctx, () => {
    const result = registerTavernMacro('1abc', () => 'v');
    assert.equal(result.name, 'cx_1abc');
    assert.ok(!/不合法/.test(result.reason ?? ''), '加前缀后 cx_1abc 是合法名：' + result.reason);
  });
  // 空名同理不算非法：withMacroPrefix('') 给出 'cx_'，它满足 ST 的 /^[a-zA-Z][\w-]*$/。
  const empty = fakeSt();
  withSt(empty.ctx, () => {
    const result = registerTavernMacro('', () => 'v');
    assert.equal(result.name, 'cx_');
    assert.ok(!/不合法/.test(result.reason ?? ''), '空名不该被判成「名字不合法」：' + result.reason);
  });
});

test('宏名前缀: 注册进去的名字真的带前缀（避开 ST 自带 131 个内置宏）', () => {
  const { ctx, calls } = fakeSt();
  withSt(ctx, () => {
    const result = registerTavernMacro('image_prompt', () => '值');
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.name, 'cx_image_prompt');
    const registered = calls.find(c => c[0] === 'macros.register');
    assert.equal(registered[1], 'cx_image_prompt', '进 registry 的必须是带前缀的名');
  });
});

test('同步守卫: handler 返回 Promise → 拒绝注册（不报错、只渲成空，这条最难查）', () => {
  const { ctx } = fakeSt();
  withSt(ctx, () => {
    const result = registerTavernMacro('async_macro', () => Promise.resolve('x'));
    assert.equal(result.ok, false);
    assert.match(result.reason, /Promise/, '原因里要说清是 Promise 的问题');
    assert.match(result.reason, /同步|synchronously/, '要给出「必须同步」这个结论');
  });
});

test('同步守卫: 同步返回字符串 → 注册通过', () => {
  const { ctx } = fakeSt();
  withSt(ctx, () => {
    const result = registerTavernMacro('sync_macro', () => 'ok');
    assert.deepEqual(result, { ok: true, name: 'cx_sync_macro' });
  });
});

test('assertSyncMacroResult: thenable 判定（真 Promise / 类 Promise 都拦）', () => {
  assert.equal(assertSyncMacroResult('字符串', 'm').ok, true);
  assert.equal(assertSyncMacroResult('', 'm').ok, true);
  assert.equal(assertSyncMacroResult(null, 'm').ok, true);
  assert.equal(assertSyncMacroResult(Promise.resolve(1), 'm').ok, false);
  assert.equal(assertSyncMacroResult({ then: () => {} }, 'm').ok, false, 'thenable 也要拦');
});

/* ============================ 5. 宏注册的**静默失败**自检 ============================ */

test('自检: 注册成功且参数名对 → ok', () => {
  const { ctx, macroTable } = fakeSt();
  withSt(ctx, () => {
    const result = registerTavernMacro('arg_macro', () => 'v', {
      unnamedArgs: [{ name: 'a' }, { name: 'b' }],
      sampleArgs: ['x', 'y'],
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(macroTable.get('cx_arg_macro').unnamedArgs.length, 2);
  });
});

test('自检: registry 里读不回来 → 判失败并给出人话原因（静默失败的唯一防线）', () => {
  // 造一个「register 是空操作」的假 ST：注册不报错，但宏根本没进表
  const { ctx } = fakeSt();
  ctx.macros.register = () => {};
  withSt(ctx, () => {
    const result = registerTavernMacro('lost_macro', () => 'v');
    assert.equal(result.ok, false, '注册后读不回来必须判失败，不能信 register 不抛错');
    assert.match(result.reason, /读不回来|未生效/);
    assert.match(result.reason, /unnamedArgs/, '原因里要指出正确的参数名');
  });
});

test('自检: 声明了参数个数但 registry 里没有 → 判失败（minArgs 当入参传的典型症状）', () => {
  const { ctx, macroTable } = fakeSt();
  // 模拟「调用方用了 minArgs 而不是 unnamedArgs」：register 只记 name，不记参数
  ctx.macros.register = (name, definition) => {
    macroTable.set(name, { name, handler: definition.handler, minArgs: definition.minArgs });
  };
  withSt(ctx, () => {
    const result = registerTavernMacro('lost_args', () => 'v', { unnamedArgs: [{ name: 'a' }], sampleArgs: ['x'] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unnamedArgs|MacroRegistry/, '要说清真名是 unnamedArgs');
  });
});

test('自检: 失败要**回滚**（注销掉），不留一个看起来成功实际不生效的宏', () => {
  const { ctx, macroTable, calls } = fakeSt();
  ctx.macros.register = () => {};
  withSt(ctx, () => {
    const result = registerTavernMacro('rollback_me', () => 'v');
    assert.equal(result.ok, false);
    const unregistered = calls.filter(c => c[0] === 'macros.unregister');
    assert.equal(unregistered.length, 1, '自检失败必须注销回滚一次');
    assert.equal(unregistered[0][1], 'cx_rollback_me');
  });
});

test('verifyMacroRegistered: 没有 registry 时明确说无法自检（不假装成功）', () => {
  const verdict = verifyMacroRegistered({ macros: {} }, 'x');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /无法自检/);
});

test('lookupMacro: Map 与普通对象两种 registry 存取形态都认', () => {
  const asMap = { macros: { registry: { macros: new Map([['a', { name: 'a' }]]) } } };
  assert.equal(lookupMacro(asMap, 'a').name, 'a');
  const asObject = { macros: { registry: { macros: { b: { name: 'b' } } } } };
  assert.equal(lookupMacro(asObject, 'b').name, 'b');
  assert.equal(lookupMacro({}, 'c'), undefined);
});

test('没有 macros.register 时返回人话原因（不抛）', () => {
  const { ctx } = fakeSt();
  delete ctx.macros;
  withSt(ctx, () => {
    const result = registerTavernMacro('no_iface', () => 'v');
    assert.equal(result.ok, false);
    assert.match(result.reason, /macros\.register/);
  });
});

test('宏 handler 抛错时试跑就要拦住（不让它进 registry 之后每帧炸）', () => {
  const { ctx, calls } = fakeSt();
  withSt(ctx, () => {
    const result = registerTavernMacro('will_throw', () => {
      throw new Error('boom');
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /试跑失败/);
    assert.equal(calls.some(c => c[0] === 'macros.register'), false, '试跑就炸不该注册');
  });
});

test('unregisterTavernMacro: 走 registry.unregisterMacro；没接口返回 false 不抛', () => {
  const { ctx, macroTable } = fakeSt();
  withSt(ctx, () => {
    registerTavernMacro('to_unregister', () => 'v');
    assert.equal(macroTable.has('cx_to_unregister'), true);
    assert.equal(unregisterTavernMacro('cx_to_unregister'), true);
    assert.equal(macroTable.has('cx_to_unregister'), false);
  });
  const bare = fakeSt();
  delete bare.ctx.macros;
  withSt(bare.ctx, () => {
    assert.equal(unregisterTavernMacro('x'), false);
  });
});/* ============ 6. 变量：读路径**不许碰本地缓存**（多标签页数据丢失防线） ============ */

test('变量: 写进去能读回来（走原生 set/get）', () => {
  const { ctx, localVars } = fakeSt();
  withSt(ctx, () => {
    const table = installNativeAdapters(ctx);
    table.insertOrAssignVariables({ ROOT: { a: 1 } }, { type: 'script' });
    assert.deepEqual(table.getVariables({ type: 'script' }), { ROOT: { a: 1 } });
    assert.equal(localVars.has('ROOT'), true, '要真写进原生 variables.local（脚本作用域）');
  });
});

test('变量: **没写过**的键读不到（绝不凭本地缓存凭空造一个值出来）', () => {
  const { ctx } = fakeSt();
  withSt(ctx, () => {
    const table = installNativeAdapters(ctx);
    assert.deepEqual(table.getVariables({ type: 'script' }), {});
  });
});

test('变量: 别的标签页写的值读不到时**返回缺席**，不拿本地缓存顶替', () => {
  // 场景：本进程从没写过，但原生 get 读得到（别页/别处写的）
  const { ctx, localVars } = fakeSt();
  withSt(ctx, () => {
    const table = installNativeAdapters(ctx);
    // 只有「已知键」清单里的键才会去读 —— 这是 ST 没有 enumerate 接口的必然结果
    assert.deepEqual(table.getVariables({ type: 'script' }), {});

    // 我们自己写过一次之后，同一个键才进清单；但值一律从**原生**读
    table.insertOrAssignVariables({ ROOT: 'v1' }, { type: 'script' });
    localVars.set('ROOT', 'v2-别的地方改的');
    assert.equal(table.getVariables({ type: 'script' }).ROOT, 'v2-别的地方改的', '值必须来自原生，不是内存缓存');
  });
});

test('变量: 原生 get 读不到时，不回落任何本地缓存（宁可缺席）', () => {
  const { ctx, localVars } = fakeSt();
  withSt(ctx, () => {
    const table = installNativeAdapters(ctx);
    table.insertOrAssignVariables({ ROOT: 'written' }, { type: 'script' });
    // 模拟原生那边把值删了（用户在别处清掉 / 换机器）
    localVars.delete('ROOT');
    assert.deepEqual(
      table.getVariables({ type: 'script' }),
      {},
      '原生读不到就必须缺席 —— 回落内存缓存会把「读不到」伪装成「读到旧值」',
    );
  });
});

test('变量: 作用域分档 —— 脚本作用域走 local，持久作用域走 global', () => {
  const { ctx, globalVars, localVars } = fakeSt();
  withSt(ctx, () => {
    const table = installNativeAdapters(ctx);
    table.insertOrAssignVariables({ L: 1 }, { type: 'script' });
    table.insertOrAssignVariables({ G: 2 }, { type: 'global' });
    assert.equal(localVars.has('L'), true, '脚本作用域 → variables.local');
    assert.equal(globalVars.has('G'), true, '持久作用域 → variables.global');
    assert.equal(globalVars.has('L'), false);
    assert.equal(localVars.has('G'), false);
  });
});

test('变量: 没有原生 set 时明确失败，不假装写成功', () => {
  const { ctx } = fakeSt();
  delete ctx.variables;
  withSt(ctx, () => {
    const table = installNativeAdapters(ctx);
    // 整块变量能力都缺席（没有 variables 就不放这几个键）
    assert.equal('getVariables' in table, false);
    assert.equal('insertOrAssignVariables' in table, false);
  });
});

test('变量: replaceVariables / updateVariablesWith 走原生，换掉旧的键', () => {
  const { ctx, localVars } = fakeSt();
  withSt(ctx, () => {
    const table = installNativeAdapters(ctx);
    table.insertOrAssignVariables({ A: 1, B: 2 }, { type: 'script' });
    table.replaceVariables({ C: 3 }, { type: 'script' });
    assert.deepEqual(table.getVariables({ type: 'script' }), { C: 3 }, '整体替换后只剩新的');
    assert.equal(localVars.has('A'), true, '(replace 只清我们的已知键清单，不主动删原生键)');

    table.updateVariablesWith(t => ({ ...t, D: 4 }), { type: 'script' });
    assert.deepEqual(table.getVariables({ type: 'script' }), { C: 3, D: 4 });
  });
});

/* ==================== 7. 世界书 / 请求头 / 明确不可用 ==================== */

test('世界书: 原生 loadWorldInfo / saveWorldInfo / getWorldInfoNames 都接上', async () => {
  const { ctx } = fakeSt();
  await withStAsync(ctx, async () => {
    const table = installNativeAdapters(ctx);
    // P5-7 起 getWorldbook **不是直通**：ST 返回 { entries: {...} }，
    // 适配层要拍平成数组（上层 core/worldbook.ts 的契约是数组）。
    // 这里甲世界是空书 → 拍平后是 []；形状转换的详细用例见下面的 P5-7 那一组。
    assert.deepEqual(await table.getWorldbook('甲世界'), []);
    assert.deepEqual(await table.getWorldbookNames(), ['甲世界', '乙世界']);
    assert.deepEqual(table.getGlobalWorldbookNames(), ['乙世界'], '全局启用从原生 extensionSettings 读');
  });
});

test('请求头: 原生 getRequestHeaders 直通（手写 CSRF 获取退役）', () => {
  const { ctx } = fakeSt();
  withSt(ctx, () => {
    const table = installNativeAdapters(ctx);
    assert.deepEqual(table.getRequestHeaders(), { 'X-CSRF-Token': 'tok' });
  });
});

test('明确不可用: getScriptTrees 必须在 NO_NATIVE_EQUIVALENT 里（别让后来人以为漏写了）', () => {
  assert.equal(hasNoNativeEquivalent('getScriptTrees'), true, 'getScriptTrees 是唯一没有原生对应的接口，必须显式标出来');
  assert.match(NO_NATIVE_EQUIVALENT.getScriptTrees, /酒馆助手独有/);
  assert.match(NO_NATIVE_EQUIVALENT.getScriptTrees, /assets|images\/list/, '要说清图库改走了哪条路');
  assert.equal(hasNoNativeEquivalent('getModelList'), true);
  assert.equal(hasNoNativeEquivalent('getScriptId'), true);
});

test('明确不可用: 原生表**不许**造一个假的 getScriptTrees 出来', () => {
  const { ctx } = fakeSt();
  const table = installNativeAdapters(ctx);
  assert.equal('getScriptTrees' in table, false, 'ST 没有对应就不许硬造 —— 要诚实地缺席');
});

test('NATIVE_PATHS: 关键接口都有人话对照（界面报原因时要用）', () => {
  for (const name of ['generateRaw', 'substitudeMacros', 'registerMacroLike', 'getWorldbook', 'getRequestHeaders']) {
    assert.ok(NATIVE_PATHS[name], name + ' 要有原生路径说明');
  }
  assert.match(NATIVE_PATHS.substitudeMacros, /substituteParams/, '要记下 ST／酒馆助手的拼写差异');
});

/* ==================== 8. probeNativeCapabilities ==================== */

test('probeNativeCapabilities: 空上下文返回空数组；完整上下文返回覆盖到的名字', () => {
  assert.deepEqual(probeNativeCapabilities(null), []);
  const { ctx } = fakeSt();
  const names = probeNativeCapabilities(ctx);
  assert.ok(names.length > 15, '假 ST 是「全都有」的形态，应该覆盖到十多个接口：' + names.length);
  assert.ok(names.includes('generateRaw'));
});
/* ============ 9. 世界书形状转换（P5-7：名字对上了，形状没对上）============ */

/*
 * ⚠️ 这一组修的是**会毁数据**的 bug（真机实测：读永远 0 条、写会把整本清空）。
 *
 * 根因：core/worldbook.ts 是照**酒馆助手**的形状写的（getWorldbook 返回数组、
 * replaceWorldbook 收数组），而扩展形态下这些名字被映射到 **ST 原生**，形状不同：
 *   ctx.loadWorldInfo(name)       → { entries: { uid: {...} } }  ← 对象
 *   ctx.saveWorldInfo(name,data)  → data.entries 必须是那个对象
 * 适配层必须**在原生这条路上**抹平，且不能影响酒馆助手那条路。
 */

/** 造一条「ST 形态」的原始条目（数字 uid、comment 标题、ST 扁平字段） */
function stRawEntry(uid, name, content, over = {}) {
  return {
    uid,
    comment: name,
    content,
    disable: false,
    key: ['甲'],
    keysecondary: [],
    selectiveLogic: 0,
    constant: false,
    position: 0,
    depth: 4,
    order: 100,
    scanDepth: 4,
    ...over,
  };
}

/** 一个「ST 原生 loadWorldInfo」形状的假实现：返回 { entries: { uid: entry } } */
function stWorldbookCtx(books) {
  const calls = [];
  return {
    calls,
    ctx: {
      loadWorldInfo: name => Promise.resolve(books[name] ? { entries: books[name] } : null),
      saveWorldInfo: (name, data, immediately) => {
        calls.push({ name, data, immediately });
        return Promise.resolve(true);
      },
      getWorldInfoNames: () => Object.keys(books),
    },
  };
}

test('P5-7 反例自检①: 喂 { entries: {...} }（对象）必须被**拍成数组**', async () => {
  // 这就是真机上 readAll 返回 0 条的那个形状
  const fake = stWorldbookCtx({
    Eldoria: {
      0: stRawEntry(0, 'eldoria', '苍梧山的天枢阁'),
      1: stRawEntry(1, 'shadowfang', '影牙'),
      2: stRawEntry(2, 'glade', '林间空地'),
      3: stRawEntry(3, 'power', '力量体系'),
    },
  });
  await withStAsync(fake.ctx, async () => {
    const table = installNativeAdapters(fake.ctx);
    const entries = await table.getWorldbook('Eldoria');
    assert.ok(Array.isArray(entries), 'getWorldbook 必须返回**数组**（上层 readAll 用 isArray 判）');
    assert.equal(entries.length, 4, '4 条真书必须读回 4 条 —— 旧实现这里返回 0 条');
    // uid 回填：ST 的 uid 在**映射的键**上，条目体里不一定有
    assert.deepEqual(entries.map(e => String(e.uid)), ['0', '1', '2', '3'], '键就是 uid，必须回填');
    assert.deepEqual(entries.map(e => e.content), ['苍梧山的天枢阁', '影牙', '林间空地', '力量体系']);
  });
});

test('P5-7 反例自检②: 喂数组必须被**包成 { entries: {...} }**（否则 ST 落盘 0 条）', async () => {
  const fake = stWorldbookCtx({});
  await withStAsync(fake.ctx, async () => {
    const table = installNativeAdapters(fake.ctx);
    await table.replaceWorldbook('cx-wb-shape-test', [
      stRawEntry(0, 'A', 'a'),
      stRawEntry(1, 'B', 'b'),
    ]);
    assert.equal(fake.calls.length, 1);
    const sent = fake.calls[0].data;
    assert.equal(Array.isArray(sent), false, '绝不能把数组直接交给 ST（真机实测那样会落盘 0 条）');
    assert.ok(sent && typeof sent.entries === 'object' && !Array.isArray(sent.entries), '必须是 { entries: {...} }');
    assert.deepEqual(Object.keys(sent.entries).sort(), ['0', '1']);
    assert.deepEqual(sent.entries['0'].content, 'a');
  });
});

test('P5-7: 读→写往返不丢 extra（未知字段一个都不能丢）', async () => {
  const fake = stWorldbookCtx({
    Eldoria: { 0: stRawEntry(0, 'eldoria', '正文', { extra_field: '要留着', vectorized: true, probability: 100 }) },
  });
  await withStAsync(fake.ctx, async () => {
    const table = installNativeAdapters(fake.ctx);
    const entries = await table.getWorldbook('Eldoria');
    // 原始条目一个字段都不许少（这是「不丢字段」的底稿）
    assert.equal(entries[0].extra_field, '要留着');
    assert.equal(entries[0].vectorized, true);
    assert.equal(entries[0].probability, 100);

    await table.replaceWorldbook('Eldoria', entries);
    const back = fake.calls[0].data.entries['0'];
    assert.equal(back.extra_field, '要留着', '写回时未知字段要合并回去');
    assert.equal(back.vectorized, true);
    assert.equal(back.content, '正文');
  });
});

test('P5-7: 拍平是幂等的（已是数组原样返回；已是映射原样返回）', () => {
  const arr = [{ uid: '1' }];
  assert.equal(stEntriesToArray(arr), arr, '数组进数组出，同一引用');
  const map = { 1: { uid: 1 } };
  assert.deepEqual(Object.keys(arrayToStEntries(map)), ['1'], '映射进映射出');
});

test('P5-7: 两种非预期输入都不抛（读失败按「没有条目」处理，不炸界面）', () => {
  assert.deepEqual(stEntriesToArray(null), []);
  assert.deepEqual(stEntriesToArray('字符串'), []);
  assert.deepEqual(stEntriesToArray(42), []);
  assert.deepEqual(normalizeWorldbookRead(null), []);
  assert.deepEqual(normalizeWorldbookRead({ 没有entries: 1 }), []);
  assert.deepEqual(arrayToStEntries(null), {});
});

test('P5-7: 已经是数组的宿主原样返回（某些 ST 版本直接给数组）', () => {
  assert.deepEqual(normalizeWorldbookRead([{ uid: '1' }]), [{ uid: '1' }]);
});

test('P5-7: 写回时第三参传 true（立刻落盘，防抖写丢）', async () => {
  const fake = stWorldbookCtx({});
  await withStAsync(fake.ctx, async () => {
    const table = installNativeAdapters(fake.ctx);
    await table.replaceWorldbook('x', []);
    assert.equal(fake.calls[0].immediately, true, 'ST 的第二参是 immediately:boolean，要传 true');
  });
});
