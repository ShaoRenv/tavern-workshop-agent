<template>
  <AppShell :pages="pages" :tab="tab" :status="status" @update:tab="store.setTab($event)">
    <!-- 阶段 3：苍玄助手插件不再带页面（顶栏收成 3 格：对话 / 世界书 / 设置）。
         它的宏与工具照常由插件贡献，运行时门禁见 run/runner.ts 的 liveToolDefs。 -->
    <!-- 页面级错误边界：某个插件内容页抛错时，只把这一页换成提示，面板整体照常可用 -->
    <div v-if="pageError" class="cx-body">
      <div class="cx-blk">
        <div class="cx-blkh"><span class="cx-t">这个页面出错了</span></div>
        <p class="cx-hint">「{{ tab }}」渲染时抛了异常，其他页面不受影响。可以切走再切回来，或看控制台了解详情。</p>
        <pre class="cx-code">{{ pageError }}</pre>
      </div>
    </div>
    <WorldbookView
      v-else-if="tab === 'worldbook'"
      :data="store.data"
      :worlds="worlds"
      :entries="entries"
      @goto-chat="goto('chat')"
      @change="store.save()"
    />
    <ChatView
      v-else-if="tab === 'chat'"
      :data="store.data"
      :assistant-name="ASSISTANT_NAME"
      @send="onSend"
      @stop="onStop"
      @attach="onAttach"
      @save-drafts="onSaveDrafts"
      @export-drafts="onExportDrafts"
      @retry-image="onRetryImage"
      @session-action="onSessionAction"
      @preset-change="onPresetChange"
      @mode-change="store.setMode($event)"
    />
    <!-- 设置：接口｜预设｜能力｜数据。「能力」里三段 工具｜技能｜插件（CapabilityView 在里面），
         工具覆盖项 / 技能库 / 插件设置的写路径都从这里转给 store；记录在对话页右上角 ⋯ 里 -->
    <SettingsView
      v-else
      :data="store.data"
      :tools="tools"
      :models="models"
      :global-caps="globalCaps"
      :seg-intent="segIntent"
      @fetch-models="onFetchModels"
      @preset-action="onPresetAction"
      @data-action="onDataAction"
      @tool-override="onToolOverride"
      @tool-reset="onToolReset"
      @save="onTouched"
      @delete="onTouched"
      @duplicate="onTouched"
      @export="onSkillExport"
      @skill-toggle="onSkillToggle"
      @plugin-toggle="onPluginToggle"
      @plugin-patch="onPluginPatch"
      @plugin-reset="onPluginReset"
      @goto="goto"
      @goto-seg="requestGotoSeg"
      @change="store.save()"
    />

    <div v-if="notice" :style="toastStyle">{{ notice }}</div>
  </AppShell>
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, onMounted, onUnmounted, ref, watch } from 'vue';

import { DEFAULT_ON_TOOLS, createRegistry } from './agent/registry.ts';
import AppShell from './components/AppShell.vue';
import type { GotoSeg, UiEntry, UiRole, UiTool, UiWorld } from './components/ui_types.ts';
import { fetchModels, loadEntries, loadRoles, loadWorlds, parsePortraitFile, toUiTools } from './core/adapters.ts';
import type { PageEntry } from './core/pages.ts';
import type { ToolOverride } from './core/ports.ts';
import { exportAll, importAll } from './core/storage.ts';
import {
  isAgentPreset,
  uid,
  type Artifact,
  type GlobalCaps,
  type Preset,
  type Skill,
  type Turn,
} from './core/types.ts';
import { createWorldbookPort } from './core/worldbook.ts';
import { generateImages } from './plugins/builtin/image/nai.ts';
import { wirePluginMacros } from './plugins/host.ts';
import { allPages, availablePages, pluginAllTools, pluginTools as pluginToolsOf, toolOwner, toolOwnerLabel } from './plugins/registry.ts';
import { createRunner } from './run/runner.ts';
import { useAppStore } from './stores/app.ts';
import ChatView from './views/ChatView.vue';
import SettingsView from './views/SettingsView.vue';
// 阶段 3：插件页面从**插件目录**静态 import（单文件酒馆脚本里 import() 的 chunk 永远 404，
// 所以插件页只能静态引入；见 webpack.config.ts 的 limitChunkCount）。
import WorldbookView from './plugins/builtin/worldbook/Page.vue';

