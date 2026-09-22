/**
 * P4-10 [阻塞] 数据作用域 + 读失败保护（core/storage.ts + core/native.ts）。
 *
 * 要防的回归（真机实测过的数据丢失事故）：
 *   扩展形态下 storage 无条件用「脚本作用域」→ 酒馆助手抛「获取变量失败, 未指定 script_id」
 *   → 读失败 → store 用默认值启动 → 紧接着的 save 把**默认值**写回去 → 用户设置全没。
 *   表现：每刷新一次，数据丢一次。
 *
 * 本文件钉三件事：
 *  1. **作用域分流**：脚本形态保持 {type:'script', script_id}（老数据不搬家）；
 *     扩展形态用 {type:'global'}（读得回来、跨刷新）；
 *  2. **读写同一作用域**：读和写必须解析出同一个（病根是「读一处写另一处」）；
 *  3. **读失败保护**：读失败时不许用默认值覆盖存储，但**用户的真实改动要能存进去**。
 *     这条比修作用域更重要 —— 它把「任何一个读故障都会变成静默数据丢失」堵死。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const core = '../../src/苍玄助手/core/';
const storage = await import(core + 'storage.ts');
const native = await import(core + 'native.ts');

const defaultRootData = storage.defaultRootData;
const loadData = storage.loadData;
const readStoredRootData = storage.readStoredRootData;
const saveData = storage.saveData;
const saveRootData = storage.saveRootData;
const setHostBridge = storage.setHostBridge;
const resolveDataScope = storage.resolveDataScope;
const resetDataScope = storage.resetDataScope;
const describeStorageScope = storage.describeStorageScope;
const getLastLoadOutcome = storage.getLastLoadOutcome;
const resetLoadOutcome = storage.resetLoadOutcome;
const shouldBlockWrite = storage.shouldBlockWrite;
const markUserTouchedData = storage.markUserTouchedData;
const resetUserTouchedData = storage.resetUserTouchedData;
const hasUserTouchedData = storage.hasUserTouchedData;
const scriptScope = storage.scriptScope;
const GLOBAL_KEY = (await import(core + 'types.ts')).GLOBAL_KEY;
const isExtensionRuntime = native.isExtensionRuntime;
const dataScope = native.dataScope;
const installNativeAdapters = native.installNativeAdapters;
const declareNativeKey = native.declareNativeKey;
const declaredNativeKeys = native.declaredNativeKeys;
const resetDeclaredNativeKeys = native.resetDeclaredNativeKeys;
const registerNativeAdapters = (await import(core + 'host.ts')).registerNativeAdapters;
const hostFn = storage.hostFn;

/* ============================ 脚手架 ============================ */

/**
 * 造一个「扩展形态」的全局：没有 __CX_SCRIPT_ID__、宿主链上没有 getScriptId。
 * 这正是真机上「TavernHelper.getScriptId → (不存在这个函数)」的状态。
 */
function asExtensionRuntime() {
  const saved = {
    scriptId: globalThis.__CX_SCRIPT_ID__,
    extension: globalThis.__CX_EXTENSION__,
    helper: globalThis.TavernHelper,
    bare: globalThis.getScriptId,
  };
  delete globalThis.__CX_SCRIPT_ID__;
  delete globalThis.__CX_EXTENSION__;
  delete globalThis.TavernHelper;
  delete globalThis.getScriptId;
  resetDataScope();
  return () => {
    if (saved.scriptId === undefined) delete globalThis.__CX_SCRIPT_ID__;
    else globalThis.__CX_SCRIPT_ID__ = saved.scriptId;
    if (saved.extension === undefined) delete globalThis.__CX_EXTENSION__;
    else globalThis.__CX_EXTENSION__ = saved.extension;
    if (saved.helper === undefined) delete globalThis.TavernHelper;
    else globalThis.TavernHelper = saved.helper;
    if (saved.bare === undefined) delete globalThis.getScriptId;
    else globalThis.getScriptId = saved.bare;
    resetDataScope();
  };
}

/** 造一个「脚本形态」的全局：有 __CX_SCRIPT_ID__（酒馆助手脚本面板会注入它） */
function asScriptRuntime(id = 'script-abc') {
  const saved = globalThis.__CX_SCRIPT_ID__;
  globalThis.__CX_SCRIPT_ID__ = id;
  resetDataScope();
  return () => {
    if (saved === undefined) delete globalThis.__CX_SCRIPT_ID__;
    else globalThis.__CX_SCRIPT_ID__ = saved;
    resetDataScope();
  };
}

