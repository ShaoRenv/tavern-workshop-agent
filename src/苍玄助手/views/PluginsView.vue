<template>
  <!-- 详情：整段让位（跟工具详情同一个做法），点「‹ 插件」回列表 -->
  <PluginDetail
    v-if="openDef"
    :def="openDef"
    :config="configBag(openDef.id)"
    :enabled="enabledOf(openDef)"
    :status="statusOf(openDef)"
    :skip="skipOf(openDef) ?? null"
    @back="openId = ''"
    @toggle="emit('toggle', openDef.id, $event)"
    @patch="emit('patch', openDef.id, $event)"
    @reset="emit('reset', openDef.id)"
    @goto="emit('goto', $event)"
  />

  <!-- 列表段：**只有列表**。一行一个插件，行尾 › 进这个插件自己的页面 -->
  <div v-else class="cx-body">
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">插件</span>
        <span class="cx-n">{{ PLUGIN_MANIFESTS.length }} 个 · 启用 {{ enabledCount }}</span>
        <span class="cx-spacer"></span>
      </div>
      <div class="cx-list">
        <div v-for="def in PLUGIN_MANIFESTS" :key="def.id" class="cx-toolrow" @click="openId = def.id">
          <div class="cx-toolrow-main">
            <div class="cx-toolrow-name">
              <span class="cx-tn2">{{ def.name }}</span>
              <span class="cx-tag" :class="statusOf(def).kind">{{ statusOf(def).label }}</span>
            </div>
            <!-- 行上就写清「它加了什么」（1 页 · 7 工具），省一次点击 -->
            <div class="cx-toolrow-desc">{{ whatItAdds(def) }}</div>
            <!--
              ★ 缺能力时**在行上**给一句人话原因（P4-12）。

              为什么非要在这一行说、而不是让用户点进详情看：
              「缺能力」只回答了「它能不能用」，没回答「缺什么、我该怎么办」——
              不说原因的话，这行和以前那句「已启用」一样对用户没用。
              点一下展开完整明细（含缺的接口名与 ST 原生对应），不用进详情页来回翻。
            -->
            <div v-if="skipOf(def)" class="cx-toolrow-desc">
              <span class="cx-warn-text" @click.stop="toggleReason(def.id)">
                {{ skipOf(def).reason }}
                <span class="cx-hint">{{ openReason === def.id ? '收起' : '详情' }}</span>
              </span>
              <pre v-if="openReason === def.id" class="cx-code cx-mt6" @click.stop>{{ skipOf(def).detail }}</pre>
            </div>
          </div>
          <Sw :model-value="enabledOf(def)" @update:model-value="emit('toggle', def.id, $event)" />
          <span class="cx-toolrow-go">›</span>
        </div>
      </div>
    </div>

    <!-- ==================== 外部插件（阶段 7） ==================== -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">外部插件</span>
        <span class="cx-n">{{ external.length }} 个 · 启用 {{ externalEnabledCount }}</span>
        <span class="cx-spacer"></span>
        <button class="cx-ghost" type="button" @click="installOpen = !installOpen">
          {{ installOpen ? '收起安装' : '＋ 安装' }}
        </button>
      </div>

      <!--
        ★ 安全口径（拍板：不做门禁，但这句必须写出来）。
        外部插件是**可执行代码**，与酒馆同权限；用户在装之前有权利知道这件事。
        放在安装入口**正上方**（而不是折叠区里 / 页脚），因为这是决策前该看到的信息。
      -->
      <p class="cx-ext-warn">
        装进来的代码是<b>全权执行</b>的 —— 它和酒馆同权限，能读写你的数据。<b>只装你信得过的来源。</b>
      </p>

      <!-- 安装入口（可折叠，默认收着：装插件是低频动作，不该占着列表的位置） -->
      <div v-if="installOpen" class="cx-ext-install">
        <div class="cx-f">
          <label class="cx-lab">从地址安装（插件包 .js 的直链）</label>
          <div class="cx-frow">
            <input
              v-model="urlDraft"
              type="text"
              class="cx-flex1"
              placeholder="https://example.com/my-plugin.js"
              @keydown.enter="installFromUrl"
            />
            <button class="cx-tiny" type="button" :disabled="!urlDraft.trim()" @click="installFromUrl">从 URL 安装</button>
          </div>
        </div>

        <div class="cx-f">
          <label class="cx-lab">或者直接粘贴插件代码</label>
          <textarea
            v-model="codeDraft"
            class="cx-grow cx-mono"
            placeholder="// 把插件包的 JS 贴进来"
            spellcheck="false"
          ></textarea>
          <button class="cx-tiny cx-mt6" type="button" :disabled="!codeDraft.trim()" @click="installFromPaste">
            安装这段代码
          </button>
        </div>

        <p class="cx-hint">
          装完自动启用。代码存成酒馆里的真文件，设置里只留路径与哈希 —— 所以卸载时记得两边都会清。
        </p>
      </div>

      <!-- 已装列表 -->
      <div class="cx-list">
        <div v-for="item in external" :key="item.id" class="cx-ext-row">
          <div class="cx-ext-main">
            <div class="cx-ext-name">
              <span class="cx-tn2">{{ item.name || item.id }}</span>
              <span v-if="item.version" class="cx-hint">v{{ item.version }}</span>
              <span class="cx-tag" :class="extStatus(item).kind">{{ extStatus(item).label }}</span>
            </div>
            <!-- 来源：URL 截断显示（整条长地址会把 375px 撑破） -->
            <div class="cx-ext-src" :title="item.origin || ''">{{ sourceLabel(item) }}</div>
            <!--
              装载失败时把 loader 给的原文显示出来。
              「装上了但跑不起来」是外部插件最常见的失败，只说「失败」用户无从下手。
            -->
            <pre v-if="item.last_error" class="cx-code cx-mt6 cx-ext-err">{{ item.last_error }}</pre>
          </div>
          <div class="cx-ext-acts">
            <Sw :model-value="enabledOf(item)" @update:model-value="emit('toggle', item.id, $event)" />
            <button class="cx-tiny dang" type="button" @click="uninstall(item)">卸载</button>
          </div>
        </div>
      </div>

      <p v-if="external.length === 0" class="cx-hint">还没有装外部插件。上面贴一个地址或一段代码就能装。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { RootDataSchema, type ExternalPlugin, type RootData } from '../core/types.ts';
