<template>
  <FloatingShell
    ref="shellEl"
    :tab-title="tab"
    :running="busy"
    @close="onShellAction('close')"
  >
  <AppShell
    :pages="pages"
    :tab="tab"
    :status="status"
    @update:tab="store.setTab($event)"
    @close="onShellAction('close')"
  >
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
    <!-- 阶段 6：MCP 服务器页。inTabbar:false —— 顶栏保持 3 格，这页从插件管理页
         「它加了什么 → 页面」进（存在性判定用 allPages，画顶栏用 availablePages）。 -->
    <McpView
      v-else-if="tab === 'mcp'"
      :config="mcpConfig"
      :statuses="mcpStatuses"
      :tools-of="mcpTools"
      @patch="onMcpPatch"
      @add="onMcpAdd"
      @remove="onMcpRemove"
      @action="onMcpAction"
      @change="store.save()"
    />
    <ChatView
      v-else-if="tab === 'chat'"
      :data="store.data"
      :assistant-name="ASSISTANT_NAME"
      :rollback-result="store.rollbackResult"
      @send="onSend"
      @stop="onStop"
      @attach="onAttach"
      @save-drafts="onSaveDrafts"
      @export-drafts="onExportDrafts"
      @retry-image="onRetryImage"
      @session-action="onSessionAction"
      @rollback="onRollback"
      @rollback-cleared="store.setRollbackResult(null)"
      @preset-change="onPresetChange"
    />
    <!-- 设置：接口｜预设｜能力｜数据。「能力」里三段 工具｜技能｜插件（CapabilityView 在里面），
         工具覆盖项 / 技能库 / 插件设置的写路径都从这里转给 store；记录在对话页右上角 ⋯ 里 -->
    <SettingsView
      v-else
      :data="store.data"
      :tools="tools"
      :models="models"
      :global-caps="globalCaps"
      :discipline="sharedDiscipline"
      :seg-intent="segIntent"
      @fetch-models="onFetchModels"
      @preset-action="onPresetAction"
      @preset-change="onPresetChange"
      @data-action="onDataAction"
      @tool-override="onToolOverride"
      @tool-reset="onToolReset"
      @tool-switch-clear="store.clearToolSwitch($event)"
      @save="onSkillSave"
      @delete="onSkillDelete"
      @duplicate="onTouched"
      @export="onSkillExport"
      @skill-toggle="onSkillToggle"
      @skill-restore="onSkillRestore"
      @discipline-save="onDisciplineSave"
      @save-tool-overrides="onSaveToolOverrides"
      @plugin-toggle="onPluginToggle"
      @plugin-patch="onPluginPatch"
      @plugin-reset="onPluginReset"
      @external-install-url="onExternalInstallUrl"
      @external-install-paste="onExternalInstallPaste"
      @external-uninstall="onExternalUninstall"
      @goto="goto"
      @goto-seg="requestGotoSeg"
      @change="store.save()"
    />

    <div v-if="notice" :style="toastStyle">{{ notice }}</div>
  </AppShell>
  </FloatingShell>
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, onMounted, onUnmounted, ref, watch } from 'vue';

import { DEFAULT_ON_TOOLS, createRegistry } from './agent/registry.ts';
import AppShell from './components/AppShell.vue';
import FloatingShell from './components/FloatingShell.vue';
import type { GotoSeg, UiEntry, UiRole, UiTool, UiWorld } from './components/ui_types.ts';
import { defaultWorldbookSelection, fetchModels, loadEntries, loadRoles, loadWorlds, parsePortraitFile, toUiTools } from './core/adapters.ts';
import type { PageEntry } from './core/pages.ts';
import type { ToolOverride } from './core/ports.ts';
import { exportAll, importAll } from './core/storage.ts';
import { exportPreset, exportToolPrompts, importTransfer, transferFileName } from './core/transfer.ts';
import {
  isAgentPreset,
  uid,
  type Artifact,
  type ExternalPlugin,
  type GlobalCaps,
  type McpServer,
  type Preset,
  type Skill,
  type Turn,
} from './core/types.ts';
import { createWorldbookPort } from './core/worldbook.ts';
// 阶段 7：外部插件装载（下载 / 粘贴 → 存真文件 → 动态 import → 注册进插件表）
import {
  createLoaderDeps,
  installFromCode,
  installFromUrl,
  loadInstalled,
  uninstallPlugin,
  type InstallResult,
} from './plugins/external/loader.ts';
import { generateImages } from './plugins/builtin/image/nai.ts';
import { wirePluginMacros } from './plugins/host.ts';
import { allPages, availablePages, pluginAllTools, pluginEnabled, pluginTools as pluginToolsOf, toolOwner, toolOwnerLabel } from './plugins/registry.ts';
import { createRunner } from './run/runner.ts';
import { useAppStore } from './stores/app.ts';
import ChatView from './views/ChatView.vue';
import SettingsView from './views/SettingsView.vue';
// 阶段 3：插件页面从**插件目录**静态 import（单文件酒馆脚本里 import() 的 chunk 永远 404，
// 所以插件页只能静态引入；见 webpack.config.ts 的 limitChunkCount）。
import WorldbookView from './plugins/builtin/worldbook/Page.vue';
// 阶段 6：MCP 的**服务器页**同样静态 import（单文件脚本里 import() 的 chunk 永远 404）；
// 连接层由 App.vue 驱动 —— 页面只管画，不认识 store 也不认识运行时状态。
import McpView from './plugins/builtin/mcp/Page.vue';
import {
  connectServer,
  disconnectAll,
  disconnectServer,
  serverStatus,
  serverToolNames,
  syncServers,
} from './plugins/builtin/mcp/connection.ts';
import { hostFn } from './core/host.ts';
import {
  DEFAULT_SHARED_DISCIPLINE,
  createSkillStoreDeps,
  readSharedDiscipline,
  writeIndex,
  writeSharedDiscipline,
  type SkillIndex,
} from './core/skill_store.ts';
import { deleteSkillFromStore, persistSkill, restoreSkill, syncSkillsFromStore } from './core/skill_sync.ts';
import { pluginFactorySkills } from './plugins/registry.ts';

