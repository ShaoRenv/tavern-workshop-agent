<template>
  <div ref="rootEl" class="cx-toolpage">
    <!-- 1 头部：名字 / 来源 / 版本 / 状态 + 启用开关（每个插件都一样） -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <button class="cx-back" type="button" @click="emit('back')">← 返回</button>
        <span class="cx-spacer"></span>
        <span class="cx-tag" :class="status.kind">{{ status.label }}</span>
      </div>
      <div class="cx-tpname">
        <span class="cx-tn2">{{ def.name }}</span>
        <span class="cx-tag">{{ def.builtin ? '内置' : '外部' }}</span>
        <span class="cx-tag">v{{ def.version }}</span>
      </div>
      <p class="cx-hint cx-mt6">{{ def.desc }}</p>
      <div class="cx-f cx-mt12">
        <div class="cx-frow">
          <span class="cx-sw-lab">启用</span>
          <Sw :model-value="enabled" @update:model-value="emit('toggle', $event)" />
        </div>
        <p class="cx-hint cx-mt6">关掉就完全不用它：它的页面与工具一起消失，模型也看不到。</p>
      </div>
    </div>

    <!-- 2 它加了什么：只放可点的跳转行（页面 / 工具），不写解释段落 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">它加了什么</span>
        <span class="cx-spacer"></span>
        <span class="cx-hint">点一行跳过去</span>
      </div>
      <div class="cx-list">
        <div v-for="page in pages" :key="page.id" class="cx-toolrow" @click="emit('goto', page.id)">
          <div class="cx-toolrow-main">
            <div class="cx-toolrow-name">
              <span class="cx-tn2">页面：{{ page.title }}</span>
              <span v-if="page.inTabbar === false" class="cx-tag">不上顶栏</span>
            </div>
          </div>
          <span class="cx-toolrow-go">›</span>
        </div>
        <div v-if="tools.length" class="cx-toolrow" @click="emit('goto', 'capability')">
          <div class="cx-toolrow-main">
            <div class="cx-toolrow-name">
              <span class="cx-tn2">工具：{{ tools.join(' / ') }}</span>
              <span class="cx-tag">{{ tools.length }} 个</span>
            </div>
          </div>
          <span class="cx-toolrow-go">›</span>
        </div>
      </div>
      <p v-if="pages.length === 0 && tools.length === 0" class="cx-hint">这个插件现在没往注册表里贡献东西。</p>
    </div>

    <!-- 3 它自己的设置：每个插件内容随它 —— 生图是一整页表单，别的插件现在没有自己的字段 -->
    <template v-if="isImage">
    <!-- 接口：怎么连生图服务 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">接口</span>
        <span class="cx-spacer"></span>
        <span class="cx-hint">连哪家 · 用哪个 Key</span>
      </div>

      <div class="cx-f">
        <span class="cx-lab">来源</span>
        <div class="cx-frow">
          <span class="cx-tag ok">{{ sourceLabel }}</span>
          <span class="cx-hint">先只做这一家；OpenAI 兼容 / SD WebUI 之类以后加在这</span>
        </div>
      </div>

      <div class="cx-f">
        <span class="cx-lab">API Key</span>
        <div class="cx-frow">
          <input
            v-model="form.api_key"
            :type="showKey ? 'text' : 'password'"
            placeholder="pst-…"
            autocomplete="off"
            spellcheck="false"
            @change="commit('api_key')"
          />
          <button class="cx-ghost" type="button" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
        </div>
        <p class="cx-hint cx-mt6">
          NovelAI 官网「Account → Persistent Token」拿，<span class="cx-code-i">pst-</span> 开头那条。
          它跟其它数据一起存在脚本变量里，导出会带上 —— 别把带 Key 的文件发给别人。
        </p>
      </div>

      <div class="cx-f">
        <span class="cx-lab">站点</span>
        <SegBar v-model="sitePick" variant="mode" :items="SITE_ITEMS" />
        <div v-if="form.site === 'proxy'" class="cx-mt10">
          <span class="cx-lab">反代 / 中转地址</span>
          <input
            v-model="form.site_url"
            type="text"
            placeholder="http://192.168.1.10:6969"
            spellcheck="false"
            @change="commit('site_url')"
          />
        </div>
        <p class="cx-hint cx-mt6">
          酒馆页面在浏览器里直连 NovelAI 官网大概率被 CORS 挡（跟网页打开别家站点一个道理）。
          被挡就选「反代」填自己的地址；协议 + 主机 + 端口即可，不必带路径。
        </p>
      </div>

      <div class="cx-f">
        <span class="cx-lab">模型</span>
        <select v-model="form.model" @change="commit('model')">
          <option v-for="item in NAI_MODELS" :key="item.value" :value="item.value">
            {{ item.label }}{{ item.note ? '（' + item.note + '）' : '' }}
          </option>
        </select>
        <p class="cx-hint cx-mt6">
          现在选的是 <span class="cx-code-i">{{ versionLabel }}</span>。
          有些字段只有新模型认（界面上标了版本），老模型收到会忽略或报错。
        </p>
      </div>
    </div>

    <!-- 提示词：固定词，跟模型每次给的 prompt 拼在一起 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">固定提示词</span>
        <span class="cx-n">{{ fixedChars }} 字</span>
        <span class="cx-spacer"></span>
        <span class="cx-hint">每张图都带上</span>
      </div>

      <div class="cx-f">
        <span class="cx-lab">固定正面（拼在最前）</span>
        <textarea
          v-model="form.prompt"
          class="cx-grow"
          rows="3"
          placeholder="例如：masterpiece, 1girl, cinematic lighting"
          spellcheck="false"
          @input="autoGrow"
          @change="commit('prompt')"
        ></textarea>
      </div>

      <div class="cx-f">
        <span class="cx-lab">后置固定正面（拼在最后）</span>
        <textarea
          v-model="form.prompt_end"
          class="cx-grow"
          rows="2"
          placeholder="例如：depth of field, film grain（画风 / 镜头这类）"
          spellcheck="false"
          @input="autoGrow"
          @change="commit('prompt_end')"
        ></textarea>
      </div>

      <div class="cx-f">
        <span class="cx-lab">固定负面（拼在下面那份负面预设后面）</span>
        <textarea
          v-model="form.negative"
          class="cx-grow"
          rows="3"
          placeholder="例如：extra fingers, watermark"
          spellcheck="false"
          @input="autoGrow"
          @change="commit('negative')"
        ></textarea>
      </div>

      <div class="cx-f">
        <div class="cx-frow">
          <span class="cx-sw-lab">追加官方质量词</span>
          <Sw :model-value="form.quality" @update:model-value="setBool('quality', $event)" />
        </div>
        <p class="cx-hint cx-mt6">
          开着会自动加上（各模型不一样）：<span class="cx-code-i">{{ qualityWordsFor(form.model) }}</span>
        </p>
      </div>

      <div class="cx-f">
        <span class="cx-lab">负面质量预设</span>
        <select v-model="form.uc_preset" @change="commit('uc_preset')">
          <option v-for="item in NAI_UC_PRESETS" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
        <p class="cx-hint cx-mt6">官方的内置负面词表，跟上面的「固定负面」是叠加的。</p>
      </div>
    </div>

    <!-- 生成参数 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">生成参数</span>
        <span class="cx-spacer"></span>
        <span class="cx-hint">模型给的 prompt 之外，画成什么样由这些定</span>
      </div>

      <div class="cx-f">
        <span class="cx-lab">采样方法</span>
        <select v-model="form.sampler" @change="commit('sampler')">
          <option v-for="item in NAI_SAMPLERS" :key="item.value" :value="item.value">
            {{ item.label }}{{ item.note ? '（' + item.note + '）' : '' }}
          </option>
        </select>
      </div>

      <div class="cx-f">
        <span class="cx-lab">噪点表</span>
        <select v-model="form.schedule" @change="commit('schedule')">
          <option v-for="item in NAI_SCHEDULES" :key="item.value" :value="item.value">
            {{ item.label }}{{ item.note ? '（' + item.note + '）' : '' }}
          </option>
        </select>
      </div>

      <div class="cx-f">
        <span class="cx-lab">生成步数</span>
        <input v-model.number="form.steps" type="number" min="1" max="50" step="1" @change="commitNumber('steps')" />
        <p class="cx-hint cx-mt6">1–50；28 左右够用，越高越慢越贵。</p>
      </div>

      <div class="cx-f">
        <span class="cx-lab">尺寸</span>
        <select v-model="sizePick">
          <option v-for="item in SIZE_ITEMS" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
        <div class="cx-frow cx-mt10">
          <input v-model.number="form.width" type="number" min="64" max="2048" step="64" @change="commitNumber('width')" />
          <span class="cx-hint cx-f0">×</span>
          <input v-model.number="form.height" type="number" min="64" max="2048" step="64" @change="commitNumber('height')" />
        </div>
        <p class="cx-hint cx-mt6">竖图立绘用 832×1216；宽高必须是 64 的整数倍。</p>
      </div>

      <div class="cx-f">
        <span class="cx-lab">种子</span>
        <input v-model.number="form.seed" type="number" min="0" step="1" @change="commitNumber('seed')" />
        <p class="cx-hint cx-mt6">0 = 每次随机；定住一个数就能复现同一张（prompt 也一样的前提下）。</p>
      </div>

      <div class="cx-f">
        <span class="cx-lab">Prompt Guidance</span>
        <input v-model.number="form.guidance" type="number" min="0" max="20" step="0.5" @change="commitNumber('guidance')" />
        <p class="cx-hint cx-mt6">越大越贴提示词，太大会发硬。v3 默认 11，v4 起常用 5。</p>
      </div>

      <div class="cx-f">
        <span class="cx-lab">Guidance Rescale</span>
        <input
          v-model.number="form.guidance_rescale"
          type="number"
          min="0"
          max="1"
          step="0.02"
          @change="commitNumber('guidance_rescale')"
        />
        <p class="cx-hint cx-mt6">0–1，v4 起才认；压一下高 Guidance 的过曝，一般 0。</p>
      </div>
    </div>

    <!-- 高级开关（只摆当前模型真的认的：v4 起的请求不带 sm / sm_dyn / dynamic_thresholding） -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">高级</span>
        <span class="cx-spacer"></span>
        <span class="cx-hint">先都按默认，画歪了再来动</span>
      </div>

      <template v-if="isV3">
        <div class="cx-f">
          <div class="cx-frow">
            <span class="cx-sw-lab">SMEA</span>
            <Sw :model-value="form.smea" @update:model-value="setBool('smea', $event)" />
          </div>
        </div>

        <div class="cx-f">
          <div class="cx-frow">
            <span class="cx-sw-lab">SMEA DYN</span>
            <Sw :model-value="form.smea_dyn" @update:model-value="setBool('smea_dyn', $event)" />
          </div>
          <p class="cx-hint cx-mt6">这两个是官方推荐的动态阈值组合，能少一堆畸形；SMEA DYN 要 SMEA 一起开。</p>
        </div>

        <div class="cx-f">
          <div class="cx-frow">
            <span class="cx-sw-lab">减少伪影（Decrisp）</span>
            <Sw :model-value="form.decrisp" @update:model-value="setBool('decrisp', $event)" />
          </div>
        </div>
      </template>

      <div class="cx-f">
        <div class="cx-frow">
          <span class="cx-sw-lab">多样性（Variety+）</span>
          <Sw :model-value="form.variety" @update:model-value="setBool('variety', $event)" />
        </div>
        <p class="cx-hint cx-mt6">开着会按尺寸算一个「放开高引导」的阈值（越大越松），少一点糊成一团。</p>
      </div>

      <div v-if="straightAlphaOk" class="cx-f">
        <div class="cx-frow">
          <span class="cx-sw-lab">透明背景</span>
          <Sw :model-value="form.straight_alpha" @update:model-value="setBool('straight_alpha', $event)" />
        </div>
        <p class="cx-hint cx-mt6">出 PNG 透明底，抠图省一步（只有 v5 的接口认这个字段）。</p>
      </div>

      <p v-if="!isV3" class="cx-hint cx-mt6">
        SMEA / SMEA DYN / 减少伪影 是 v3 的字段：v4 起的请求官方不带它们（换成 autoSmea），
        所以当前模型下不摆这几个开关 —— 想调就先把上面模型切回 v3。
      </p>
    </div>

    <!-- 出图：只有「一次最多几张」——这是插件的设置；出图结果在对话页里显示，插件页不做预览 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">出图</span>
        <span class="cx-spacer"></span>
        <span class="cx-hint">成本上限</span>
      </div>
      <div class="cx-f">
        <span class="cx-lab">一次最多几张</span>
        <input
          v-model.number="form.max_count"
          type="number"
          min="1"
          max="4"
          step="1"
          @change="commitNumber('max_count')"
        />
        <p class="cx-hint cx-mt6">模型一次调用最多能出几张（1–4）。生图按张收费，这是钱的上限。</p>
      </div>
    </div>

    <!-- 底部：恢复默认（只清这个插件的设置，不动开关） -->
    <div class="cx-foot">
      <button class="cx-fill dang" type="button" :disabled="!edited" @click="reset">恢复默认</button>
      <p class="cx-hint cx-mt8">恢复默认会把这一页的设置（含 API Key）全部清回内置默认值。</p>
    </div>
    </template>

    <!-- 非生图插件：这一版还没有自己的设置字段（阶段 4 起由插件声明、宿主渲染） -->
    <div v-else class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">它自己的设置</span>
        <span class="cx-spacer"></span>
      </div>
      <div class="cx-placeholder">{{ def.name }} 现在没有自己的设置：它的活都在上面那些页面与工具里。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';