const ASSISTANT_NAME = '苍玄';

const store = useAppStore();
store.load();

const runner = createRunner();

/**
 * 页面注册表：核心页 + **已启用**插件贡献的页面（已按 order 排好）。
 * 顶栏画的就是它 —— 界面不再有第二份页签名单（阶段 1 拼出来仍是老 6 格、老顺序）。
 */
const pages = computed<PageEntry[]>(() => availablePages(store.data));

/**
 * 当前页 id：active_tab 指向的页面**存在**就用它，否则落到第一个可用页（老数据 / 插件被关掉）。
 * 存在性看 allPages（含 inTabbar:false 的页面），顶栏画的是 availablePages —— 两者别混（H1）。
 */
const tab = computed<string>(() => {
  const id = store.data.active_tab;
  const exists = allPages(store.data).some(page => page.id === id);
  return exists ? id : (pages.value[0]?.id ?? 'chat');
});

/**
 * 兜底结果存回 active_tab（store.setTab 自带存在性校验与回落），不许指向画不出来的页。
 * immediate：老数据里 active_tab 指向已关插件的页面时，一进面板就把它落回可用页。
 */
watch(
  tab,
  value => {
    if (value !== store.data.active_tab) store.setTab(value);
    // 换页就把上一页的错误清掉：错误是「这一页」的状态，不该跟着用户走
    pageError.value = '';
  },
  { immediate: true },
);

const status = computed(() => (store.ready ? '● 已连接' : '○ 载入中'));

/** 生图插件开着吗：关着就不给 agent 注入生图器（生图插件的工具会回一句「生图插件没启用」） */
const imageOn = computed(() => store.pluginEnabled('image'));

/**
 * 全局能力快照（「能力」页那一份），运行决定与界面显示共用同一个口径。
 * 工具直接取 DEFAULT_ON_TOOLS（能力页默认启用的那 9 个；agent_registry 测试保证它与
 * ToolDef.default_on 一致）：不依赖异步拉到的界面清单，点一下就一定判断得对。
 * 插件开着 = 它提供的工具进全局能力；关掉的插件一条都不给（口径写在 plugins/registry.ts）。
 */
const globalCaps = computed<GlobalCaps>(() => {
  const fromPlugins = pluginToolsOf(store.data);
  const live = new Set(fromPlugins);
  // 底座的默认开工具照旧；插件贡献的必须插件开着才给（关掉即消失，见 plugins/types.ts 契约）
  const names = [...DEFAULT_ON_TOOLS.filter(name => toolOwner(name) === 'base' || live.has(name)), ...fromPlugins];
  return {
    tools: names.filter((name, index) => names.indexOf(name) === index).map(name => ({ name, default_on: true })),
    skills: store.data.skills,
  };
});

const busy = ref(false);
const notice = ref('');
/**
 * 页面级错误边界：某个插件内容页渲染时抛错，只把这一页换成提示。
 *
 * 为什么必须有：插件是**别人的代码**（阶段 6 起还能外部装载），
 * 一个页面抛错不能让整个面板白屏 —— 用户的会话数据都还在这个面板里。
 */
const pageError = ref('');
onErrorCaptured(error => {
  const message = error instanceof Error ? error.message : String(error);
  pageError.value = message;
  console.warn('[苍玄助手] 页面渲染出错（已隔离，面板继续可用）', error);
  // 返回 false：异常不再往上冒，面板壳与其它页面照常
  return false;
});
const roles = ref<UiRole[]>([]);
const worlds = ref<UiWorld[]>([]);
const entries = ref<UiEntry[]>([]);
/** 内核给的完整清单（一次性取；界面要的那一份是下面的 tools 计算属性） */
const catalog = ref<UiTool[]>([]);