const ASSISTANT_NAME = '苍玄';

const store = useAppStore();
store.load();

const runner = createRunner();

/* -------------------- B48/B51：skill 从 ST 真文件来 -------------------- */

/** skill 存储的宿主依赖（拿一次，长期用；内部自己缓存 CSRF） */
const skillDeps = createSkillStoreDeps();

/**
 * 出厂层的 skill 清单 = **插件贡献的**（关掉插件即从这里消失）。
 *
 * ⚠️ 它是 computed 而不是常量：`pluginFactorySkills` 依赖 plugin_state，
 * 用户在插件页一关，技能列表当场跟着变。
 */
const factorySkills = computed(() => pluginFactorySkills(store.data));

/** 共享纪律（B40）：每次跑之前读一遍，用户在技能页改完立刻生效 */
const sharedDiscipline = ref(DEFAULT_SHARED_DISCIPLINE);

/**
 * 启动时同步一次：释放出厂 skill → 读索引 → 水合成 skills。
 *
 * **失败一律降级**（拿不到 fetch / 文件读不出来）：保留现有 skills，
 * 只提示一句。理由：技能是可选的加速器，同步失败不该让底座不可用。
 */
async function syncSkills(): Promise<void> {
  const before = store.data.skills.length;
  const { skills, index, result } = await syncSkillsFromStore(store.data.skills, factorySkills.value, skillDeps);
  if (!result.ok) {
    if (before) console.warn('[苍玄助手] 技能没同步上：' + result.reason);
    return;
  }
  skillIndex.value = index;
  store.replaceSkills(skills);
  if (result.released) notify('已释放 ' + result.released + ' 个技能文件到酒馆文件目录');
}

/** 读共享纪律（读不到就给出厂默认；读文件失败不该挡住跑） */
async function loadDiscipline(): Promise<void> {
  try {
    const { text } = await readSharedDiscipline(skillDeps, skillIndex.value);
    sharedDiscipline.value = text;
  } catch {
    /* 保留上一次的 */
  }
}

/**
 * B48：`read_skill_file` 的内容从 ST 文件读（同步接口，因为工具是同步的）。
 *
 * ⚠️ 工具层是同步的（`ToolDef.run` 返回 Promise 但参数组装是同步的），
 * 而读文件是异步 —— 所以这里**不读文件**，而是从已经水合好的 `data.skills` 里取。
 * 水合时已经把每个参考文件的内容读进内存了（见 skill_sync.ts 的 hydrateOne），
 * 所以这条路拿到的就是文件里的原文，而且不用把工具改成异步。
 */
function readSkillFileOf(skill: { id: string }, fileName: string): string | undefined {
  const found = store.data.skills.find(item => item.id === skill.id);
  if (!found) return undefined;
  const wanted = fileName.trim();
  const hit =
    found.files.find(file => file.name === wanted) ??
    found.files.find(file => file.name.endsWith('/' + wanted));
  return hit ? hit.content : undefined;
}

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
  const unique = names.filter((name, index) => names.indexOf(name) === index);
  /*
   * 工具页的用户级开关（tool_overrides[name].enabled）在这里生效。
   *
   * 口径：**显式关掉的不进全局能力**；显式打开的**进**（把 portrait_prompt 这种按需工具
   * 从「能力」页打开 —— 这正是工具开关存在的意义）；没设过的照旧（default_on 决定）。
   * 与 applyToolOverride 是同一套语义的两种表达：那边给 runner，这边给界面与「跟随全局」的预设。
   */
  const overrides = store.data.tool_overrides ?? {};
  const tools = unique
    .filter(name => overrides[name]?.enabled !== false)
    .map(name => ({ name, default_on: true }));
  for (const [name, override] of Object.entries(overrides)) {
    if (override?.enabled !== true) continue;
    // 显式打开的按需工具也要进（且不重复）
    if (!tools.some(tool => tool.name === name)) tools.push({ name, default_on: true });
  }
  return { tools, skills: store.data.skills };
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
 * ⚠️ 清单口径用 **pluginAllTools**（插件注册的全部工具，含按需的 portrait_prompt），
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

/**
 * 面板外壳的把手（悬浮球 / 浮层）。这里只做「收起」这一件事 ——
 * 打开由悬浮球自己点，App.vue 不参与，免得两边抢状态。
 */
const shellEl = ref<{ setOpen: (next: boolean) => void } | null>(null);

/** 浮层壳事件统一在这里收：目前只有「收起」 */
function onShellAction(action: string): void {
  if (action === 'close') shellEl.value?.setOpen(false);
}

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

/**
 * 读当前选中世界书的条目，写进 entries。
 *
 * ⚠️ 有**代次守卫**（entriesGeneration）：防抖只能减少并发，不能消除它 ——
 * 某一本很大（1.1MB）时读得可能比防抖窗口还久，两次读就会重叠，先发的那次可能后回来，
 * 把新选择的结果**覆盖成旧书**的条目。所以每次读领一个号，回来时号不是最新的就丢弃。
 */
let entriesGeneration = 0;