/** 每个用例开头调：把三个模块级状态都复位，免得互相污染 */
function freshState() {
  resetDataScope();
  resetLoadOutcome();
  resetUserTouchedData();
}/* ============================ 1. 扩展形态判定 ============================ */

test('isExtensionRuntime: 没有 __CX_SCRIPT_ID__ 也没有 getScriptId → 扩展形态（真机形态）', () => {
  const restore = asExtensionRuntime();
  try {
    assert.equal(isExtensionRuntime(), true);
  } finally {
    restore();
  }
});

test('isExtensionRuntime: 有 __CX_SCRIPT_ID__ → 脚本形态（老用户环境不能被误判）', () => {
  const restore = asScriptRuntime();
  try {
    assert.equal(isExtensionRuntime(), false);
  } finally {
    restore();
  }
});

test('isExtensionRuntime: 宿主链上有 getScriptId → 脚本形态', () => {
  const restore = asExtensionRuntime();
  const savedHelper = globalThis.TavernHelper;
  try {
    globalThis.TavernHelper = { getScriptId: () => 'from-helper' };
    assert.equal(isExtensionRuntime(), false);
    delete globalThis.TavernHelper;
    globalThis.getScriptId = () => 'from-global';
    assert.equal(isExtensionRuntime(), false, '裸全局 getScriptId 也要认（兼容旧行为）');
  } finally {
    delete globalThis.getScriptId;
    if (savedHelper !== undefined) globalThis.TavernHelper = savedHelper;
    restore();
  }
});

test('isExtensionRuntime: 显式声明 __CX_EXTENSION__ = true → 扩展形态（外壳可以主动标）', () => {
  const saved = globalThis.__CX_EXTENSION__;
  try {
    globalThis.__CX_EXTENSION__ = true;
    assert.equal(isExtensionRuntime(), true);
  } finally {
    if (saved === undefined) delete globalThis.__CX_EXTENSION__;
    else globalThis.__CX_EXTENSION__ = saved;
  }
});

/* ============================ 2. 作用域分流 ============================ */

test('dataScope: 扩展形态 → global（跨刷新跨会话；chat 会随聊天丢，不合适）', () => {
  const restore = asExtensionRuntime();
  try {
    assert.deepEqual(dataScope(), { type: 'global' });
  } finally {
    restore();
  }
});

test('dataScope: 脚本形态 → {type:script, script_id}（老数据原地不动，不搬家）', () => {
  const restore = asScriptRuntime('script-xyz');
  try {
    assert.deepEqual(dataScope(), { type: 'script', script_id: 'script-xyz' });
  } finally {
    restore();
  }
});

test('dataScope: 显式传入 scope 时以调用方为准', () => {
  assert.deepEqual(dataScope({ type: 'chat' }), { type: 'chat' });
  assert.deepEqual(dataScope({ type: 'script', script_id: 'given' }), { type: 'script', script_id: 'given' });
});

test('resolveDataScope: 扩展形态下**不是**裸的 {type:script}（那正是会抛错的形态）', () => {
  const restore = asExtensionRuntime();
  freshState();
  try {
    const scope = resolveDataScope();
    assert.notDeepEqual(scope, { type: 'script' }, '裸 script 作用域在扩展形态会抛「未指定 script_id」——P4-10 的病根');
    assert.equal(scope.type, 'global');
  } finally {
    freshState();
    restore();
  }
});

test('scriptScope: 脚本形态的老语义原样保留（这个函数没被删）', () => {
  const restore = asScriptRuntime('sid-1');
  try {
    assert.deepEqual(scriptScope(), { type: 'script', script_id: 'sid-1' });
  } finally {
    restore();
  }
});

test('describeStorageScope: 给出人话位置（界面/排查要用）', () => {
  const restoreExt = asExtensionRuntime();
  freshState();
  try {
    assert.match(describeStorageScope(), /全局变量/);
  } finally {
    restoreExt();
    freshState();
  }
  const restoreScript = asScriptRuntime('sid-2');
  freshState();
  try {
    assert.match(describeStorageScope(), /脚本变量/);
  } finally {
    restoreScript();
    freshState();
  }
});

/* ============================ 3. 读写同一作用域 ============================ */