/**
 * 工具清单：内核清单**全量**，每行打来源标签 + 「来源已停用」标记。
 *
 * ⚠️ 清单口径用 **pluginAllTools**（插件注册的全部工具，含按需的 entry_meta），
 * 不用 pluginTools（只含默认给的）：界面是「改提示词 / 改参数说明」的唯一入口，
 * 按需工具也必须列得出来（验收 F4）。全局能力那份是 pluginTools，两件事别混。
 *
 * 界面口径（验收 F2）：
 *  - owner_disabled = false → 正常行（底座 / 插件开着）；
 *  - owner_disabled = true  → 不占正常行，只有**预设里硬引用过**它时才以兜底行出现、标「来源已停用」。
 * 标在 App.vue：来源插件开没开只有这里拿得到 store.plugin_state（两个视图只管画）。
 */
const tools = computed<UiTool[]>(() => {
  const fromPlugins = new Set(pluginAllTools(store.data));
  return catalog.value.map(tool => {
    const owner = toolOwner(tool.name);
    return {
      ...tool,
      owner: toolOwnerLabel(tool.name),
      owner_disabled: owner === 'base' ? false : !fromPlugins.has(tool.name),
    };
  });
});

const models = ref<string[]>([]);
const attachments = ref<string[]>([]);
const manualMeta = ref<Record<string, string>>({});

let abort: AbortController | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

const toastStyle = 'position:sticky;bottom:8px;margin:0 12px;padding:8px 12px;border-radius:10px;background:rgba(45,212,191,.16);color:#2dd4bf;font-size:12px;text-align:center;z-index:20;';

/**
 * ⚠️ 这里原来有一条 `watch(() => store.data, () => store.save(), { deep: true })`，已经删掉。
 *
 * 为什么删：任何一次数据变动（包括 agent 流式输出每几十毫秒改一次 turn.text）都会
 * ① 深度遍历整份 RootData，② 排一次保存；而一次保存 = 整份数据回传酒馆（实测 46.7 MB）。
 *
 * 删掉之后，**每个写点都必须自己落盘**，规则是：
 *  - store 里的动作：内部已经调 save()（新写点请照做）
 *  - .vue 里的直接变异（v-model / 点开关）：改完 emit('change')，
 *    由 App.vue 这里接成 store.save()（防抖 2.5 秒）
 *  - 长时间任务（agent 运行 / 写回草稿）：用 holdSaves() + finally releaseSaves() 收成一次
 *  - 极少数「必须马上落地」的动作（弹窗保存 / 导入）：store.save(true)
 */

function notify(text: string): void {
  notice.value = text;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 3200);
}

/* -------------------- 子段落点（H3） -------------------- */

/**
 * 一次性的子段意图：「工具：… ›」这类跳转要落到 设置 · 能力 · 工具，
 * 光有页面 id 不够（capability / tools 都不是页面），所以把目标子段一起存下来。
 * at 每次 +1：同一个目标重复点也算一条新请求；SettingsView 靠它认「这条已经消费过」，
 * 免得用户之后自己回到设置页时被一条旧意图拽到「能力」段去。
 */
const segIntent = ref<GotoSeg | null>(null);
let segSeq = 0;

function requestGotoSeg(intent: GotoSeg): void {
  segSeq += 1;
  segIntent.value = { ...intent, at: segSeq };
  store.setTab(intent.page);
}

function goto(id: string): void {
  // 'capability' 已经不是页面（阶段 2）：它就是「设置 · 能力 · 工具」这条落点。
  // 从任何地方发都走同一处（H3），不再依赖「发起时刚好在能力段」。
  if (id === 'capability') {
    requestGotoSeg({ page: 'settings', seg: 'capability', sub: 'tools' });
    return;
  }
  store.setTab(id);
}