import PluginDetail from '../components/PluginDetail.vue';
import Sw from '../components/Sw.vue';
import { PLUGIN_MANIFESTS, pluginCapabilitySkips, pluginEnabled, pluginStatusWithCapabilities } from '../plugins/registry.ts';
import type { PluginManifest } from '../plugins/types.ts';

/**
 * 插件页（能力页的第三段：工具｜技能｜插件）。**注册表驱动**：
 * 列表 / 状态 / 启停 / 设置了什么全部来自 plugins/registry.ts 的 PLUGIN_MANIFESTS 与聚合函数，
 * 界面不写死任何插件名、也不自己算「缺什么」。
 *
 * 这一页的规矩（设计稿 v2 / 设计自查 A7）：
 *  - **列表就是列表**：名字 · 状态 · 来源版本与「它加了什么」· 快捷开关 · ›，一行一件事，不给任何插件开小灶；
 *    页面上不放分工说明、不放「还没做」、不放某个插件的工具清单。
 *  - **点一行进这个插件自己的管理页**（PluginDetail）：头部 / 它加了什么 / 它自己的设置。
 *  - 为什么插件要单独一段：一个插件的设置（API Key / 模型 / 采样器）不是「某个工具的参数」，
 *    塞进工具详情的固定骨架会把它撑爆；工具段那边只保留「这个工具给模型看什么、能不能用」。
 *
 * 写路径唯一：这一页只 emit，数据由 App.vue 交给 store
 * （开关 → setPluginEnabled；设置 → setPluginConfig；恢复默认 → resetPluginConfig）。
 */
const props = withDefaults(defineProps<{ data?: RootData }>(), {
  data: () => RootDataSchema.parse({}),
});
const emit = defineEmits<{
  /** 插件开关：写 plugin_state（App.vue → store.setPluginEnabled） */
  toggle: [id: string, enabled: boolean];
  /** 插件自己的设置：写 plugins.<id>（App.vue → store.setPluginConfig，enabled 不走这条路） */
  patch: [id: string, patch: Record<string, unknown>];
  reset: [id: string];
  /** 「它加了什么」点一行跳过去（页面 id / 'capability'） */
  goto: [id: string];
  /**
   * 外部插件（阶段 7）：只 emit，装载由 App.vue → store 走 loader。
   * 结果提示（成功 / 失败）统一由 App.vue notify，这一页不做 toast。
   */
  'external-install-url': [{ url: string }];
  'external-install-paste': [{ code: string }];
  'external-uninstall': [{ id: string }];
}>();

const openId = ref('');