test('读写同作用域: 扩展形态下读和写**都用 global**（病根是读一处写另一处）', () => {
  const restore = asExtensionRuntime();
  freshState();
  const readScopes = [];
  const writeScopes = [];
  try {
    setHostBridge({
      getVariables: scope => {
        readScopes.push(scope);
        return { [GLOBAL_KEY]: { active_tab: 'chat' } };
      },
      insertOrAssignVariables: (payload, scope) => writeScopes.push(scope),
    });
    loadData();
    const data = defaultRootData();
    data.active_tab = 'settings';
    saveData(data);
    assert.equal(readScopes.length, 1);
    assert.equal(writeScopes.length, 1);
    assert.deepEqual(readScopes[0], { type: 'global' }, '读要落 global');
    assert.deepEqual(writeScopes[0], { type: 'global' }, '写要落**同一个** global');
    assert.deepEqual(readScopes[0], writeScopes[0], '读与写必须是同一个作用域');
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('读写同作用域: 脚本形态下读和写都用带 script_id 的脚本作用域', () => {
  const restore = asScriptRuntime('sid-rw');
  freshState();
  const readScopes = [];
  const writeScopes = [];
  try {
    setHostBridge({
      getVariables: scope => {
        readScopes.push(scope);
        return { [GLOBAL_KEY]: { active_tab: 'chat' } };
      },
      insertOrAssignVariables: (payload, scope) => writeScopes.push(scope),
    });
    loadData();
    const data = defaultRootData();
    saveData(data);
    assert.deepEqual(readScopes[0], { type: 'script', script_id: 'sid-rw' });
    assert.deepEqual(writeScopes[0], { type: 'script', script_id: 'sid-rw' });
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('读写同作用域: 作用域在会话内**稳定**（不会读时 global、写时又漂回 script）', () => {
  const restore = asExtensionRuntime();
  freshState();
  try {
    const first = resolveDataScope();
    const second = resolveDataScope();
    assert.deepEqual(first, second);
    // 中途环境变了（模拟脚本 id 晚注入）—— 已定下来的作用域不该漂移，否则读写错位
    globalThis.__CX_SCRIPT_ID__ = 'late-injected';
    assert.deepEqual(resolveDataScope(), first, '作用域一旦定下就不许中途漂移（否则丢数据）');
  } finally {
    delete globalThis.__CX_SCRIPT_ID__;
    freshState();
    restore();
  }
});/* ==================== 4. 读失败保护（本任务最重要的那条） ==================== */

test('保护: 读失败 + 用户没动过 → **拒绝写**，绝不用默认值覆盖存储', () => {
  const restore = asExtensionRuntime();
  freshState();
  const writes = [];
  try {
    // 模拟真机：script 作用域抛「未指定 script_id」那种读失败
    setHostBridge({
      getVariables: () => {
        throw new Error('获取变量失败, 未指定 script_id');
      },
      insertOrAssignVariables: payload => writes.push(payload),
    });
    const data = loadData();
    assert.equal(getLastLoadOutcome(), 'failed', '读失败要记成 failed');
    assert.equal(shouldBlockWrite(data), true);
    assert.throws(() => saveData(data), /已阻止写入/, '写必须被拦下');
    assert.equal(writes.length, 0, '一次写都不许发生 —— 这就是「不许覆盖用户数据」');
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: 读失败但**用户改过数据** → 放行（否则用户改动存不进去，同样是坏结果）', () => {
  const restore = asExtensionRuntime();
  freshState();
  const writes = [];
  try {
    setHostBridge({
      getVariables: () => {
        throw new Error('读失败');
      },
      insertOrAssignVariables: payload => writes.push(payload),
    });
    const data = loadData();
    assert.equal(shouldBlockWrite(data), true, '默认值状态该拦');

    // 用户改了一个设置 → 内容不再等于「失败读那份默认数据」
    const changed = JSON.parse(JSON.stringify(data));
    changed.active_tab = 'settings';
    assert.equal(shouldBlockWrite(changed), false, '内容变了就该放行');
    saveData(changed);
    assert.equal(writes.length, 1, '用户的真实改动必须能存进去');
    assert.equal(writes[0][GLOBAL_KEY].active_tab, 'settings');
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: markUserTouchedData 是显式通道 —— 声明动过之后一律放行', () => {
  const restore = asExtensionRuntime();
  freshState();
  const writes = [];
  try {
    setHostBridge({
      getVariables: () => {
        throw new Error('读失败');
      },
      insertOrAssignVariables: payload => writes.push(payload),
    });
    const data = loadData();
    assert.equal(hasUserTouchedData(), false);
    assert.equal(shouldBlockWrite(data), true);
    markUserTouchedData();
    assert.equal(hasUserTouchedData(), true);
    assert.equal(shouldBlockWrite(data), false, '显式声明动过 → 放行');
    saveData(data);
    assert.equal(writes.length, 1);
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: saveData(force=true) 可显式绕过（导入数据 / 用户手动恢复用）', () => {
  const restore = asExtensionRuntime();
  freshState();
  const writes = [];
  try {
    setHostBridge({
      getVariables: () => {
        throw new Error('读失败');
      },
      insertOrAssignVariables: payload => writes.push(payload),
    });
    const data = loadData();
    assert.throws(() => saveData(data), /已阻止写入/);
    saveData(data, true);
    assert.equal(writes.length, 1, 'force=true 要能写进去');
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: 读**成功**时绝不拦（保护不能误伤正常流程）', () => {
  const restore = asExtensionRuntime();
  freshState();
  const writes = [];
  try {
    setHostBridge({
      getVariables: () => ({ [GLOBAL_KEY]: { active_tab: 'chat' } }),
      insertOrAssignVariables: payload => writes.push(payload),
    });
    // 读到真数据 -> 'ok'（读通了，且里面确实有我们的 key）
    const loaded = loadData();
    assert.equal(getLastLoadOutcome(), 'ok', '读到真数据要记成 ok');
    assert.equal(loaded.active_tab, 'chat', '读回来的值要生效');
    saveData(defaultRootData());
    assert.equal(writes.length, 1);
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: 存储里**没有**我们的 key（全新用户）→ empty，允许写', () => {
  const restore = asExtensionRuntime();
  freshState();
  const writes = [];
  try {
    setHostBridge({
      getVariables: () => ({ someone_else: 1 }),
      insertOrAssignVariables: payload => writes.push(payload),
    });
    loadData();
    assert.equal(getLastLoadOutcome(), 'empty', '读通了但没这个 key = 全新用户，不是读失败');
    saveData(defaultRootData());
    assert.equal(writes.length, 1, '全新用户必须能写');
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: 读接口整个缺失 → failed，同样拦住', () => {
  const restore = asExtensionRuntime();
  freshState();
  const writes = [];
  try {
    setHostBridge({ insertOrAssignVariables: payload => writes.push(payload) });
    const data = loadData();
    assert.equal(getLastLoadOutcome(), 'failed', '没有 getVariables = 读不到，算 failed');
    assert.throws(() => saveData(data), /已阻止写入/);
    assert.equal(writes.length, 0);
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: 读拿到非对象 → failed（作用域语义不对，不能当「没数据」）', () => {
  const restore = asExtensionRuntime();
  freshState();
  try {
    setHostBridge({ getVariables: () => null });
    readStoredRootData();
    assert.equal(getLastLoadOutcome(), 'failed');
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: 读失败时**不会**留下任何写入 —— 这才是「静默数据丢失」被堵死的证据', () => {
  const restore = asExtensionRuntime();
  freshState();
  const writes = [];
  try {
    setHostBridge({
      getVariables: () => {
        throw new Error('获取变量失败, 未指定 script_id');
      },
      insertOrAssignVariables: payload => writes.push(payload),
      replaceVariables: next => writes.push(next),
      updateVariablesWith: fn => writes.push(fn({})),
    });
    // 模拟一次完整启动：读 → （界面没动数据）→ 自动 save 若干次
    const data = loadData();
    for (let i = 0; i < 3; i++) {
      try {
        saveData(data);
      } catch {
        // 预期被拦
      }
    }
    assert.equal(writes.length, 0, '三次自动 save 全部被拦，存储里的旧数据一个字节都没被碰');
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: resetLoadOutcome 之后（还没读过）允许写 —— 不误拦直接 set 的调用方', () => {
  const restore = asExtensionRuntime();
  freshState();
  const writes = [];
  try {
    setHostBridge({ insertOrAssignVariables: payload => writes.push(payload) });
    assert.equal(getLastLoadOutcome(), null, '还没读过');
    saveData(defaultRootData());
    assert.equal(writes.length, 1);
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('保护: saveRootData 不抛错，返回 false（界面内部用的强类型版）', () => {
  const restore = asExtensionRuntime();
  freshState();
  try {
    setHostBridge({
      getVariables: () => {
        throw new Error('读失败');
      },
      insertOrAssignVariables: () => {},
    });
    const data = loadData();
    assert.equal(saveRootData(data), false, '被保护拦下 → 返回 false 而不是抛');
    assert.equal(saveRootData(data, true), true, 'force=true 能成功');
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});
/* ==================== 5. 拦截必须「可见」（lead 硬要求 C） ==================== */

test('可见性: 拦截要 console.warn 一句人话，且 saveRootData 返回 false（不许静默拦截）', () => {
  const restore = asExtensionRuntime();
  freshState();
  const warned = [];
  const originalWarn = console.warn;
  try {
    setHostBridge({
      getVariables: () => {
        throw new Error('获取变量失败, 未指定 script_id');
      },
      insertOrAssignVariables: () => {},
    });
    const data = loadData();
    console.warn = (...args) => warned.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
    const ok = saveRootData(data);
    console.warn = originalWarn;

    assert.equal(ok, false, '拦截必须返回 false（调用方能据此提示用户），不能假装成功');
    assert.ok(warned.length > 0, '拦截必须打日志 —— 静默拦截和静默覆盖一样坏');
    const line = warned.join('\n');
    assert.match(line, /拦下|已阻止|阻止写入/, '要说清「被拦下了」');
    assert.match(line, /读[到取]?(数据)?失败|没能读到|读取失败/, '要说清原因：读数据失败');
    assert.match(line, /默认值|覆盖/, '要说清后果：怕用默认值覆盖数据');
  } finally {
    console.warn = originalWarn;
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('可见性: 拦截时抛出的错误带**作用域人话**，便于用户/我们定位', () => {
  const restore = asExtensionRuntime();
  freshState();
  try {
    setHostBridge({
      getVariables: () => {
        throw new Error('读失败');
      },
      insertOrAssignVariables: () => {},
    });
    const data = loadData();
    assert.throws(
      () => saveData(data),
      err => {
        assert.match(err.message, /酒馆全局变量|作用域/, '要说清数据存在哪个作用域');
        assert.match(err.message, /force=true/, '要给出明确的绕行办法');
        return true;
      },
    );
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});

test('可见性: 环境**连写入接口都没有**时，报的是根因不是保护（报错要指向根因）', () => {
  const restore = asExtensionRuntime();
  freshState();
  try {
    setHostBridge({});
    assert.throws(
      () => saveData(defaultRootData()),
      /没有可用的变量写入接口/,
      '缺写入接口是环境级硬错，信息量最大 —— 不能被「已阻止写入」盖住',
    );
  } finally {
    setHostBridge(null);
    freshState();
    restore();
  }
});
/* ==================== 6. P4-10b：冷启动必须读得到（真机丢数据的根因） ==================== */

/**
 * 造一个「真 ST 形态」的 variables：**按 key 读得到、但不能枚举**。
 *
 * 这正是真机实测的形状：
 *   ctx.variables.global.get('cx_assistant_v1') → 完整数据 ✅
 *   ctx.variables.global.has('cx_assistant_v1') → true ✅
 *   Object.keys(ctx.variables.global) → ['get','set','del','add','inc','dec','has']  ← 只有方法
 */
function stNativeVariables(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    scope: {
      get: key => store.get(key),
      set: (key, value) => store.set(key, value),
      has: key => store.has(key),
      del: key => store.delete(key),
    },
    store,
  };
}

/**
 * 起一个「扩展形态 + 真 ST 变量」的环境，并把原生适配器装进 provider chain。
 * 返回 { restore, store }（store 是真 ST 侧的数据，用来核对读到了什么）。
 */
function bootExtensionWithSt({ seed = {}, register = true } = {}) {
  const saved = {
    st: globalThis.SillyTavern,
    helper: globalThis.TavernHelper,
    scriptId: globalThis.__CX_SCRIPT_ID__,
    bare: globalThis.getScriptId,
  };
  delete globalThis.TavernHelper;
  delete globalThis.__CX_SCRIPT_ID__;
  delete globalThis.getScriptId;

  const fake = stNativeVariables(seed);
  const ctx = { variables: { local: fake.scope, global: fake.scope } };
  globalThis.SillyTavern = { getContext: () => ctx };

  resetDataScope();
  resetLoadOutcome();
  resetUserTouchedData();

  if (register) {
    registerNativeAdapters(installNativeAdapters(ctx, { global: [GLOBAL_KEY] }));
  }

  return {
    store: fake.store,
    restore: () => {
      registerNativeAdapters(null);
      if (saved.st === undefined) delete globalThis.SillyTavern;
      else globalThis.SillyTavern = saved.st;
      if (saved.helper !== undefined) globalThis.TavernHelper = saved.helper;
      if (saved.scriptId !== undefined) globalThis.__CX_SCRIPT_ID__ = saved.scriptId;
      if (saved.bare !== undefined) globalThis.getScriptId = saved.bare;
      resetDataScope();
      resetLoadOutcome();
      resetUserTouchedData();
    },
  };
}

test('P4-10b: 冷启动（新进程 / 清单为空）+ ST 侧有数据 → **必须读得到**', () => {
  // 这条就是真机事故：以前 knownKeys 只记「本进程写过什么」，冷启动为空 → 读 {} → 丢数据。
  const env = bootExtensionWithSt({ seed: { [GLOBAL_KEY]: { version: 5, active_tab: 'chat' } } });
  try {
    // 什么都没写过 —— 纯冷启动
    assert.equal(getLastLoadOutcome(), null, '还没读过');
    const raw = readStoredRootData();
    assert.ok(raw, '冷启动必须读到数据（旧实现在这里返回 null → 丢数据）');
    assert.equal(raw.active_tab, 'chat');
    assert.equal(getLastLoadOutcome(), 'ok');
    assert.equal(loadData().active_tab, 'chat');
  } finally {
    env.restore();
  }
});

test('P4-10b: getVariables 靠**应用声明的种子键**工作，不靠「本进程写过什么」', () => {
  const env = bootExtensionWithSt({ seed: { [GLOBAL_KEY]: { version: 5 } } });
  try {
    const table = hostFn('getVariables')({ type: 'global' });
    assert.deepEqual(Object.keys(table), [GLOBAL_KEY], '种子键必须被读到');
  } finally {
    env.restore();
  }
});

test('P4-10b: ST 侧**确实没有**该键 + 不能枚举 → 记 failed 而不是 empty（不许当「空存储」覆盖）', () => {
  // 真 ST 不能枚举，所以「按已知键读不到」分不清「没有数据」还是「没读到」→ 必须按读失败处理。
  const env = bootExtensionWithSt({ seed: {} });
  try {
    const raw = readStoredRootData();
    assert.equal(raw, null);
    assert.equal(
      getLastLoadOutcome(),
      'failed',
      '不能枚举时读不到 ≠ 存储为空 —— 记 empty 会让保护失效、默认值被写回',
    );
  } finally {
    env.restore();
  }
});

test('P4-10b: 上面那种情况**必须拦住写入**（这是数据丢失的最后一环）', () => {
  const env = bootExtensionWithSt({ seed: {} });
  const writes = [];
  try {
    setHostBridge({ insertOrAssignVariables: payload => writes.push(payload) });
    const data = loadData();
    assert.equal(shouldBlockWrite(data), true, '读不到 + 没动过 → 必须拦');
    assert.throws(() => saveData(data), /已阻止写入/);
    assert.equal(writes.length, 0, '一次写都不许发生');
  } finally {
    setHostBridge(null);
    env.restore();
  }
});

test('P4-10b: 种子键可重复声明、跨多次建表累积（外壳早调 + storage 晚声明都要认）', () => {
  const saved = globalThis.SillyTavern;
  resetDeclaredNativeKeys();
  try {
    declareNativeKey('global', 'a');
    declareNativeKey('global', 'b');
    declareNativeKey('global', 'a'); // 幂等
    assert.deepEqual(declaredNativeKeys('global').sort(), ['a', 'b']);

    // 再声明一个，后面建的适配器表也要认得到
    declareNativeKey('global', 'c');
    const fake = stNativeVariables({ c: 42 });
    const ctx = { variables: { global: fake.scope } };
    globalThis.SillyTavern = { getContext: () => ctx };
    const table = installNativeAdapters(ctx);
    assert.equal(table.getVariables({ type: 'global' }).c, 42, '晚声明的键也要能读到');
  } finally {
    resetDeclaredNativeKeys();
    if (saved === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = saved;
    registerNativeAdapters(null);
    declareNativeKey('global', GLOBAL_KEY);
    declareNativeKey('local', GLOBAL_KEY);
  }
});