function onTouched(): void {
  store.save(true);
}

/* -------------------- 载入外部数据 -------------------- */

async function refreshAll(): Promise<void> {
  try { roles.value = await loadRoles(); } catch (err) { console.warn('[苍玄助手] 角色读取失败', err); }
  try { worlds.value = await loadWorlds(); } catch (err) { console.warn('[苍玄助手] 世界书读取失败', err); }
  await refreshEntries();
  loadTools();
}

async function refreshEntries(): Promise<void> {
  try {
    const picked = store.data.selection.worldbook_names.slice();
    entries.value = picked.length ? await loadEntries(picked) : [];
  } catch (err) {
    console.warn('[苍玄助手] 条目读取失败', err);
    entries.value = [];
  }
}

function loadTools(): void {
  try {
    const reg = createRegistry(createWorldbookPort());
    catalog.value = toUiTools(reg.catalog());
  } catch (err) {
    console.warn('[苍玄助手] 工具清单读取失败', err);
    catalog.value = [];
  }
}

onMounted(() => {
  // 插件宏接线：core 不认识插件，由底座在启动时把「插件贡献的宏」注册进去。
  // 名字清单取全部插件（停用的名字也要认，否则 {{图片提示词}} 会留成裸露占位符），
  // renderer 只认已启用的插件 —— 关掉即退回空串。
  wirePluginMacros(store.data);
  void refreshAll();
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
});

/**
 * 页面被藏起来（切后台 / 锁屏）时兜底写一次。
 *
 * 手机上进程随时可能被系统杀掉，这里是「挂起期间也不丢数据」的最后一道保险：
 * 忽略 holdSaves()，dirty 就立刻落盘（见 store.flushSaves）。
 */
function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') store.flushSaves();
}

/* -------------------- 跑 -------------------- */

async function runOnce(input: string): Promise<void> {
  const preset: Preset | null = store.activePreset;
  if (!preset) { notify('先选一个预设'); return; }
  if (busy.value) { notify('还在跑，先停一下'); return; }

  const controller = new AbortController();
  abort = controller;
  busy.value = true;
  // 挂起自动防抖：agent 跑起来时 onDelta / onTurn / onToolUpdate 会几十毫秒改一次数据，
  // 整段运行只在 finally 的 releaseSaves() 里写一次盘（显式 save(true) 仍然能插队落盘）。
  store.holdSaves();
  store.setRunning(true);

  const history = store.data.session.turns.slice();
  try {
    const result = isAgentPreset(preset, globalCaps.value)
      ? await runner.runAgent({
          data: store.data, input, preset, history, images: attachments.value,
          // 生图：插件没开就**不注入**——tools_image.ts 已经有「没注入就回一句失败」的分支，
          // 比塞一个必然抛错的生成器更省事（每轮新建，出图张数按轮清零）
          genImage: imageOn.value ? makeImageGen() : undefined,
          signal: controller.signal,
          onTurn: onTurnArrived,
          onDelta: store.patchTurnText,
          // turn 是引用，runner 就地改它；这里只标 dirty（挂起期间不排定时器，release 时一次写掉）
          onToolUpdate: () => store.save(),
          onArtifact: (a: Artifact) => store.addArtifact(a.name, a.data, a.kind),
          onNotice: notify,
        })
      : await runner.runPlain({
          data: store.data, input, preset, history, images: attachments.value,
          signal: controller.signal,
          onTurn: onTurnArrived,
          onDelta: store.patchTurnText,
          onToolUpdate: () => { /* 普通预设没有工具 */ },
          onArtifact: (a: Artifact) => store.addArtifact(a.name, a.data, a.kind),
          onNotice: notify,
        });
    if (result.via === 'text') notify('这轮走的是文本工具通道（接口不支持原生 tools）');
    if (!result.done) notify('已停止');
    // 收尾再标一次 dirty：runner 会绕过 store 直接改 data（草稿镜像 / session.round），
    // 这样 releaseSaves() 一定会写一次，挂起期间的改动一处都不会漏。
    store.save();
  } catch (err) {
    console.warn('[苍玄助手] 跑挂了', err);
    // 异常路径同理：runner 可能已经改了一半
    store.save();
    notify('跑挂了：' + String(err && (err as Error).message ? (err as Error).message : err));
  } finally {
    busy.value = false;
    store.setRunning(false);
    abort = null;
    // 异常路径也必须释放：不然挂起计数不归零，之后所有自动保存都被抑制 = 数据永远不落盘
    store.releaseSaves();
  }
}