const openDef = computed<PluginManifest | null>(
  () => PLUGIN_MANIFESTS.find(item => item.id === openId.value) ?? null,
);

/** 这个插件自己那段设置（plugins 数据里的同名那一段）；没设置过就是空对象 */
function configBag(id: string): Record<string, unknown> {
  const bag = props.data.plugins as unknown as Record<string, Record<string, unknown> | undefined>;
  return bag[id] ?? {};
}

/** 开关的唯一读法：plugin_state 里有就听它的，没有就用 manifest.defaultEnabled */
function enabledOf(def: PluginManifest): boolean {
  return pluginEnabled(props.data, def.id);
}

/**
 * ★ 状态标签 = **装载裁决的口径**（未启用 > 缺能力 > 插件自己说的 > 已启用）。
 *
 * ⚠️ 这里用 `pluginStatusWithCapabilities` 而不是 `pluginStatus`（P4-12 修的就是这个）：
 * 后者**不看能力**，于是「插件被能力闸拦下、页面与工具全不出」时，列表行仍然显示「已启用」——
 * 界面替底层撒谎。同一个根因的另一面：这一页的 `whatItAdds()` 数的是 manifest 里声明的
 * 页数 / 工具数，**声明归声明**；缺能力时那些东西其实一个都没装载。
 *
 * 为什么把「探能力」的结果**算一次缓存起来**，而不是在模板里每行现算：
 * `pluginStatusWithCapabilities` 会调 `pluginCapabilitySkips()`，后者要遍历**全部**已启用插件、
 * 逐个现探能力（`evaluatePluginCapabilities`）。模板里 `statusOf(def)` 是**每行调一次**，
 * 于是 N 行 = N 次全表探测 —— O(N²)。
 *
 * 实测（4 个插件的当下）：`pluginStatus` 单次渲染 0.001ms，带能力的 0.216ms（约 200 倍）。
 * 4 个插件时绝对值仍很小，但**这是 O(N²) 的形状**：插件变多、或将来能力探测变重
 * （外部插件要真去探网络能力）就会变成可感的卡顿。所以用 computed 把它压成**每次数据变化只探一遍**。
 * （这也是当初没直接用它的合理顾虑 —— 现在用「算一次」把它解决了，而不是继续不用。）
 */
const skipById = computed(() => new Map(pluginCapabilitySkips(props.data).map(skip => [skip.id, skip])));

/** 这台是不是「开着但被能力闸拦下」（列表与详情共用同一份判据） */
function skipOf(def: PluginManifest) {
  return skipById.value.get(def.id);
}

function statusOf(def: PluginManifest): { label: string; kind: '' | 'ok' | 'warn' | 'dang' } {
  return pluginStatusWithCapabilities(props.data, def.id, configBag(def.id));
}

/**
 * 缺能力的**人话原因**（列表行上直接显示，点一下能看全部明细）。
 *
 * 为什么不只显示「缺能力」三个字：用户看到「缺能力」但不知道缺什么、更不知道怎么办 ——
 * 那和「已启用」一样没用。`skip.reason` 是装配期就算好的人话（含能力名），
 * `skip.detail` 是逐条明细（含缺的接口名与 ST 原生对应），两个都是现成的。
 */
const openReason = ref('');

function toggleReason(id: string): void {
  openReason.value = openReason.value === id ? '' : id;
}

/** 行上的「它加了什么」：内置 · v0.1 · 1 页 · 7 工具 */
function whatItAdds(def: PluginManifest): string {
  const parts = [def.builtin ? '内置' : '外部', 'v' + def.version];
  const pages = def.contributes.pages?.length ?? 0;
  const tools = def.contributes.tools?.length ?? 0;
  if (pages > 0) parts.push(pages + ' 页');
  if (tools > 0) parts.push(tools + ' 工具');
  if (pages === 0 && tools === 0) parts.push('没有贡献');
  return parts.join(' · ');
}

const enabledCount = computed(() => PLUGIN_MANIFESTS.filter(def => enabledOf(def)).length);

/* ==================== 外部插件（阶段 7） ==================== */

const external = computed(() => props.data.external_plugins);