async function refreshAll(): Promise<void> {
  try { roles.value = await loadRoles(); } catch (err) { console.warn('[苍玄助手] 角色读取失败', err); }
  try { worlds.value = await loadWorlds(); } catch (err) { console.warn('[苍玄助手] 世界书读取失败', err); }
  applyWorldbookDefault();
  await refreshEntries();
  loadTools();
  // B48/B51：技能从 ST 真文件水合（拿不到文件能力就降级，不动现有 skills）
  await syncSkills();
  await loadDiscipline();
}

/**
 * B4：用户从没勾过世界书时，替他勾上「当前生效的书」。
 *
 * ⚠️ 必须在 `worlds` 读回来**之后**、`refreshEntries()` **之前**跑：
 *  - 之后 —— 要拿 `world.current` 才知道哪几本正在生效；
 *  - 之前 —— 否则首次进面板会先按空选择读一遍条目（0 条），再被 watcher 补读一次，
 *    白跑一次宿主 IO，还会闪一下空列表。
 *
 * 写盘走 patchSelection（跟世界书页的写点同一个口径）；它不碰 user_edited，
 * 所以这个「自动勾的」状态仍然是「用户没亲手动过」，下次刷新照样能跟着当前角色卡走。
 */
function applyWorldbookDefault(): void {
  const picked = defaultWorldbookSelection(worlds.value, store.data.selection);
  if (picked === null) return;
  store.patchSelection({ worldbook_names: picked });
}

async function refreshEntries(): Promise<void> {
  const generation = ++entriesGeneration;
  try {
    const picked = store.data.selection.worldbook_names.slice();
    const next = picked.length ? await loadEntries(picked) : [];
    if (generation !== entriesGeneration) return; // 期间又换了选择 → 这次结果过期，别覆盖
    entries.value = next;
  } catch (err) {
    if (generation !== entriesGeneration) return;
    console.warn('[苍玄助手] 条目读取失败', err);
    entries.value = [];
  }
}

/* -------------------- 选择变化 → 重读条目（P5-8） -------------------- */

/**
 * 条目重读的防抖窗口（毫秒）。
 *
 * 为什么不立刻读：勾选是**逐本**发生的 —— 点「全选」会一次性改 N 本，用户手速快时
 * 一秒内可能改十几次。每次改动都整本读一遍 = N 次宿主 IO + N 次大对象分配，
 * 而世界书实测有 1.1MB 一本（loadEntries 要把整本 entries 从宿主拉过来才能投影出
 * uid/name/group）。所以攒一小会儿，只按**最终**选择读一次。
 * 250ms 是「手感上还即时」与「一次全选只读一次」之间的平衡（跟 store 落盘的 2500ms
 * 不是一个量级：那个是写盘，这个是读出来给用户看，卡顿阈值更低）。
 */
const ENTRIES_DEBOUNCE_MS = 250;

/** 防抖定时器（只有一个：永远以最后一次选择为准） */
let entriesTimer: ReturnType<typeof setTimeout> | null = null;

/** 请求重读条目（防抖）。选择一变就调它，真正的读在 refreshEntries 里。 */
function scheduleEntriesRefresh(): void {
  if (entriesTimer) clearTimeout(entriesTimer);
  entriesTimer = setTimeout(() => {
    entriesTimer = null;
    void refreshEntries();
  }, ENTRIES_DEBOUNCE_MS);
}

/**
 * 当前选择世界书的**签名串**（用来判断「选择是不是变了」）—— 下面那条 watcher 的监听源。
 *
 * 这条 watcher 就是「选好世界书后，数据层会把条目读出来」那句界面文案的兑现处：
 * 在它之前 refreshEntries() 只在挂载时（refreshAll）跑过一次，而 selection 是
 * **持久化**的 —— 挂载时读到的是上次选的书，之后换选就再也没人重读，面板一直停在旧条目上。
 *
 * 两个刻意的选择：
 *  1. **派生出一条字符串**，而不是监听数组：世界书页勾一本是**原地改数组**
 *     （Page.vue 的 toggleWorld 用 splice / push），浅监听数组看不到；而 deep 又会深度遍历
 *     整个响应式对象 —— App.vue 里曾经那条全局 deep watcher 就是因为「一次变动深遍历整份
 *     RootData + 整份回传 46.7MB」被删掉的（有源码级防回归闸盯着，见 tests/苍玄助手/stores_save.test.ts）。
 *     join 出来的串对两类改动（原地改 / 换引用）都会变，于是**既灵敏又不用 deep**。
 *  2. 用 \u0000 而不是逗号分隔：世界书名理论上可能带逗号，否则「A,B」与「A」+「B」
 *     会撞成同一个签名，漏掉一次重读。
 */
const selectionSignature = computed(() => store.data.selection.worldbook_names.join('\u0000'));

// 选择一变（选中 / 取消 / 全选 / 清空）就安排重读条目。只管**后续变化**：
// 挂载路径由 refreshAll() 负责（那是「回归不能弄坏」的第 2 条验收），所以不设 immediate。
watch(selectionSignature, () => scheduleEntriesRefresh());

function loadTools(): void {
  try {
    // ⚠️ 必须把 **plugin_state** 传进去（原来没传）：
    //   不传的话注册表按 manifest 的 defaultEnabled 算，于是
    //   ① 用户手动开着的非默认插件（生图 / MCP）的工具**在界面上根本列不出来**；
    //   ② 运行时注册的工具（MCP 连上才有的那些）永远进不了这份目录。
    //   真机验收就是这么抓到的：连上服务器后「能力 · 工具」仍是 15 行、没有 cx_ping。
    const reg = createRegistry(createWorldbookPort(), { plugin_state: store.data.plugin_state });
    catalog.value = toUiTools(reg.catalog());
  } catch (err) {
    console.warn('[苍玄助手] 工具清单读取失败', err);
    catalog.value = [];
  }
}