async function onGenerate(): Promise<void> {
  const preset = store.activePreset;
  if (store.data.selection.character_ids.length === 0) { notify('先勾几个角色'); return; }
  if (isAgentPreset(preset, globalCaps.value)) {
    goto('chat');
  }
  await runOnce(store.data.selection.demand);
}

async function onSend(text: string): Promise<void> {
  const body = text.trim();
  if (!body) return;
  // 从「记下用户这句话」开始就挂起：runOnce 内部再挂一层，release 到 0 才写，
  // 所以这一段只会落一次盘（含异常路径）。
  store.holdSaves();
  try {
    store.appendTurn({ id: uid('turn'), role: 'user', text: body, images: attachments.value.slice(), calls: [], at: Date.now() });
    attachments.value = [];
    await runOnce(body);
  } finally {
    store.releaseSaves();
  }
}

function onStop(): void {
  if (abort) {
    abort.abort();
    notify('已请求停止');
  }
}

function onAttach(files: File[]): void {
  for (const f of files) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') attachments.value.push(reader.result);
    };
    reader.readAsDataURL(f);
  }
  notify('已附上 ' + files.length + ' 张图（要开「发送图片」模型才看得见）');
}

/** 轮次到达：按 id 覆盖或追加（流式时先建空轮次，增量往里塞） */
function onTurnArrived(turn: Turn): void {
  store.upsertTurn(turn);
}

/* -------------------- 聊天记录 -------------------- */

function onSessionAction(payload: { action: string; id: string }): void {
  const action = payload && payload.action ? payload.action : '';
  const id = payload && payload.id ? payload.id : '';

  if (action === 'new') { store.createSession(); notify('已新建记录'); return; }
  if (action === 'open') { store.openSession(id); return; }
  if (action === 'delete') {
    if (confirm('删掉这条聊天记录？')) { store.deleteSession(id); notify('已删除'); }
    return;
  }
  if (action === 'rename') {
    const cur = store.sessions.find((s) => s.id === id);
    const next = prompt('改成什么名字？', cur ? cur.title : '');
    if (next !== null && next.trim()) { store.renameSession(id, next.trim()); notify('已改名'); }
    return;
  }
  if (action === 'export') {
    try { download(sessionFileName(id, 'json'), store.exportSession(id, 'json')); notify('已导出 JSON'); }
    catch (err) { notify('导出失败：' + String((err as Error).message || err)); }
    return;
  }
  if (action === 'export-md') {
    try { download(sessionFileName(id, 'md'), store.exportSession(id, 'md')); notify('已导出 Markdown'); }
    catch (err) { notify('导出失败：' + String((err as Error).message || err)); }
    return;
  }
  if (action === 'export-all') {
    try { download(dataFileName(), store.exportSessions()); notify('已导出全部记录'); }
    catch (err) { notify('导出失败：' + String((err as Error).message || err)); }
  }
}

function sessionFileName(id: string, ext: string): string {
  const s = store.sessions.find((x) => x.id === id);
  const raw = s && s.title ? s.title : '聊天记录';
  return '苍玄助手-' + raw.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
}

/* -------------------- 草稿 -------------------- */

