/**
 * 验收补充：core/macros.ts —— 酒馆宏 → 自定义宏的渲染顺序、历史/条目格式化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const core = '../../src/苍玄助手/core/';
const {
  applyStMacros,
  applyOwnMacros,
  render,
  usedMacros,
  OUR_MACROS,
  emptyMacroData,
  formatHistory,
  formatEntries,
  registerPluginMacroNames,
  registerPluginMacroSource,
} = await import(core + 'macros.ts');

function withStMacro(fn, run) {
  const scope = globalThis;
  const previous = scope.substitudeMacros;
  scope.substitudeMacros = fn;
  try {
    return run();
  } finally {
    if (previous === undefined) delete scope.substitudeMacros;
    else scope.substitudeMacros = previous;
  }
}

function data(over = {}) {
  return {
    ...emptyMacroData(),
    demand: '把天枢阁总部位置写清楚',
    worldbook: '【天枢阁】总部在苍梧山',
    entries: '==== 天枢阁 ====\n总部在苍梧山',
    characters: '潮听澜：掌门',
    character_name: '潮听澜',
    portrait_meta: '1girl, white hair',
    history: '【用户】改一下',
    artifact: '{"characters":[]}',
    remaining: '还差一条',
    round: 3,
    has_image: true,
    ...over,
  };
}

test('macros: emptyMacroData 全空、round=0、has_image=false', () => {
  const empty = emptyMacroData();
  assert.equal(empty.demand, '');
  assert.equal(empty.round, 0);
  assert.equal(empty.has_image, false);
  assert.deepEqual(Object.keys(empty).length, 11, 'MacroData 有 11 个字段（{{截图}}/{{当前时间}} 是常量宏，不用字段）');
});

test('macros: 渲染顺序 = 先酒馆宏，再自定义宏（酒馆宏吐出的自定义宏也要被替换）', () => {
  const calls = [];
  const out = withStMacro(
    text => {
      calls.push(text);
      return text.replace(/\{\{roll\}\}/g, '7').replace('{{获取世界书}}', '世界书：{{世界书}}');
    },
    () => render('{{roll}} / {{获取世界书}} / {{用户需求}}', data()),
  );

  assert.equal(calls.length, 1, '酒馆宏引擎只该被调用一次，且拿到的是原始文本');
  assert.match(calls[0], /\{\{用户需求\}\}/, '自定义宏要留到第二步才换');
  assert.equal(out, '7 / 世界书：【天枢阁】总部在苍梧山 / 把天枢阁总部位置写清楚');
});

test('macros: 没挂酒馆宏引擎时原样透传，不影响自定义宏', () => {
  assert.equal(applyStMacros('{{roll}}'), '{{roll}}');
  assert.equal(render('{{roll}}-{{角色名}}', data()), '{{roll}}-潮听澜');
});

test('macros: 酒馆宏引擎抛错时原样返回（并 warn），不把整条消息弄丢', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  let out;
  try {
    out = withStMacro(
      () => {
        throw new Error('宿主宏引擎炸了');
      },
      () => render('A{{用户需求}}B', data()),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(out, 'A把天枢阁总部位置写清楚B');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /酒馆宏替换失败/);
});

test('macros: 自定义宏表按固定顺序替换 —— 先替换的键吐出的后键会被展开，后键吐出的先键保持字面量', () => {
  // 用户需求在表里排第一、世界书排第二：
  const forward = applyOwnMacros('{{用户需求}}', data({ demand: '{{世界书}}', worldbook: 'W' }));
  assert.equal(forward, 'W', '前键的值里带后键的宏 → 会被展开（一次渲染两步替换）');

  const backward = applyOwnMacros('{{世界书}}', data({ worldbook: '{{用户需求}}', demand: 'D' }));
  assert.equal(backward, '{{用户需求}}', '后键的值里带前键的宏 → 保持字面量（前键已经替换过了）');
});

test('macros: 底座自己的宏逐个替换；轮数/截图/当前时间 特殊处理', () => {
  // 阶段 3：角色列表 / 图片元数据 已移出底座（随苍玄助手插件走），
  // 它们改用 render() + 插件注册口验证，见下面那条用例。
  const text = [
    '{{用户需求}}', '{{世界书}}', '{{已选条目}}', '{{角色名}}',
    '{{上下文}}', '{{产物}}', '{{未完成}}', '{{轮数}}', '{{截图}}', '{{当前时间}}', '{{不存在的宏}}',
  ].join('|');
  const out = applyOwnMacros(text, data());
  const parts = out.split('|');
  assert.equal(parts[0], '把天枢阁总部位置写清楚');
  assert.equal(parts[1], '【天枢阁】总部在苍梧山');
  assert.equal(parts[2], '==== 天枢阁 ====\n总部在苍梧山');
  assert.equal(parts[3], '潮听澜');
  assert.equal(parts[4], '【用户】改一下');
  assert.equal(parts[5], '{"characters":[]}');
  assert.equal(parts[6], '还差一条');
  assert.equal(parts[7], '3');
  assert.equal(parts[8], '', '{{截图}} 现在恒为空串');
  assert.match(parts[9], /^\d{4}-\d{2}-\d{2}$/, '{{当前时间}} 是 YYYY-MM-DD');
  assert.equal(parts[10], '{{不存在的宏}}', '不认识的宏不动');
});

test('macros: 角色列表 / 图片元数据 归插件 —— 关掉插件退回空串（F-V1 回归闸）', () => {
  // 验收 F-V1 抓到的真 bug：底座曾在 applyOwnMacros 里硬编码这两个宏，无条件先替换，
  // 导致关掉苍玄助手后它们**泄漏真实数据**（而 图片提示词 因为是插件宏所以是对的）。
  // 现在三个宏都归插件，判据统一：名字在清单、renderer 不在 → 空串。
  const bag = { characters: '潮听澜：掌门', portrait_meta: '1girl, white hair' };
  registerPluginMacroNames(['图片提示词', '角色列表', '图片元数据']);

  // 插件关掉：三个都必须是空串，一个都不许泄漏
  registerPluginMacroSource(null);
  assert.equal(render('A{{角色列表}}B', bag), 'AB', '关掉插件 → 角色列表不许泄漏真值');
  assert.equal(render('A{{图片元数据}}B', bag), 'AB', '关掉插件 → 图片元数据不许泄漏真值');
  assert.equal(render('A{{图片提示词}}B', bag), 'AB');

  // 插件开着：拿得到真值
  registerPluginMacroSource((name: string) => {
    if (name === '角色列表') return bag.characters;
    if (name === '图片元数据') return bag.portrait_meta;
    return '';
  });
  assert.equal(render('{{角色列表}}', bag), '潮听澜：掌门');
  assert.equal(render('{{图片元数据}}', bag), '1girl, white hair');

  registerPluginMacroSource(null);
  registerPluginMacroNames([]);
});

test('macros: 同一宏出现多次全部替换；$& 之类的替换串特殊字符不引入', () => {
  const out = applyOwnMacros('{{角色名}}/{{角色名}}/{{用户需求}}', data({ demand: '$& $1' }));
  assert.equal(out, '潮听澜/潮听澜/$& $1', 'split/join 替换不会被 $& 影响');
});

test('macros: usedMacros 按 OUR_MACROS 顺序报出现过的宏', () => {
  assert.deepEqual(usedMacros('{{世界书}} 和 {{用户需求}} 和 {{世界书}}'), ['用户需求', '世界书']);
  assert.deepEqual(usedMacros('没有宏'), []);
  // 阶段 3：角色列表 / 图片元数据 已移出底座（改由苍玄助手插件贡献），12 → 10。
  assert.equal(OUR_MACROS.length, 10);
  assert.ok(OUR_MACROS.includes('当前时间'));
  assert.equal(OUR_MACROS.includes('角色列表'), false, '角色列表归 cangxuan 插件贡献');
  assert.equal(OUR_MACROS.includes('图片元数据'), false, '图片元数据归 cangxuan 插件贡献');
});

test('macros: 插件贡献的宏 —— 关插件退回空串，开插件用插件给的值（阶段 3）', () => {
  // 插件宏走「注册口」：core 不认识任何插件，plugins 侧注册进来（方向仍是 plugins → core）。
  registerPluginMacroNames(['图片提示词']);

  // 停用插件 = 没有 renderer；名字仍在清单里 → 必须渲染成空串（不是留下裸露占位符）。
  registerPluginMacroSource(null);
  assert.equal(render('A{{图片提示词}}B', emptyMacroData()), 'AB', '关掉插件 → 退回空串');

  // 插件开着 → 用插件给的值。
  registerPluginMacroSource(() => '1girl, white hair');
  assert.equal(render('A{{图片提示词}}B', emptyMacroData()), 'A1girl, white hairB');

  // 插件抛错也不能把整个渲染带崩。
  registerPluginMacroSource(() => {
    throw new Error('boom');
  });
  assert.equal(render('A{{图片提示词}}B', emptyMacroData()), 'AB', '插件宏渲染失败按空串处理');

  registerPluginMacroSource(null);
  registerPluginMacroNames([]);
});

test('macros: formatHistory 角色标签 / 工具卡 / limit 截断 / 空文本跳过', () => {
  const turns = [
    { id: 't1', role: 'user', text: '  第一条  ', images: [], calls: [], at: 1 },
    { id: 't2', role: 'assistant', text: '第二条', images: [], calls: [{ id: 'c1', name: 'wb_read', args: {}, ok: true, brief: '读了 1 条', detail: '', images: [], at: 2 }], at: 2 },
    { id: 't3', role: 'tool', text: '', images: [], calls: [], at: 3 },
    { id: 't4', role: 'user', text: '第四条', images: [], calls: [], at: 4 },
  ];
  const all = formatHistory(turns, 0);
  assert.equal(all, '【用户】第一条\n\n【助手】第二条\n\n【工具】wb_read → 读了 1 条\n\n【用户】第四条');
  const last2 = formatHistory(turns, 2);
  assert.equal(last2, '【用户】第四条', 'limit 只取最后 N 轮（空文本轮次不出行）');
  const last3 = formatHistory(turns, 3);
  assert.equal(last3, '【助手】第二条\n\n【工具】wb_read → 读了 1 条\n\n【用户】第四条');
});

test('macros: formatEntries 拼条目', () => {
  assert.equal(formatEntries([]), '');
  assert.equal(
    formatEntries([{ name: '甲', content: 'aaa' }, { name: '乙', content: 'bbb' }]),
    '==== 甲 ====\naaa\n\n==== 乙 ====\nbbb',
  );
});