import type { GenImageConfig } from '../core/types.ts';
import { IMAGE_SOURCE_LABELS } from '../core/types.ts';
import {
  NAI_MODELS,
  NAI_SAMPLERS,
  NAI_SCHEDULES,
  NAI_SIZES,
  NAI_UC_PRESETS,
  naiVersion,
  parseSize,
  qualityWordsFor,
  sizePresetOf,
  supportsStraightAlpha,
} from '../plugins/image/options.ts';
import type { PluginManifest, PluginStatus } from '../plugins/types.ts';
import SegBar from './SegBar.vue';
import Sw from './Sw.vue';
import type { SegItem } from './ui_types.ts';

/**
 * 插件管理页（设置 · 能力 · 插件 → ›）。**每个插件都是这三块**（设计稿屏 6）：
 *   1 头部（名字 / 来源 / 版本 / 状态 + 启用开关）
 *   2 它加了什么（页面 / 工具，点一行跳过去）—— 不写解释段落
 *   3 它自己的设置（生图是一整页表单；别的插件现在还没有自己的字段）
 *
 * **这一页只管这个插件自己的设置**，不放别的东西：
 *  - 它提供哪些工具 → 工具段（那是工具的库）
 *  - 模型现在能不能用它 → 能力页全局 + 预设，不在这页
 *  - 试画 / 结果预览 → 不在这里，出图在对话页里自然显示
 *  - 「还没做」的清单 → 不摆进界面（设计稿里列着就够了）
 *
 * 开关与设置是两条路（设计自查 A6 / §2.2）：enabled 存在 plugin_state 由底座拥有，
 * 这里只 emit('toggle')，不写进插件自己的设置；设置走本地草稿 + emit('patch')。
 * 写路径唯一（App.vue → store.setPluginEnabled / setPluginConfig / resetPluginConfig）。
 * 用本地草稿而不是 props 双向绑定，是因为打字不会被回写冲掉。
 */