/**
 * 把「写回前自动备份」接到草稿仓上（P5-6 第 1 段）。
 *
 * 为什么装配点在 App.vue：备份要写进 `RootData.wb_backups` 并落盘 —— 那需要同时拿到
 * **数据**（`store.data`）和 `save()`，只有 store 有；而 `DraftStore` 是 runner 的私有状态，
 * 由 `createRunner()` 建一次并长期持有。**两边都在 `App.vue` 的作用域里**，所以这里是唯一
 * 能一次接上的地方（runner 自己拿不到 data：它每轮从参数收 `args.data`；store 也拿不到草稿仓）。
 *
 * 没接上的后果是静默的：`apply()` 会 warn 一句「没有接入备份钩子，本次写回没有兜底」，
 * 但界面照常，`wb_backups` 永远是空的 —— 记录页永远空态、回滚永远调不到。
 */
function wireBackupSink(): void {
  runner.setBackupSink(store.backupSink());
}

onMounted(() => {
  // 插件宏接线：core 不认识插件，由底座在启动时把「插件贡献的宏」注册进去。
  // 名字清单取全部插件（停用的名字也要认，否则 {{图片提示词}} 会留成裸露占位符），
  // renderer 只认已启用的插件 —— 关掉即退回空串。
  wirePluginMacros(store.data);
  wireBackupSink();
  // MCP：启动时按配置同步一遍（幂等；插件关着时会把残留连接断干净）
  void syncMcp();
  // 外部插件：启动时按安装清单装载一遍（幂等；失败的按行记 last_error，不连坐）
  void loadExternalPlugins();
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
          // B40：共享纪律（每个 skill 正文前拼一段）
          shared_discipline: sharedDiscipline.value,
          // B48：参考文件从 ST 文件读（水合时已读进 data.skills）
          read_skill_file: readSkillFileOf,
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

/**
 * 回滚一份世界书备份（P5-6 第 3 段）。
 *
 * 三层都在这里收口，界面那边只 emit 一个 id：
 *  1. 结果**存进 store**（`setRollbackResult`）再交给界面 —— 记录页住在会卸载的 Sheet 里，
 *     异步结果不能靠组件句柄回传（详见 stores/app.ts 里 rollbackResult 的注释）；
 *  2. 真正的回滚动作在 store（`rollbackBackup`）：找备份 → runner.rollback（内部转 DraftStore.rollback）→ 落盘；
 *  3. 这里只负责「挂起自动保存 / 起止提示」这种页面级编排。
 *
 * `store.holdSaves()`：回滚是「读整本 + 写整本」的慢动作，期间别的写点不该各排各的盘。
 */
async function onRollback(payload: { id: string }): Promise<void> {
  const id = payload?.id ?? '';
  if (!id) return;
  store.holdSaves();
  try {
    store.setRollbackResult(null);
    const result = await store.rollbackBackup(runner, id);
    store.setRollbackResult(result);
    store.save(true);
  } catch (err) {
    // rollback 自己承诺不抛；真抛了也得让界面看到，不能静默
    store.setRollbackResult({ ok: false, error: String((err as Error)?.message ?? err) });
    store.save(true);
  } finally {
    store.releaseSaves();
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
  // 开关状态住在索引里（那是「有哪些技能、哪个开着」的唯一真相源）
  void persistSkill(skillDeps, skillIndex.value, { ...skill, enabled: !skill.enabled }, factorySkills.value);
}

/**
 * 索引快照。
 *
 * 为什么不每次现读：读写索引是异步 + 要发请求，而技能页的交互是同步的。
 * 启动时 syncSkills() 已经读过一次（`syncSkillsFromStore` 返回它），之后每次写都更新这份。
 */
const skillIndex = ref<SkillIndex>({ version: 1, skills: [] });

/** 保存技能：**先写 ST 文件，再改内存快照**（文件才是真源） */
async function onSkillSave(skill: Skill): Promise<void> {
  const result = await persistSkill(skillDeps, skillIndex.value, skill, factorySkills.value);
  if (!result.ok) { notify('技能没存上：' + (result.error ?? '未知原因')); return; }
  const i = store.data.skills.findIndex(item => item.id === skill.id);
  if (i >= 0) store.updateSkill(skill.id, skill);
  else store.data.skills.push(skill);
  store.save();
  notify('已保存「' + skill.name + '」');
}

/** 删除技能：文件删得掉才从内存里摘（插件带的删不掉，会带人话回来） */
async function onSkillDelete(id: string): Promise<void> {
  const result = await deleteSkillFromStore(skillDeps, skillIndex.value, id);
  if (!result.ok) { notify('删不掉：' + (result.error ?? '未知原因')); return; }
  store.removeSkill(id);
  notify('已删除技能');
}

/** 恢复默认：从出厂内容重放一遍（只有插件带的技能有出厂内容） */
async function onSkillRestore(skill: Skill): Promise<void> {
  if (!confirm('把「' + skill.name + '」恢复成插件出厂版本？你改过的内容会没。')) return;
  const restored = await restoreSkill(skillDeps, skillIndex.value, skill, factorySkills.value);
  if (!restored) { notify('这个技能没有出厂版本，恢复不了'); return; }
  store.updateSkill(restored.id, restored);
  notify('已恢复默认「' + restored.name + '」');
}

/**
 * B40：共享纪律改了 → 写进 ST 文件 + 落索引，并更新内存里的那份（下一轮立刻生效）。
 *
 * ⚠️ 空串走的是「关掉」那条路（删文件 + 索引里置 disciplineOff）——
 * ST 的 upload **不收空内容**，直接写空串会 400（真机踩出来的）。
 */
async function onDisciplineSave(text: string): Promise<void> {
  try {
    await writeSharedDiscipline(skillDeps, text, skillIndex.value);
    await writeIndex(skillDeps, skillIndex.value);
    sharedDiscipline.value = text.trim() ? text : '';
    notify(text.trim() ? '已保存共享纪律' : '已关掉共享纪律（不再注入）');
  } catch (err) {
    notify('共享纪律没存上：' + String((err as Error).message || err));
  }
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

/**
 * 对话设置 Sheet 里换预设：走 store 的唯一入口，顺手记到会话上。
 *
 * ─────────────────────────── B59：改没存就切预设要问一句 ───────────────────────────
 *
 * 背景（B45 的两层结构）：工具提示词有「临时区」（`RootData.tool_overrides`）和
 * 「预设里存的那份」（`Preset.tool_overrides`）。切预设会用新预设那份**整体覆盖**临时区，
 * 所以临时区里没存进预设的改动**切走就没了**。
 *
 * 用户定案是「**提示一次**（存 / 丢弃 / 取消）」：
 *   · 确定 = 先把当前改动存进**当前**预设，再切
 *   · 取消 = 不切了，回去接着改
 *
 * 为什么不给「丢弃并切走」一个单独按钮：`confirm` 只有两个结果，
 * 而「丢弃」是默认行为 —— 点取消 = 不切 = 改动还在，用户不会丢东西；
 * 想丢弃就再点一次切换（第二次进来时 `toolOverridesDirty()` 仍为真，但那时用户是明知的）。
 * 把「丢东西」做成需要**两步**的动作，比一键丢掉安全。
 *
 * 内置预设没有「存进去」这条路（B41：内置只读），所以那种情况下只提示、不给存 ——
 * 用户得先另存为一份自己的预设。
 */
function onPresetChange(id: string): void {
  if (id !== store.data.active_preset_id && store.toolOverridesDirty()) {
    const current = store.activePreset;
    const where = current ? '「' + current.name + '」' : '当前预设';
    if (current?.builtin) {
      if (!confirm(
        '工具提示词的改动还没存进预设。\n\n' +
          where + ' 是内置预设，改不了它 —— 切走这些改动就没了。\n\n' +
          '确定 = 照样切走（改动丢弃）\n取消 = 不切，先另存为一份自己的预设再改',
      )) {
        notify('没切 —— 想保住改动就先「另存为一份再改」');
        return;
      }
    } else {
      if (!confirm(
        '工具提示词的改动还没存进预设 ' + where + '。\n\n' +
          '确定 = 先存进' + where + '，再切\n取消 = 不切了，回去接着改',
      )) {
        notify('没切 —— 改动还在');
        return;
      }
      if (!store.saveToolOverridesToPreset()) {
        notify('没存上（预设可能已经没了），这次不切');
        return;
      }
    }
  }
  store.selectPreset(id);
  notify(id ? '已换预设' : '已清空预设选择');
}

function onPresetAction(action: string, presetId: string): void {
  const target = store.data.presets.find((p) => p.id === presetId);
  if (action === 'new') { store.addPreset(); return; }
  if (!target) return;
  if (action === 'duplicate') {
    // 派生 = 一份完全归用户的副本：builtin: false + 新 id。
    // 内置预设的唯一「改法」就是走这条路（B41 完整版：内置只读）。
    //
    // ⚠️ **把临时区当前的工具提示词带进副本**（真机验收抓到的 B45 bug）：
    //
    // 用户的真实流程是「先在内置预设上调工具提示词 → 发现存不进去 → 点另存为」。
    // 那条调好的东西此刻**只存在于临时区**（`RootData.tool_overrides`）。
    // 如果派生时不带过去，副本的 `tool_overrides` 是空的 ——
    // 用户刚调好的东西就成了孤儿：副本里没有、内置里也存不进去，
    // 再点一次「存进预设」反而把副本清空。这正是「另存为一份再改」最该避免的事。
    const copy: Partial<Preset> = {
      ...target,
      name: target.name + ' 副本',
      builtin: false,
      tool_overrides: { ...store.data.tool_overrides },
    };
    delete copy.id;
    const made = store.addPreset(copy);
    // 派生完顺手把界面切到那份副本上（addPreset 已经把 active_preset_id 指过去了）
    notify('已另存为「' + made.name + '」—— 现在改的是你的副本，插件升级不会动它');
    return;
  }
  if (action === 'delete') {
    // 内置预设删不掉（store.removePreset 内部挡了）。这里给一句人话，别让按钮看着没反应。
    if (target.builtin) {
      notify('内置预设删不掉 —— 它是随插件走的起点，只能派生副本');
      return;
    }
    store.removePreset(presetId);
    return;
  }
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

/**
 * B45：把临时区的工具提示词**存回当前预设**（跟预设走）。
 *
 * 内置预设存不了（B41：内置只读），按钮那边已经禁用了，这里再挡一道并给人话。
 */
function onSaveToolOverrides(): void {
  const preset = store.activePreset;
  if (!preset) { notify('先选一个预设'); return; }
  if (preset.builtin) { notify('内置预设只读 —— 先「另存为一份再改」'); return; }
  if (store.saveToolOverridesToPreset()) notify('已存进预设「' + preset.name + '」，切预设时会跟着走');
  else notify('没存上');
}

function onToolReset(name: string): void {
  store.resetToolOverride(name);
  notify('已恢复内置默认');
}

/* -------------------- 阶段 7：外部插件（装载 / 卸载） -------------------- */

/**
 * 外部插件装载是**命令式**的（要发网络请求、要 import 代码、要写文件），
 * 所以它没有「响应式真相源」：注册表里的 manifest 是普通 Map，装/卸**不会自己触发界面重算**。
 * 这个 tick 就是给界面用的重算信号（同 mcpTick 那条口径）。
 */
const registryTick = ref(0);
function bumpRegistry(): void {
  registryTick.value += 1;
  loadTools(); // 外部插件可能贡献静态工具：工具目录必须跟着重算
}

/** 装载器的宿主依赖（fetch + CSRF）——生产实现放在 loader 里，界面不碰细节 */
const loaderDeps = createLoaderDeps();

/**
 * 把一次安装的结果落进数据（清单 + 哈希 + 错误），并给用户一句人话。
 *
 * ⚠️ **先注册进注册表，再写数据**：写数据会触发落盘，而落盘之后界面立刻会重算
 * （`tools` / `pages` 都是 computed）—— 顺序反了会闪一下「装上了但什么都没变」。
 */
function applyInstallResult(result: InstallResult, source: 'url' | 'paste', origin: string): boolean {
  if (!result.ok || !result.id || !result.manifest) {
    notify('装不上：' + (result.error ?? '未知原因'));
    return false;
  }
  const record: ExternalPlugin = {
    id: result.id,
    name: result.manifest.name || result.id,
    version: result.manifest.version || '',
    api_version: result.manifest.apiVersion ?? 1,
    source,
    origin: origin || '',
    code_path: result.code_path ?? '',
    hash: result.hash ?? '',
    installed_at: Date.now(),
    last_error: '',
  };
  store.setExternalPlugin(record);
  // 装完默认**开着**：用户刚装的东西不生效会以为装坏了（要停用他自己关）。
  // 这条与 registry 里「外部插件 defaultEnabled 定死为 true」是**同一口径的两道保险** ——
  // 只写一边的话，界面的开关与注册表的装载判断会分叉（真机验收踩过）。
  store.setPluginEnabled(result.id, true);
  bumpRegistry();
  notify((result.updated ? '已更新外部插件：' : '已装上外部插件：') + record.name);
  return true;
}

/** 从 URL 安装 */
async function onExternalInstallUrl(payload: { url: string }): Promise<void> {
  const url = String(payload?.url ?? '').trim();
  if (!url) return;
  const result = await installFromUrl(url, loaderDeps);
  applyInstallResult(result, 'url', url);
}

/** 从粘贴的代码安装 */
async function onExternalInstallPaste(payload: { code: string }): Promise<void> {
  const code = String(payload?.code ?? '');
  if (!code.trim()) return;
  const result = await installFromCode(code, { source: 'paste' }, loaderDeps);
  applyInstallResult(result, 'paste', '');
}

/**
 * 卸载：**先注销注册表与数据，再删文件**。
 *
 * 顺序理由：删文件要发网络请求（可能失败 / 慢），而「卸载」对用户应该是**立刻**生效的；
 * 文件删失败最多留个孤儿文件，不会让界面停在一个已经不存在的插件上。
 */
async function onExternalUninstall(payload: { id: string }): Promise<void> {
  const id = String(payload?.id ?? '').trim();
  if (!id) return;
  const record = store.data.external_plugins.find(item => item.id === id);
  const path = record?.code_path ?? '';
  const name = record?.name ?? id;
  store.removeExternalPlugin(id);
  bumpRegistry();
  try {
    await uninstallPlugin(id, path, loaderDeps);
    notify('已卸载：' + name);
  } catch (error) {
    // 数据已经清干净了，这里只可能是文件没删掉 —— 如实说，别假装成功
    notify('已卸载 ' + name + '，但它的代码文件没删掉：' + (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * 启动 / 刷新时装载已安装的外部插件（幂等）。
 *
 * 每个插件的失败都写回它自己的 `last_error`（界面按行显示），**绝不连坐** ——
 * 一个坏插件不能把整个面板拖垮（失败隔离的落点，见 loader 的注释）。
 */
async function loadExternalPlugins(): Promise<void> {
  const installed = store.data.external_plugins;
  if (!installed.length) return;
  const result = await loadInstalled(installed, loaderDeps);
  // ⚠️ 装载**成功**也要重算工具目录：外部插件的静态工具（ext_hello 那类）不在挂载时那份
  //    catalog 里，不重算的话「能力 · 工具」永远少它们 —— 真机验收就是这么抓到的
  //    （诊断显示 pluginAll 有 ext_hello，而界面 16 行里没有它）。
  if (result.loaded.length) loadTools();
  let dirty = false;
  for (const item of result.failed) {
    if (store.data.external_plugins.find(row => row.id === item.id)?.last_error !== item.error) dirty = true;
    store.setExternalPluginError(item.id, item.error);
  }
  for (const id of result.loaded) {
    if (store.data.external_plugins.find(row => row.id === id)?.last_error) dirty = true;
    store.setExternalPluginError(id, '');
  }
  if (result.loaded.length) bumpRegistry();
  void dirty; // 落盘由 store 的写点各自负责（setExternalPluginError 内部已经 save）
}

/* -------------------- 阶段 6：MCP 插件（服务器清单 + 连接） -------------------- */

/**
 * MCP 的设置就在 plugins.mcp —— 设置归插件、开关仍归 plugin_state（老口径不破）。
 * store.data 已经过 zod parse，所以 mcp.servers 一定存在（prefault 兜底）。
 */
const mcpConfig = computed(() => store.data.plugins.mcp);

/**
 * 连接动作的「重算信号」。
 *
 * ⚠️ 为什么需要它：connection.ts 的 sessions 是**模块级普通对象**（故意的：它不该依赖 vue），
 * 所以连上 / 断开这件事**不会自己触发 Vue 重算**。下面两个只读计算属性靠这个 tick 依赖它 ——
 * 没有它，用户点了「连接」，工具清单要等下一次别的数据变动才刷新（看起来像没生效）。
 */
const mcpTick = ref(0);
function mcpBump(): void {
  mcpTick.value += 1;
  // 工具目录也要跟着重算：运行时注册的工具（cx_ping 那类）不在挂载时那份目录里，
  // 不重算的话「能力 · 工具」永远少它们 —— 界面又替底层撒谎了。
  loadTools();
}

/**
 * 每台服务器该显示的状态（详情页那一行）。
 *
 * 分工：**「连上没有」只由 connection.ts 回答**（它持有运行时真相）；
 * 「未启用 / 缺地址」这类不依赖运行时的事在这里兜底，免得没连过的服务器显示「未连接」却没原因。
 */
const mcpStatuses = computed<Record<string, { label: string; kind: '' | 'ok' | 'warn' | 'dang' }>>(() => {
  void mcpTick.value; // 依赖信号：连接动作后必须重算
  const out: Record<string, { label: string; kind: '' | 'ok' | 'warn' | 'dang' }> = {};
  for (const server of mcpConfig.value.servers) {
    if (server.enabled === false) {
      out[server.id] = { label: '未启用', kind: '' };
      continue;
    }
    if (!server.url.trim()) {
      out[server.id] = { label: '缺地址', kind: 'warn' };
      continue;
    }
    out[server.id] = serverStatus(server.id);
  }
  return out;
});

/** 每台服务器当前带来的**远端**工具名（没连上就是空数组）—— 页面拿它画逐条停用的勾选框 */
const mcpTools = computed<Record<string, string[]>>(() => {
  void mcpTick.value;
  const out: Record<string, string[]> = {};
  for (const server of mcpConfig.value.servers) out[server.id] = serverToolNames(server.id);
  return out;
});

/**
 * 取宿主 fetch（能力名 'fetch'）。
 *
 * **晚绑定**：拿不到就返回 null，由 connection.ts 翻成「这台机器没有网络能力」的人话 ——
 * 而不是在这儿抛，把整页渲染打断（协议层与连接层的口径一致：失败是返回值，不是异常）。
 */
function mcpFetch(): typeof fetch | null {
  const fn = hostFn('fetch') as typeof fetch | undefined;
  return typeof fn === 'function' ? fn : null;
}

/**
 * 把一次连接结果写回配置（last_error / last_ok_at）。
 *
 * ⚠️ 这一步不能省：connection.ts 不碰持久化，而 manifest.status() 读的正是 config 里的
 * last_error / last_ok_at —— 不写回去，连不上的服务器在插件列表里会一直显示「已连接 N 台」，
 * 那就是界面替底层撒谎。
 */
function persistMcpResult(result: { id: string; ok: boolean; error?: string; at: number }): void {
  const server = mcpConfig.value.servers.find(item => item.id === result.id);
  if (!server) return;
  server.last_error = result.ok ? '' : (result.error ?? '连接失败');
  if (result.ok) server.last_ok_at = result.at;
}

/** 连一台（用户在服务器页点「连接 / 刷新」） */
async function connectMcpServer(id: string): Promise<void> {
  const server = mcpConfig.value.servers.find(item => item.id === id);
  if (!server) return;
  const result = await connectServer(server, mcpFetch);
  persistMcpResult(result);
  mcpBump();
  store.save();
  if (!result.ok) notify('MCP 连接失败：' + (result.error ?? '未知原因'));
}

function disconnectMcpServer(id: string): void {
  disconnectServer(id);
  mcpBump();
}

/** 服务器页的三个动作（连接 / 断开 / 刷新） */
async function onMcpAction(payload: { id: string; action: 'connect' | 'disconnect' | 'refresh' }): Promise<void> {
  if (payload.action === 'disconnect') {
    disconnectMcpServer(payload.id);
    return;
  }
  // 刷新 = 先断开再连：远端改了工具清单只有重连才看得到
  if (payload.action === 'refresh') disconnectMcpServer(payload.id);
  await connectMcpServer(payload.id);
}

function onMcpPatch(payload: { id: string; patch: Partial<McpServer> }): void {
  const server = mcpConfig.value.servers.find(item => item.id === payload.id);
  if (!server) return;
  Object.assign(server, payload.patch);
  // 落盘交给页面的 @change（store.save()），这里不重复写
}

/**
 * 每行服务器都必须有 id —— id 就是这行的身份：连接、逐条停用的归属、错误写回全靠它。
 *
 * ⚠️ 这段是**真机验收逼出来的兜底**：页面上的「加入清单」最初只给了名字与地址，
 * 行里 id 是空的，于是点「连接」直接被拒（connection.ts 的防御分支报了
 * 「这台服务器没有 id，没法建立连接」）。**身份不该由展示层保证** ——
 * 宿主在这里统一补，页面漏给 / 老数据里没有，都自动修好。
 *
 * 返回「补过没有」，补过就要落盘（不然刷新又变回空 id）。
 */
function ensureMcpIds(): boolean {
  let changed = false;
  for (const server of mcpConfig.value.servers) {
    if (typeof server.id === 'string' && server.id.trim()) continue;
    server.id = uid();
    changed = true;
  }
  return changed;
}

function onMcpAdd(payload: { server: McpServer }): void {
  mcpConfig.value.servers.push({ ...payload.server, id: uid() });
  store.save();
}

function onMcpRemove(payload: { id: string }): void {
  // 先断开再删：留在 sessions 里的连接会让「已连接 N 台」多算一台
  disconnectMcpServer(payload.id);
  const list = mcpConfig.value.servers;
  const index = list.findIndex(item => item.id === payload.id);
  if (index >= 0) list.splice(index, 1);
}

/**
 * 按配置同步一遍连接（幂等）。三个时机调它：面板启动、插件开关变化、导入数据之后。
 *
 * 插件**关着**时把连接全部断干净：注册表层已经挡住工具（loadablePlugins），
 * 但留着连接会让下次打开时拿一个旧会话冒充「已连接」。
 */
async function syncMcp(): Promise<void> {
  if (!pluginEnabled(store.data, 'mcp')) {
    disconnectAll();
    mcpBump();
    return;
  }
  // 先修身份（老数据 / 页面漏给），再按配置连 —— id 不对的话连接一定失败
  if (ensureMcpIds()) store.save();
  const results = await syncServers(mcpConfig.value.servers, mcpFetch);
  if (!results.length) return; // 幂等：什么都没动就不要白写一次盘
  for (const result of results) persistMcpResult(result);
  mcpBump();
  store.save();
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
  // MCP：「关掉即消失」的第四层 —— 关插件要断开全部服务器，打开则按配置连上。
  void syncMcp();
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

  // ---- B44：三类单独导出（D8）----
  if (action === 'export-tool-prompts') {
    download(transferFileName('tool-prompts', '工具提示词'), exportToolPrompts(store.data.tool_overrides));
    notify('已导出工具提示词');
    return;
  }
  if (action === 'export-current-preset') {
    const preset = store.activePreset;
    if (!preset) { notify('先选一个预设'); return; }
    download(transferFileName('preset', preset.name), exportPreset(preset));
    notify('已导出预设「' + preset.name + '」');
    return;
  }
  if (action === 'export-all-skills') {
    // 技能是**多个**，所以导出成一个数组信封（仍是单文件 JSON，T4）
    const payload = { kind: 'skills', version: 1, skills: store.data.skills };
    download(transferFileName('skill', '全部技能'), JSON.stringify(payload, null, 2));
    notify('已导出 ' + store.data.skills.length + ' 个技能');
    return;
  }

  // ---- B44：三类单独导入 ----
  if (action === 'import-tool-prompts' || action === 'import-preset' || action === 'import-skill') {
    const kind = action === 'import-tool-prompts' ? 'tool-prompts' : action === 'import-preset' ? 'preset' : 'skill';
    const file = await pickFile('application/json,.json');
    if (!file) return;
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      notify('读文件失败：' + String((err as Error).message || err));
      return;
    }
    // 撞车判定：只把**用户自己的**放进来（内置走「直接拒绝」那条路）
    const existing: Record<string, string> = {};
    const builtinIds: string[] = [];
    if (kind === 'preset') {
      for (const p of store.data.presets) {
        if (p.builtin) builtinIds.push(p.id);
        else existing[p.id] = p.name;
      }
    }
    if (kind === 'skill') {
      for (const s of store.data.skills) {
        if (s.builtin) builtinIds.push(s.id);
        else existing[s.id] = s.name;
      }
    }
    const res = importTransfer(text, { expect: kind, existing, builtinIds });
    if (!res.ok) { notify('导入失败：' + String(res.error || '文件不对')); return; }

    if (kind === 'tool-prompts') {
      store.replaceToolOverrides(res.overrides ?? {});
      notify('已导入工具提示词（' + Object.keys(res.overrides ?? {}).length + ' 项）');
      return;
    }

    // 预设 / 技能：撞车要问（T5：覆盖 / 另存为 / 取消）
    if (kind === 'preset' && res.preset) {
      await landPreset(res.preset, res.conflict);
      return;
    }
    if (kind === 'skill' && res.skill) {
      await landSkill(res.skill, res.conflict);
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

/* -------------------- B44：三类导入的落地（撞车要问） -------------------- */

/**
 * 落地一个导入的预设。
 *
 * 撞车时问用户（T5：覆盖 / 另存为 / 取消）—— **不自己替用户决定**。
 * 「另存为」那条路会生成新 id，所以不会覆盖任何东西。
 */
async function landPreset(preset: Preset, conflict?: { id: string; name: string }): Promise<void> {
  let incoming = preset;
  if (conflict) {
    const overwrite = confirm(
      '已经有一份叫「' + conflict.name + '」的预设了。\n\n' +
        '确定 = 覆盖它\n取消 = 另存为一份新的（不覆盖）',
    );
    if (overwrite) store.updatePreset(conflict.id, { ...preset, id: conflict.id });
    else incoming = { ...preset, id: uid('preset'), name: preset.name + '（导入）', builtin: false };
    if (overwrite) {
      notify('已覆盖预设「' + conflict.name + '」');
      return;
    }
  }
  const made = store.addPreset({ ...incoming, builtin: false });
  notify('已导入预设「' + made.name + '」');
}

/** 落地一个导入的技能（撞车语义同预设） */
async function landSkill(skill: Skill, conflict?: { id: string; name: string }): Promise<void> {
  let incoming = skill;
  if (conflict) {
    const overwrite = confirm(
      '已经有一个叫「' + conflict.name + '」的技能了。\n\n' +
        '确定 = 覆盖它\n取消 = 另存为一份新的（不覆盖）',
    );
    if (overwrite) {
      // 走 onSkillSave：技能内容真源在 ST 文件里，必须一起写过去
      await onSkillSave({ ...skill, id: conflict.id, builtin: false });
      notify('已覆盖技能「' + conflict.name + '」');
      return;
    }
    incoming = { ...skill, id: uid('skill'), name: skill.name + '（导入）', builtin: false };
  }
  await onSkillSave({ ...incoming, builtin: false });
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