async function onSaveDrafts(): Promise<void> {
  // 写世界书是慢动作（几十次 IO），期间 runner 会把草稿同步进 data.drafts。
  // 挂起自动防抖，最后统一由 releaseSaves() 落一次盘；异常路径也释放。
  store.holdSaves();
  try {
    const res = await runner.saveDrafts();
    // 有失败也立刻落地（关键节点）：不然用户以为改动没保存
    if (res.failed > 0) store.save(true);
    else store.clearDrafts();
    notify('已写回世界书：成功 ' + res.applied + ' 处，失败 ' + res.failed + ' 处');
  } catch (err) {
    // runner 可能已经改了一半（data.drafts 也同步过），标 dirty 让 release 写掉
    store.save();
    notify('写回失败：' + String((err as Error).message || err));
  } finally {
    store.releaseSaves();
  }
}

function onExportDrafts(): void {
  try {
    download('苍玄助手-草稿.diff.txt', runner.exportDrafts());
  } catch (err) {
    notify('导出失败：' + String((err as Error).message || err));
  }
}

function onRetryImage(): void {
  // 现在只是提示、不跑任务；按「长任务入口」的规矩也走一遍挂起 / 释放，
  // 以后这里真的重跑时语义已经对了（异常路径也必须释放）。
  store.holdSaves();
  try {
    notify('想重画就直接跟它说，比如「山太秃了，加两株古松再出一张」');
  } finally {
    store.releaseSaves();
  }
}

/* -------------------- 立绘 / 产物 -------------------- */

async function onPickPortrait(roleId: string): Promise<void> {
  const file = await pickFile();
  if (!file) return;
  try {
    const res = await parsePortraitFile(file);
    manualMeta.value[roleId] = res.text;
    notify(res.ok ? '读到了，' + res.text.length + ' 字' : '这张图里没有元数据：' + String(res.error || ''));
  } catch (err) {
    notify('读图失败：' + String((err as Error).message || err));
  }
}

function onSaveArtifact(artifactId: string): void {
  const art = store.data.artifacts.find((a) => a.id === artifactId);
  if (!art) return;
  // 产物弹窗里可能刚改过文件名（立绘页直接改的 data），这里补一次落盘
  store.save();
  download(art.name || '苍玄助手-产物.json', art.data);
  notify('已保存 ' + (art.name || '产物'));
}

/* -------------------- 能力（技能库 / 工具覆盖项） / 设置 -------------------- */

/** 技能卡上的开关：走 store 的唯一入口（store 内部会落盘），界面不再直接改 data */
function onSkillToggle(skill: Skill): void {
  store.updateSkill(skill.id, { enabled: !skill.enabled });
}

function onSkillExport(skill: { id: string; name: string }): void {
  const found = store.data.skills.find((s) => s.id === skill.id);
  if (!found) return;
  download(found.name + '.skill.json', JSON.stringify(found, null, 2));
}

async function onFetchModels(): Promise<void> {
  try {
    models.value = await fetchModels(store.data.api);
    notify('拿到 ' + models.value.length + ' 个模型');
  } catch (err) {
    notify('获取模型失败：' + String((err as Error).message || err));
  }
}

/** 对话设置 Sheet 里换预设：走 store 的唯一入口，顺手记到会话上 */
function onPresetChange(id: string): void {
  store.selectPreset(id);
  notify(id ? '已换预设' : '已清空预设选择');
}

function onPresetAction(action: string, presetId: string): void {
  const target = store.data.presets.find((p) => p.id === presetId);
  if (action === 'new') { store.addPreset(); return; }
  if (!target) return;
  if (action === 'duplicate') {
    const copy: Partial<Preset> = { ...target, name: target.name + ' 副本', builtin: false };
    delete copy.id;
    store.addPreset(copy);
    return;
  }
  if (action === 'delete') { store.removePreset(presetId); return; }
  if (action === 'export') { download(target.name + '.preset.json', JSON.stringify(target, null, 2)); return; }
}

/* -------------------- 工具页覆盖项 -------------------- */