/**
 * 外部插件的开关：**直接读 plugin_state，不能走 `pluginEnabled`**。
 *
 * ⚠️ 为什么（写这段时实测到的真炸点）：`pluginEnabled(state, id)` 在没有该 id 的 manifest 时
 * **直接 throw**（registry 的 `pluginManifest`：「没有这个插件：xxx」——那里是有意不静默的）。
 * 而外部插件最需要显示的状态恰恰是「**装载失败**」：代码下载/执行挂了 → manifest **没注册进 registry**
 * → `pluginEnabled` 抛错 → 整个插件段白屏，用户连卸载都点不到。
 * 所以这里只按底座的口径读数据（开关本来就归 plugin_state），不经过 registry 查表。
 *
 * 口径与 `pluginEnabled` 保持一致：plugin_state 里有就听它；没有则**默认开**
 * （外部插件是用户主动装的，装完默认启用；这也和 loader/App.vue 的接线一致）。
 */
function externalEnabled(item: ExternalPlugin): boolean {
  const hit = props.data.plugin_state?.[item.id];
  if (hit && typeof hit.enabled === 'boolean') return hit.enabled;
  return true;
}

const externalEnabledCount = computed(() => external.value.filter(item => externalEnabled(item)).length);

/**
 * 已装行的状态标签。优先级（题面钉死的）：
 *   **装载失败（红，带 last_error 原文）** > 未启用 > 已启用
 *
 * 为什么「装载失败」压在最上面：那一条的后果是「装上了但什么都用不了」，
 * 而开关看起来是开着的 —— 不压住的话界面会显示「已启用」，等于撒谎。
 */
function extStatus(item: ExternalPlugin): { label: string; kind: '' | 'ok' | 'warn' | 'dang' } {
  if (item.last_error) return { label: '装载失败', kind: 'dang' };
  if (!externalEnabled(item)) return { label: '未启用', kind: '' };
  /*
   * ⚠️ **缺能力也要在这里说**（独立验收抓到的口径分叉）。
   *
   * registry 里外部插件**同样要过能力闸**（`pluginCapabilitySkips` 走 allManifests）：
   * 它声明了某个必需能力而本机没有 → 它**不装载**（页面 / 工具 / 宏全都不出）。
   * 而这里原来只判 last_error / 开关 → 界面显示「已启用」，用户看不出为什么什么都没生效。
   *
   * 判据必须**复用 registry 的结论**，不在这里自己探一遍能力（那是第二份判断，迟早分叉）：
   * 拿已算好的 skip 表查（同内置插件那行用的是同一份 pluginCapabilitySkips）。
   */
  const skip = skipById.value.get(item.id);
  if (skip) return { label: '缺能力', kind: 'dang' };
  return { label: '已启用', kind: 'ok' };
}

/**
 * 来源那一行的显示文案。
 *
 * URL 来源**必须截断**：真实插件地址经常是一长串带 query 的直链，
 * 整条摊出来会把 375px 撑破（横向滚动是硬约束）。
 * 优先显示域名（用户认的是「从哪来的」），拿不到域名再退回截断的原文。
 * 完整原文挂在 title 上，鼠标悬停能看到。
 */
function sourceLabel(item: ExternalPlugin): string {
  if (item.source === 'paste') return '粘贴的代码';
  const origin = item.origin.trim();
  if (!origin) return '来源未知';
  try {
    const host = new URL(origin).host;
    if (host) return host + '（URL 安装）';
  } catch {
    // 不是合法 URL（老数据 / 手改过）→ 退回截断显示
  }
  return origin.length > 46 ? origin.slice(0, 46) + '…' : origin + '（URL 安装）';
}

/* ---------- 安装 ---------- */

/** 安装入口默认收着：装插件是低频动作，不该占着列表的位置 */
const installOpen = ref(false);
const urlDraft = ref('');
const codeDraft = ref('');

function installFromUrl(): void {
  const url = urlDraft.value.trim();
  if (!url) return;
  emit('external-install-url', { url });
  urlDraft.value = '';
}

function installFromPaste(): void {
  const code = codeDraft.value.trim();
  if (!code) return;
  emit('external-install-paste', { code });
  codeDraft.value = '';
}

/**
 * 卸载：二次确认。
 *
 * 文案说清两件会**真的消失**的东西（题面要求）：
 *   · 代码文件（存在酒馆的真文件里，不在设置里）
 *   · 它的设置（plugins.<id> 与 plugin_state 里那条）
 * 用 window.confirm —— 跟删预设 / 删备份同一个口径，不新造弹窗。
 */
function uninstall(item: ExternalPlugin): void {
  const name = item.name || item.id;
  const lines = [
    '卸载「' + name + '」？',
    '',
    '会删掉它的代码文件，以及它的全部设置。这个删了没法撤销。',
  ];
  if (!window.confirm(lines.join('\n'))) return;
  emit('external-uninstall', { id: item.id });
}
</script>