const props = defineProps<{
  def: PluginManifest;
  /** 插件自己那段设置（只有生图有真 schema；别的插件现在不画表单） */
  config: GenImageConfig;
  /** 开关在 plugin_state 里（底座拥有），不从 config 里读 */
  enabled: boolean;
  /** 状态标签由插件自己算（plugins/registry.ts 的 pluginStatus），界面只画 */
  status: PluginStatus;
}>();
const emit = defineEmits<{
  back: [];
  /** 启用开关（写路径：App.vue → store.setPluginEnabled） */
  toggle: [enabled: boolean];
  patch: [patch: Record<string, unknown>];
  reset: [];
  /** 「它加了什么」点一行跳过去（页面 id / 'capability'） */
  goto: [id: string];
}>();

/** 只有生图插件现在有自己的一整页设置；别的插件只画「头部 + 它加了什么」 */
const isImage = computed(() => props.def.id === 'image');

/** 它加了什么：页面行 + 工具行（都来自 manifest 的 contributes） */
const pages = computed(() => props.def.contributes.pages ?? []);
/** contributes.tools 是 PluginToolRef[]（阶段 1 改的）：界面只显示名字 */
const tools = computed(() => (props.def.contributes.tools ?? []).map(ref => ref.name));

type NumKey = 'steps' | 'width' | 'height' | 'seed' | 'guidance' | 'guidance_rescale' | 'max_count';
type BoolKey = 'quality' | 'smea' | 'smea_dyn' | 'variety' | 'decrisp' | 'straight_alpha';

