/**
 * 生图插件（NovelAI）验收：
 *  - 请求组装按模型版本分叉（v3 / v4 / v4.5 / v5 的 parameters 是三套形状）
 *  - 提示词拼接、反代地址、多样性阈值、种子
 *  - 响应解析：ZIP（deflate / stored 两种）+ JSON + 裸 base64
 *  - generateImages 的错误翻译（未启用 / 401 / CORS）
 *  - 插件状态与「插件开着 → 工具进全局能力」
 *  - store：setPluginConfig 合并落盘、resetPluginConfig 回默认
 *
 * 请求形状的依据：reports/苍玄助手-生图参考-nai.md（读 st-chatu8 打包产物得来，带行号）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';

const root = '../../src/苍玄助手/';
const { RootDataSchema, GenImageConfigSchema } = await import(root + 'core/types.ts');
const { GLOBAL_KEY } = await import(root + 'core/types.ts');
const { setHostBridge } = await import(root + 'core/storage.ts');
const { useAppStore } = await import(root + 'stores/app.ts');
const {
  planNaiRequest,
  buildPrompts,
  naiEndpoint,
  skipCfgAboveSigma,
  pickSeed,
  ucPresetOf,
  unzipFirstEntryBase64,
  toDataUrl,
  parseImageResponse,
  imagesFromJson,
  describeStatus,
  generateImages,
  NAI_OFFICIAL_ENDPOINT,
} = await import(root + 'plugins/builtin/image/nai.ts');
const { qualityWordsFor, naiVersion, supportsStraightAlpha } = await import(root + 'plugins/builtin/image/options.ts');
const { pluginEnabled, pluginTools, pluginAllTools, pluginStatus } = await import(root + 'plugins/registry.ts');

/**
 * 造一份配置（默认全齐，随用例覆盖）。
 * ⚠️ 插件开关**不在这份配置里**（v5 起是底座的 plugin_state.image.enabled）——
 * 以前那个 enabled 字段已经被 GenImageConfigSchema 删掉，写进来也会被 zod 剥掉。
 */
function config(over = {}) {
  return GenImageConfigSchema.parse({ api_key: 'pst-test', ...over });
}

/** 插件开关状态（注册表函数只依赖 plugin_state 那一小块） */
function switched(enabled) {
  return { plugin_state: { image: { enabled } } };
}