/**
 * 工具页只 emit，写路径唯一在这里（store.setToolOverride / resetToolOverride）。
 * patch 语义由 store 定：字段显式 undefined = 用回内置默认（会被删掉）。
 */
function onToolOverride(name: string, patch: Partial<ToolOverride>): void {
  store.setToolOverride(name, patch);
}

function onToolReset(name: string): void {
  store.resetToolOverride(name);
  notify('已恢复内置默认');
}

/* -------------------- 插件段（设置 · 能力 · 插件） -------------------- */

/**
 * 插件开关：状态存在 plugin_state（底座拥有），写路径唯一在 store.setPluginEnabled。
 * 关掉插件 = 它贡献的页面与工具立刻消失（页面回落在上面那个 watch，工具在 tools 计算属性）。
 */
function onPluginToggle(id: string, enabled: boolean): void {
  store.setPluginEnabled(id, enabled);
  // 开关变了，活的宏也变了：重新接线（renderer 只认已启用的插件）。
  // 不同步这一步的话，关掉插件后 {{图片提示词}} 还会用旧 renderer 渲染出内容。
  wirePluginMacros(store.data);
}

/** 插件自己的设置：只 emit，写路径唯一在这里（store.setPluginConfig；enabled 由 store 忽略） */
function onPluginPatch(id: string, patch: Record<string, unknown>): void {
  store.setPluginConfig(id, patch);
}

function onPluginReset(id: string): void {
  store.resetPluginConfig(id);
  notify('已恢复内置默认');
}

/**
 * 给 agent 一轮用的生图器：插件页的「一次最多几张」在这里封顶。
 * 每次跑都新建一个（计数按轮清零），插件没配好时 generateImages 自己会报清楚的原因。
 */
function makeImageGen(): (prompt: string, negative: string) => Promise<string[]> {
  let used = 0;
  return async (prompt: string, negative: string) => {
    const config = store.imageConfig();
    const cap = Math.max(1, Math.round(Number(config.max_count) || 1));
    if (used >= cap) throw new Error('这次最多出 ' + cap + ' 张（插件页「一次最多几张」）');
    used += 1;
    return generateImages(config, prompt, negative);
  };
}

/* -------------------- 数据导入导出 -------------------- */

async function onDataAction(action: string): Promise<void> {
  if (action === 'export-all' || action === 'export-nokey') {
    try {
      const text = exportAll(action === 'export-all');
      download(dataFileName(), text);
      notify(action === 'export-all' ? '已导出（含 API Key，别乱发）' : '已导出（不含 API Key）');
    } catch (err) {
      notify('导出失败：' + String((err as Error).message || err));
    }
    return;
  }

  if (action === 'import') {
    const file = await pickFile('application/json,.json');
    if (!file) return;
    try {
      const text = await file.text();
      const res = importAll(text);
      if (!res.ok || !res.data) { notify('导入失败：' + String(res.error || '数据不对')); return; }
      store.replaceAll(res.data);
      notify('导入完成，已覆盖当前数据');
    } catch (err) {
      notify('导入失败：' + String((err as Error).message || err));
    }
    return;
  }

  if (action === 'clear-session') {
    if (confirm('清空当前对话？')) { store.resetSession(); notify('对话已清空'); }
    return;
  }
  if (action === 'clear-drafts') {
    if (confirm('丢弃全部草稿改动？')) { store.clearDrafts(); notify('草稿已丢弃'); }
    return;
  }
  if (action === 'clear-artifacts') {
    if (confirm('丢弃全部产物？')) { store.clearArtifacts(); notify('产物已丢弃'); }
  }
}

function dataFileName(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return '苍玄助手-数据-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
}

/* -------------------- 小工具 -------------------- */

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

function pickFile(accept = 'image/png,image/*'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.onchange = () => {
      const f = input.files && input.files[0] ? input.files[0] : null;
      if (input.parentNode) input.parentNode.removeChild(input);
      resolve(f);
    };
    document.body.appendChild(input);
    input.click();
  });
}
</script>

<style scoped></style>