const NUM_RANGES: Record<NumKey, [number, number]> = {
  steps: [1, 50],
  width: [64, 2048],
  height: [64, 2048],
  seed: [0, 4294967295],
  guidance: [0, 20],
  guidance_rescale: [0, 1],
  max_count: [1, 4],
};

const SITE_ITEMS: SegItem[] = [
  { value: 'official', label: '官网直连' },
  { value: 'proxy', label: '反代 / 中转' },
];

const SIZE_ITEMS: SegItem[] = [
  ...NAI_SIZES.map(item => ({ value: item.value, label: item.label })),
  { value: 'custom', label: '自定义（下面填宽高）' },
];

const rootEl = ref<HTMLElement | null>(null);
const showKey = ref(false);

/** 本地草稿：props 变了（恢复默认 / 换插件）才重新播种 */
const form = reactive<GenImageConfig>({ ...props.config });
watch(
  () => props.config,
  next => {
    Object.assign(form, next);
    void nextTick(growAll);
  },
  { deep: true },
);

/* ---------- 提交 ---------- */

function commit<K extends keyof GenImageConfig>(key: K): void {
  emit('patch', { [key]: form[key] } as Record<string, unknown>);
}

function setBool(key: BoolKey, value: boolean): void {
  // 透明背景只有 v4.5 / v5 认：老模型上点它没意义，直接不动（不摆一个假控件）
  if (key === 'straight_alpha' && !straightAlphaOk.value) return;
  form[key] = value;
  commit(key);
}