/** 手搓一个最小的 ZIP（单条目），用来喂解压逻辑 */
function makeZip(name, payload, method = 8) {
  const data = method === 8 ? deflateRawSync(payload) : payload;
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localFull = Buffer.concat([local, nameBuf, data]);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(payload.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdFull = Buffer.concat([cd, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdFull.length, 12);
  eocd.writeUInt32LE(localFull.length, 16);
  const all = Buffer.concat([localFull, cdFull, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

function responseOf(body, type) {
  return new Response(body, { headers: { 'content-type': type } });
}

/* ==================== 数据模型 ==================== */

test('插件配置：RootDataSchema.parse({}) 补齐默认值，缺字段不炸；开关不在插件设置里', () => {
  const data = RootDataSchema.parse({});
  const cfg = data.plugins.image;
  assert.equal('enabled' in cfg, false, 'v5：开关搬去 plugin_state，插件设置里不该再有 enabled');
  assert.deepEqual(data.plugin_state, {}, '缺省空表 → 按 manifest.defaultEnabled 现算');
  assert.equal(pluginEnabled(data, 'image'), false, '默认不启用（不配 Key 就别开会乱发请求）');
  assert.equal(cfg.source, 'novelai');
  assert.equal(cfg.model, 'nai-diffusion-4-5-full');
  assert.equal(cfg.sampler, 'k_euler_ancestral');
  assert.equal(cfg.steps, 28);
  assert.equal(cfg.width, 832);
  assert.equal(cfg.height, 1216);
  assert.equal(cfg.seed, 0);
  assert.equal(cfg.max_count, 1);
  assert.equal(cfg.uc_preset, 'heavy');
  assert.equal(cfg.api_key, '');
});

test('插件配置：坏值被 schema 挡住（步数 0 / 张数 9 / 未知负面预设）', () => {
  assert.equal(GenImageConfigSchema.safeParse({ steps: 0 }).success, false);
  assert.equal(GenImageConfigSchema.safeParse({ max_count: 9 }).success, false);
  assert.equal(GenImageConfigSchema.safeParse({ uc_preset: '狂重' }).success, false);
  assert.equal(GenImageConfigSchema.safeParse({ guidance_rescale: 2 }).success, false);
});

test('插件状态与工具归属：开关在 plugin_state；关着就没有 gen_image，开着缺 Key 算没配好', () => {
  // 关掉 = 底座根本不给这个工具（守卫不在 generateImages 里，见下面的源码级用例）
  assert.equal(pluginTools(switched(false)).includes('gen_image'), false);
  assert.equal(pluginTools({}).includes('gen_image'), false, '生图 manifest.defaultEnabled=false');
  // ⚠️ 阶段 3 的口径：「插件开着 = 它注册了」≠「它默认给模型」。
  // gen_image 的 default_on 一直是 false（要发得在预设里显式勾），
  // 所以它进 pluginAllTools（注册清单 / 界面），但**不进** pluginTools（默认进全局能力）。
  assert.equal(pluginAllTools(switched(true)).includes('gen_image'), true, '开着 → 注册了');
  assert.equal(pluginTools(switched(true)).includes('gen_image'), false, '但它 default_on:false，不进默认能力');
  assert.equal(pluginAllTools(switched(false)).includes('gen_image'), false, '关掉 → 连注册清单都没有（关掉即消失）');
  // 它是 image 插件唯一贡献的工具 → 开着时注册清单末尾就是它
  assert.deepEqual(pluginAllTools(switched(true)).slice(-1), ['gen_image']);

  // 状态：未启用 > 插件自己说的（缺配置）> 已启用
  assert.equal(pluginStatus(switched(false), 'image', config()).label, '未启用');
  assert.equal(pluginStatus(switched(true), 'image', config({ api_key: '  ' })).label, '缺 API Key');
  assert.equal(pluginStatus(switched(true), 'image', config({ site: 'proxy', site_url: ' ' })).label, '缺反代地址');
  assert.equal(pluginStatus(switched(true), 'image', config()).label, '已启用');
});

/* ==================== 版本判定与选项 ==================== */

test('模型名 → 版本；透明背景只有 v5 认', () => {
  assert.equal(naiVersion('nai-diffusion-3'), 'v3');
  assert.equal(naiVersion('nai-diffusion-4-full'), 'v4');
  assert.equal(naiVersion('nai-diffusion-4-5-full'), 'v4.5');
  assert.equal(naiVersion('nai-diffusion-5-curated'), 'v5');
  assert.equal(naiVersion('sd-xl'), '');
  assert.equal(supportsStraightAlpha('v5'), true);
  assert.equal(supportsStraightAlpha('v4.5'), false);
});

test('质量词按模型给（照 st-chatu8 的 AQT 映射），认不出来回落到老那串', () => {
  assert.equal(qualityWordsFor('nai-diffusion-3'), 'best quality, amazing quality, very aesthetic, absurdres');
  assert.equal(qualityWordsFor('nai-diffusion-4-5-full'), 'very aesthetic, masterpiece, no text');
  assert.equal(qualityWordsFor('不知道'), 'best quality, amazing quality, very aesthetic, absurdres');
});

/* ==================== 请求组装 ==================== */

test('提示词拼接顺序：固定正面 → 模型 prompt → 后置固定正面 → 质量词；负面前后相接', () => {
  const words = buildPrompts(
    config({ prompt: 'masterpiece', prompt_end: 'film grain', negative: 'watermark', model: 'nai-diffusion-4-5-full' }),
    '1girl, kimono',
    'extra fingers',
  );
  assert.equal(words.positive, 'masterpiece, 1girl, kimono, film grain, very aesthetic, masterpiece, no text');
  assert.equal(words.negative, 'watermark, extra fingers');
});

test('质量词关掉就不追加；空段不留下多余逗号', () => {
  const words = buildPrompts(config({ quality: false, prompt: '', prompt_end: '' }), '  cat  ', '');
  assert.equal(words.positive, 'cat');
  assert.equal(words.negative, '');
});

test('接口地址：官网默认；反代地址补 /ai/generate-image；已经是完整地址就不重复补', () => {
  assert.equal(naiEndpoint(config()), NAI_OFFICIAL_ENDPOINT);
  assert.equal(naiEndpoint(config({ site: 'proxy', site_url: 'http://127.0.0.1:6969/' })), 'http://127.0.0.1:6969/ai/generate-image');
  assert.equal(naiEndpoint(config({ site: 'proxy', site_url: 'http://x/y/ai/generate-image' })), 'http://x/y/ai/generate-image');
  assert.equal(naiEndpoint(config({ site: 'proxy', site_url: '' })), NAI_OFFICIAL_ENDPOINT, '反代没填就回官网');
});

test('v3 的 parameters：sm / sm_dyn / dynamic_thresholding，不带 v4 那套', () => {
  const plan = planNaiRequest(config({ model: 'nai-diffusion-3', smea: true, smea_dyn: true, decrisp: true }), 'cat', 'dog');
  const params = plan.body.parameters;
  assert.equal(plan.url, NAI_OFFICIAL_ENDPOINT);
  assert.equal(plan.headers.Authorization, 'Bearer pst-test');
  assert.equal(plan.body.model, 'nai-diffusion-3');
  assert.equal(plan.body.action, 'generate');
  assert.equal(plan.body.input, 'cat, best quality, amazing quality, very aesthetic, absurdres');
  assert.equal(params.params_version, 3);
  assert.equal(params.sm, true);
  assert.equal(params.sm_dyn, true);
  assert.equal(params.dynamic_thresholding, true);
  assert.equal(params.n_samples, 1);
  assert.equal(params.negative_prompt, 'dog');
  assert.equal(params.v4_prompt, undefined, 'v3 不带 v4_prompt');
  assert.equal(params.autoSmea, undefined);
  assert.equal(params.straight_alpha, undefined);
});

test('SMEA DYN 依赖 SMEA：SMEA 关着就不发 sm_dyn', () => {
  const params = planNaiRequest(config({ model: 'nai-diffusion-3', smea: false, smea_dyn: true }), 'cat', '').body.parameters;
  assert.equal(params.sm, false);
  assert.equal(params.sm_dyn, false);
});

test('v4.5 的 parameters：autoSmea + v4_prompt/v4_negative_prompt + characterPrompts，不带 sm', () => {
  const params = planNaiRequest(config({ model: 'nai-diffusion-4-5-full', guidance: 5 }), 'cat', 'dog').body.parameters;
  assert.equal(params.params_version, 3);
  assert.equal(params.autoSmea, false);
  assert.equal(params.inpaintImg2ImgStrength, 1);
  assert.equal(params.sm, undefined, 'v4 起不发 sm');
  assert.equal(params.sm_dyn, undefined);
  assert.equal(params.dynamic_thresholding, false);
  assert.deepEqual(params.characterPrompts, []);
  assert.deepEqual(params.v4_prompt, {
    caption: { base_caption: 'cat, very aesthetic, masterpiece, no text', char_captions: [] },
    use_coords: false,
    use_order: true,
  });
  assert.equal(params.v4_negative_prompt.caption.base_caption, 'dog');
  assert.equal(params.straight_alpha, undefined, 'v4.5 不发透明背景');
  assert.equal(params.use_coords, false);
});

test('v5：params_version=4、带 tag_hint/透明背景、ddim_v3 换成 Euler Ancestral', () => {
  const params = planNaiRequest(
    config({ model: 'nai-diffusion-5-full', sampler: 'ddim_v3', straight_alpha: true }),
    'cat',
    '',
  ).body.parameters;
  assert.equal(params.params_version, 4);
  assert.equal(params.sampler, 'k_euler_ancestral');
  assert.equal(params.straight_alpha, true);
  assert.equal(params.tag_hint_qt, 1);
  assert.equal(params.tag_hint_uc_preset, 0);
});

test('多样性：开着才发 skip_cfg_above_sigma，值按像素数缩放（4.5 用 58 那个魔数）', () => {
  const on = planNaiRequest(config({ model: 'nai-diffusion-4-5-full', variety: true, width: 832, height: 1216 }), 'c', '').body.parameters;
  const off = planNaiRequest(config({ variety: false }), 'c', '').body.parameters;
  assert.equal(off.skip_cfg_above_sigma, undefined);
  assert.equal(on.skip_cfg_above_sigma, skipCfgAboveSigma(832, 1216, 'v4.5'));
  assert.ok(skipCfgAboveSigma(1024, 1024, 'v4.5') > skipCfgAboveSigma(512, 512, 'v4.5'), '图越大阈值越高');
  assert.ok(skipCfgAboveSigma(832, 1216, 'v4.5') > skipCfgAboveSigma(832, 1216, 'v4'), '4.5 的魔数更大');
});

test('Euler Ancestral 带上官方那两条补丁；其它采样器不带', () => {
  const ea = planNaiRequest(config({ sampler: 'k_euler_ancestral' }), 'c', '').body.parameters;
  const eu = planNaiRequest(config({ sampler: 'k_euler' }), 'c', '').body.parameters;
  assert.equal(ea.deliberate_euler_ancestral_bug, false);
  assert.equal(ea.prefer_brownian, true);
  assert.equal(eu.prefer_brownian, undefined);
});

test('种子：0 = 随机、给了就用给的、options.seed 能盖住（测试与复现用）', () => {
  const random = () => 0.5;
  assert.equal(pickSeed(config({ seed: 0 }), random), Math.floor(0.5 * 4294967295));
  assert.equal(pickSeed(config({ seed: 12345 }), random), 12345);
  assert.equal(planNaiRequest(config({ seed: 0 }), 'c', '', { seed: 777 }).body.parameters.seed, 777);
  const first = planNaiRequest(config({ seed: 0 }), 'c', '', { random }).body.parameters.seed;
  const second = planNaiRequest(config({ seed: 0 }), 'c', '', { random }).body.parameters.seed;
  assert.equal(first, second, '同一个随机源 → 同一个种子（可复现）');
});

test('没填 Key 直接抛，别发一个注定 401 的请求', () => {
  assert.throws(() => planNaiRequest(config({ api_key: '   ' }), 'c', ''), /API Key/);
});

test('ucPreset 映射：重=0、轻=1、人像=2、不用=3', () => {
  assert.equal(ucPresetOf(config({ uc_preset: 'heavy' })), 0);
  assert.equal(ucPresetOf(config({ uc_preset: 'light' })), 1);
  assert.equal(ucPresetOf(config({ uc_preset: 'human' })), 2);
  assert.equal(ucPresetOf(config({ uc_preset: 'none' })), 3);
});

/* ==================== 响应解析 ==================== */

test('ZIP（deflate）解出第一张图', async () => {
  const png = Buffer.from('假装这是 PNG 的字节'.repeat(20), 'utf8');
  const base64 = await unzipFirstEntryBase64(makeZip('image_0.png', png, 8));
  assert.equal(base64, png.toString('base64'));
});

test('ZIP（stored，不压缩）也一样能解', async () => {
  const png = Buffer.from('stored payload');
  assert.equal(await unzipFirstEntryBase64(makeZip('image_0.png', png, 0)), png.toString('base64'));
});

test('不是 ZIP 就说清楚，别默默返回空', async () => {
  await assert.rejects(() => unzipFirstEntryBase64(new Uint8Array([1, 2, 3, 4]).buffer), /ZIP/);
});

test('toDataUrl：裸 base64 补前缀，已经是 dataURL 就不动', () => {
  assert.equal(toDataUrl('AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(toDataUrl('data:image/webp;base64,BBBB'), 'data:image/webp;base64,BBBB');
  assert.equal(toDataUrl('  '), '');
});

test('imagesFromJson：images[] / image / data / 裸数组都能抠出来', () => {
  assert.deepEqual(imagesFromJson({ images: ['a', 'b'] }), ['data:image/png;base64,a', 'data:image/png;base64,b']);
  assert.deepEqual(imagesFromJson({ image: 'c' }), ['data:image/png;base64,c']);
  assert.deepEqual(imagesFromJson({ data: { data: 'd' } }), ['data:image/png;base64,d']);
  assert.deepEqual(imagesFromJson(['e']), ['data:image/png;base64,e']);
  assert.deepEqual(imagesFromJson({ nope: 1 }), []);
});

test('parseImageResponse：直连回 ZIP、反代回 JSON、偶发裸 base64 都能吃', async () => {
  const png = Buffer.from('图片字节'.repeat(10));
  const fromZip = await parseImageResponse(responseOf(makeZip('image_0.png', png, 8), 'application/zip'));
  assert.deepEqual(fromZip, ['data:image/png;base64,' + png.toString('base64')]);
  const fromJson = await parseImageResponse(responseOf(JSON.stringify({ images: ['xx'] }), 'application/json'));
  assert.deepEqual(fromJson, ['data:image/png;base64,xx']);
  const rawBase64 = 'A'.repeat(80);
  const fromRaw = await parseImageResponse(responseOf(rawBase64, 'text/plain'));
  assert.deepEqual(fromRaw, ['data:image/png;base64,' + rawBase64]);
});

test('HTTP 状态翻译成人话', () => {
  assert.equal(describeStatus(401, ''), 'API Key 错误或失效（401）。');
  assert.match(describeStatus(402, ''), /订阅/);
  assert.match(describeStatus(400, '{"message":"bad prompt"}'), /bad prompt/);
  assert.match(describeStatus(500, 'boom'), /500/);
});

/* ==================== 发请求 ==================== */

test('generateImages：成功时把 ZIP 变成 dataURL 数组，带上正确的头和 body', async () => {
  const png = Buffer.from('真·图'.repeat(50));
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    return responseOf(makeZip('image_0.png', png, 8), 'application/zip');
  };
  const images = await generateImages(config(), 'a cat', 'bad hands', { fetchImpl: fake });
  assert.equal(images.length, 1);
  assert.match(images[0], /^data:image\/png;base64,/);
  assert.equal(calls[0].url, NAI_OFFICIAL_ENDPOINT);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer pst-test');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.action, 'generate');
  assert.equal(sent.parameters.negative_prompt, 'bad hands');
});

test('generateImages：没填 Key 就报清楚的原因（开关不归它管）', async () => {
  await assert.rejects(() => generateImages(config({ api_key: '' }), 'a', ''), /API Key/);
  await assert.rejects(() => generateImages(config({ api_key: '   ' }), 'a', ''), /API Key/);
});

test('源码级：关插件时没有 gen_image，也没有生图器 —— 守卫在来源处，不在 generateImages 里', () => {
  // 1) nai.ts 不再读任何 enabled：插件关着时由底座不提供 gen_image（pluginTools 不含它），
  //    模型压根调不到这个工具，所以这一层不需要再判一次。
  const nai = readFileSync('src/苍玄助手/plugins/builtin/image/nai.ts', 'utf8');
  assert.equal(/\benabled\b/.test(nai), false, 'nai.ts 里不该再出现 enabled（配置是配置，开关是开关）');

  // 2) App.vue：插件工具清单来自注册表（关插件即消失），生图器注册受插件开关门控
  const app = readFileSync('src/苍玄助手/App.vue', 'utf8');
  assert.equal(app.includes('imagePluginTools'), false, '旧的无条件接线必须删掉');
  assert.equal(app.includes('plugins.image.enabled'), false, '开关不许从插件设置里读（在 plugin_state）');
  assert.match(app, /pluginToolsOf\(store\.data\)/, '全局能力里的插件工具来自注册表');
  assert.match(app, /pluginEnabled\('image'\)/, '生图器要受插件开关门控');
  const genImageLines = app.split('\n').filter(line => /genImage\s*:/.test(line));
  assert.ok(genImageLines.length >= 1, 'runAgent 要注入生图器');
  for (const line of genImageLines) {
    assert.match(line, /imageOn|pluginEnabled\('image'\)/, '生图器必须按插件开关注册：' + line.trim());
  }
  assert.equal(/genImage:\s*makeImageGen\(\),/.test(app), false, '不许无条件注册生图器');
});

test('generateImages：401 与 CORS（TypeError）分别给出可操作的提示', async () => {
  await assert.rejects(
    () => generateImages(config(), 'a', '', { fetchImpl: async () => new Response('nope', { status: 401 }) }),
    /401/,
  );
  await assert.rejects(
    () =>
      generateImages(config(), 'a', '', {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    /CORS/,
  );
});

test('generateImages：200 但里面没图也算失败，不能静默', async () => {
  await assert.rejects(() => generateImages(config(), 'a', '', { fetchImpl: async () => responseOf('', 'application/json') }), /没有图/);
});

/* ==================== store ==================== */

function freshStore() {
  const writes = [];
  setHostBridge({ insertOrAssignVariables: (payload) => writes.push(payload) });
  setActivePinia(createPinia());
  const store = useAppStore();
  store.load();
  return { store, writes };
}

test('store.setPluginConfig：合并进已有配置并落盘（不是整块替换）', () => {
  const { store, writes } = freshStore();
  store.setPluginConfig('image', { api_key: 'pst-abc' });
  store.setPluginConfig('image', { steps: 33 });
  const cfg = store.data.plugins.image;
  assert.equal('enabled' in cfg, false, '插件设置里不出现 enabled（开关在 plugin_state）');
  assert.equal(cfg.api_key, 'pst-abc', '前一次写的字段还在');
  assert.equal(cfg.steps, 33);
  // 保存是 2.5 秒防抖的：这里显式冲一次，验证写进去的就是上面那份
  store.save(true);
  assert.ok(writes.length >= 1, '改完能落盘');
  assert.equal(writes[writes.length - 1][GLOBAL_KEY].plugins.image.steps, 33);
  assert.equal(writes[writes.length - 1][GLOBAL_KEY].plugins.image.api_key, 'pst-abc');
});

test('store.setPluginConfig：显式 undefined 的字段不写进去，enabled 键被忽略', () => {
  const { store } = freshStore();
  store.setPluginConfig('image', { api_key: 'pst-abc' });
  store.setPluginConfig('image', { api_key: undefined });
  assert.equal(store.data.plugins.image.api_key, 'pst-abc');
  // 开关只有一个写点：setPluginEnabled（这里是开着，塞 enabled:false 也不许改）
  store.setPluginEnabled('image', true);
  store.setPluginConfig('image', { enabled: false });
  assert.equal(store.pluginEnabled('image'), true, 'setPluginConfig 不许改开关');
  assert.equal('enabled' in store.data.plugins.image, false);
});

test('store.resetPluginConfig：整块回内置默认（只清设置，开关留给 setPluginEnabled）', () => {
  const { store } = freshStore();
  store.setPluginEnabled('image', true);
  store.setPluginConfig('image', { api_key: 'pst-abc', steps: 40 });
  store.resetPluginConfig('image');
  const cfg = store.data.plugins.image;
  assert.equal(store.pluginEnabled('image'), true, 'resetPluginConfig 不动开关');
  assert.equal('enabled' in cfg, false);
  assert.equal(cfg.api_key, '');
  assert.equal(cfg.steps, 28);
});