function commitNumber(key: NumKey): void {
  const range = NUM_RANGES[key];
  const raw = Number(form[key]);
  const fallback = Number(props.config[key]);
  let value = Number.isFinite(raw) ? raw : fallback;
  if (!Number.isFinite(value)) value = range[0];
  if (key !== 'guidance' && key !== 'guidance_rescale') value = Math.round(value);
  value = Math.min(range[1], Math.max(range[0], value));
  form[key] = value;
  commit(key);
}

function reset(): void {
  if (!confirm('把「' + props.def.name + '」的设置全部恢复成内置默认？（含 API Key）')) return;
  emit('reset');
}

/* ---------- 尺寸预设 ---------- */

const sizePick = computed({
  get: () => sizePresetOf(form.width, form.height) || 'custom',
  set: (value: string) => {
    const size = parseSize(value);
    if (!size) return;
    form.width = size.width;
    form.height = size.height;
    emit('patch', { width: size.width, height: size.height });
  },
});

/* ---------- 只读派生 ---------- */

const version = computed(() => naiVersion(form.model));
const versionLabel = computed(() => (version.value ? version.value : '不认识的模型名'));
/** v3 才有的那几个开关（v4 起的请求不带 sm / sm_dyn / dynamic_thresholding） */
const isV3 = computed(() => version.value === 'v3');
const straightAlphaOk = computed(() => supportsStraightAlpha(version.value));
const sourceLabel = computed(() => IMAGE_SOURCE_LABELS[form.source] ?? form.source);

const fixedChars = computed(() => form.prompt.length + form.prompt_end.length + form.negative.length);

const edited = computed(() => JSON.stringify(form) !== JSON.stringify(props.config));

/* ---------- 提示词框自动增高（不做内嵌小滚动区） ---------- */

function autoGrow(event: Event): void {
  const el = event.target as HTMLTextAreaElement | null;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function growAll(): void {
  const root = rootEl.value;
  if (!root) return;
  root.querySelectorAll('textarea').forEach(node => {
    node.style.height = 'auto';
    node.style.height = node.scrollHeight + 'px';
  });
}
</script>
