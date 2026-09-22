<template>
  <div class="cx-body">
    <!-- ============ 列表 ============ -->
    <template v-if="!detail">
      <div class="cx-blk">
        <div class="cx-blkh">
          <span class="cx-t">MCP 服务器</span>
          <span class="cx-n">{{ config.servers.length }} 台 · {{ connectedCount }} 台已连接</span>
          <span class="cx-spacer"></span>
        </div>

        <div class="cx-list">
          <div
            v-for="server in config.servers"
            :key="server.id"
            class="cx-mcp-row"
            role="button"
            tabindex="0"
            :title="'打开 ' + labelOf(server)"
            @click="open(server.id)"
            @keydown.enter.prevent="open(server.id)"
            @keydown.space.prevent="open(server.id)"
          >
            <div class="cx-mcp-main">
              <div class="cx-mcp-name">
                <span class="cx-nm">{{ labelOf(server) }}</span>
                <span class="cx-tag" :class="statusKind(server)">{{ statusLabel(server) }}</span>
              </div>
              <div class="cx-mcp-url">{{ server.url || '还没填地址' }}</div>
            </div>
            <!-- 开关：点了不该顺带把详情打开 -->
            <Sw :model-value="server.enabled" @update:model-value="toggleEnabled(server, $event)" @click.stop />
            <span class="cx-mcp-arrow" aria-hidden="true">›</span>
          </div>
        </div>

        <p v-if="config.servers.length === 0" class="cx-hint cx-mt8">
          还没有 MCP 服务器。填一个地址再加，连上之后它的工具就能给模型用。
        </p>
      </div>

      <!-- 新增：名字 + 地址。地址为空时按钮禁用（空地址连不上，别让用户点了个必然失败的键） -->
      <div class="cx-blk">
        <div class="cx-blkh">
          <span class="cx-t">新增服务器</span>
          <span class="cx-spacer"></span>
        </div>
        <div class="cx-f">
          <label class="cx-lab">名字（可留空，界面会用地址显示）</label>
          <input v-model="draftName" type="text" placeholder="例如：本地工具集" />
        </div>
        <div class="cx-f">
          <label class="cx-lab">地址（MCP 服务器 URL）</label>
          <input v-model="draftUrl" type="text" placeholder="http://127.0.0.1:3000/mcp" />
        </div>
        <button class="cx-fill" type="button" :disabled="!draftUrl.trim()" @click="addServer">加入清单</button>
        <p class="cx-hint cx-mt8">加进来只是记账，还得在下面那台里点「连接」才会真的连。</p>
      </div>
    </template>

    <!-- ============ 详情 ============ -->
    <template v-else>
      <div class="cx-blk">
        <div class="cx-blkh">
          <button class="cx-ghost" type="button" @click="detail = ''">‹ 返回</button>
          <span class="cx-t">{{ labelOf(detail) }}</span>
          <span class="cx-tag" :class="statusKind(detail)">{{ statusLabel(detail) }}</span>
          <span class="cx-spacer"></span>
          <button class="cx-ghost dang" type="button" @click="removeServer(detail)">删除</button>
        </div>

        <div class="cx-f">
          <label class="cx-lab">名字</label>
          <input
            type="text"
            :value="detail.name"
            placeholder="例如：本地工具集"
            @input="patchName(detail, $event)"
          />
        </div>

        <div class="cx-f">
          <label class="cx-lab">地址</label>
          <input type="text" :value="detail.url" placeholder="http://127.0.0.1:3000/mcp" @input="patchUrl(detail, $event)" />
        </div>

        <!-- 连接动作。连不上时它自己会写 last_error，详情底部显示原文。 -->
        <!-- 动作键走既有 .cx-tiny（手机端有 40px 点击区），不新造类 -->
        <div class="cx-frow cx-mcp-acts">
          <button class="cx-tiny" type="button" @click="act(detail, 'connect')">连接</button>
          <button class="cx-tiny" type="button" :disabled="!isConnected(detail)" @click="act(detail, 'disconnect')">
            断开
          </button>
          <button class="cx-tiny" type="button" :disabled="!isConnected(detail)" @click="act(detail, 'refresh')">
            刷新工具
          </button>
        </div>
      </div>

      <!-- 请求头（密钥） -->
      <div class="cx-blk">
        <div class="cx-blkh">
          <span class="cx-t">请求头</span>
          <span class="cx-n">{{ rows.length }} 条</span>
          <span class="cx-spacer"></span>
          <button class="cx-ghost" type="button" @click="addHeader">＋ 加一条</button>
        </div>

        <div v-for="(row, index) in rows" :key="index" class="cx-mcp-hdr">
          <input type="text" :value="row.name" placeholder="Authorization" @input="renameHeader(index, $event)" />
          <input
            type="password"
            :value="row.value"
            placeholder="Bearer …"
            autocomplete="off"
            spellcheck="false"
            @input="setHeaderValue(index, $event)"
          />
          <button class="cx-tiny dang" type="button" title="删掉这条" @click="removeHeader(index)">✕</button>
        </div>

        <p v-if="rows.length === 0" class="cx-hint">没有额外请求头。需要鉴权就加一条，例如 <code>Authorization</code>。</p>
        <!-- 与设置页 API Key 同一口径：明文存储这件事必须说出来 -->
        <p class="cx-hint cx-mt8">
          请求头的值是密钥，<b>明文存在本地变量里</b>（跟 API Key 一样）。别把带密钥的数据导出后发给别人。
        </p>
      </div>

      <!-- 工具清单：逐条停用 -->
      <div class="cx-blk">
        <div class="cx-blkh">
          <span class="cx-t">这一台的工具</span>
          <span class="cx-n">{{ toolsOf[detail.id]?.length ?? 0 }} 个 · 停用 {{ disabledCount }} 个</span>
          <span class="cx-spacer"></span>
        </div>

        <div v-if="!isConnected(detail)" class="cx-hint">
          还没连上，读不到工具清单。点上面的「连接」试试。
        </div>
        <template v-else>
          <div class="cx-list">
            <label v-for="name in toolsOf[detail.id] ?? []" :key="name" class="cx-row cx-mcp-tool">
              <input type="checkbox" :checked="toolEnabled(detail, name)" @change="toggleTool(detail, name)" />
              <span class="cx-nm cx-mono">{{ name }}</span>
              <span v-if="!toolEnabled(detail, name)" class="cx-tag dang">已停用</span>
            </label>
          </div>
          <p v-if="(toolsOf[detail.id] ?? []).length === 0" class="cx-hint">这台服务器没提供工具。</p>
          <p class="cx-hint cx-mt8">勾掉 = 不给模型用（跨刷新有效）。停用只在来源处，别处不用再管。</p>
        </template>
      </div>

      <!-- 最近错误原文 -->
      <div v-if="detail.last_error" class="cx-blk">
        <div class="cx-blkh">
          <span class="cx-t">最近一次错误</span>
          <span class="cx-spacer"></span>
          <span class="cx-hint">{{ detail.last_ok_at ? '上次连上：' + timeLabel(detail.last_ok_at) : '还没连上过' }}</span>
        </div>
        <pre class="cx-code cx-mcp-err">{{ detail.last_error }}</pre>
        <p class="cx-hint cx-mt8">服务器那边给的原文，没加工。常见原因：地址写错、服务没起、鉴权头不对。</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';

import type { McpConfig, McpServer } from '../../../core/types.ts';
import Sw from './Switch.vue';

/**
 * 「上次连上」用的短时间（06-13 12:34）。
 *
 * 为什么在本目录写一份，而不是 import 宿主的 components/ui_types.ts：
 * 插件目录要能**在没有宿主外壳源码的情况下成立**（外部插件 = 自包含目录 + manifest）。
 * 有测试闸钉着「插件目录的相对 import 只许落在 core / agent / plugins」。
 * 格式照 ui_types.ts 的 timeLabel 抄，口径一致，别自作主张改。
 */
function timeLabel(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 状态标签（App.vue 从 connection.ts 算好喂进来，页面自己不持有运行时状态） */
interface StatusTag {
  label: string;
  kind: '' | 'ok' | 'warn' | 'dang';
}

/**
 * MCP 服务器页（设计稿屏 7）。
 *
 * **只画界面**：连接由 connection.ts（native-adapter）+ App.vue 负责，
 * 这一页**一个连接相关 import 都没有** —— 状态与工具名都从 props 进来。
 * 这样它是纯展示组件，连接逻辑换实现不用动它，将来也测得了。
 *
 * 为什么状态不自己 import connection.ts 来读（Lead 2026-09 裁决）：
 *  1. 静态 import 一个尚未落地的文件会让 tsc / build 直接红；
 *  2. 得更重要的是**单一事实来源**：谁连上、谁出错由接线层算好，
 *     页面自己也去算一份就会出现两个口径（一处说已连接、一处说没连）。
 *
 * 数据一律走 props，**不许 import store**（插件页的分层硬约束，有测试闸）。
 * 写路径唯一：所有改动都 emit，落盘由 App.vue → store 走既定那条路。
 */
const props = defineProps<{
  /** store.data.plugins.mcp */
  config: McpConfig;
  /** id → 状态标签；没有这个 id 时按下面的兜底口径显示 */
  statuses?: Record<string, StatusTag>;
  /** id → 该服务器当前远端工具名（没连上 = 空数组） */
  toolsOf?: Record<string, string[]>;
}>();

const emit = defineEmits<{
  patch: [{ id: string; patch: Partial<McpServer> }];
  add: [{ server: McpServer }];
  remove: [{ id: string }];
  action: [{ id: string; action: 'connect' | 'disconnect' | 'refresh' }];
  change: [];
}>();

const config = toRef(props, 'config');
const statuses = computed(() => props.statuses ?? {});
const toolsOf = computed(() => props.toolsOf ?? {});

/** 正在看哪一台；空串 = 看清单 */
const detailId = ref('');
/**
 * 正在看的那一行。
 *
 * 按 id 找；**找不到就退回按对象引用找** —— 新增的那行 id 是空的（id 由接线层统一补，
 * 见 App.vue 的 onMcpAdd），补 id 之前 id 一直是 `''`。若用户在补 id 的瞬间正好停在这一行的
 * 详情里，`detailId` 还是空串而 config 里的 id 已经变成真值，纯按 id 找会**查不到、详情整页变空**。
 * 用引用兜住这一段，界面上就不会闪。
 */
const detailRef = ref<McpServer | null>(null);
const detail = computed<McpServer | null>(() => {
  const byId = config.value.servers.find(server => server.id === detailId.value);
  if (byId) return byId;
  const held = detailRef.value;
  if (held && config.value.servers.includes(held)) return held;
  return null;
});

const draftName = ref('');
const draftUrl = ref('');

/* ---------- 状态 ---------- */

/** 连接层的状态优先；没有再按本地能判断的两档兜底 */
function statusLabel(server: McpServer): string {
  const hit = statuses.value[server.id];
  if (hit) return hit.label;
  return server.enabled ? '未连接' : '未启用';
}

function statusKind(server: McpServer): string {
  const hit = statuses.value[server.id];
  if (hit) return hit.kind;
  return '';
}

function isConnected(server: McpServer): boolean {
  return statuses.value[server.id]?.kind === 'ok';
}

const connectedCount = computed(
  () => config.value.servers.filter(server => statuses.value[server.id]?.kind === 'ok').length,
);

function labelOf(server: McpServer): string {
  return server.name.trim() || server.url || '（没名字也没地址）';
}

/* ---------- 写：全部走 emit ---------- */

function patchServer(id: string, patch: Partial<McpServer>) {
  emit('patch', { id, patch });
  emit('change');
}

function open(id: string) {
  detailId.value = id;
  detailRef.value = config.value.servers.find(server => server.id === id) ?? null;
}

function toggleEnabled(server: McpServer, next: boolean) {
  patchServer(server.id, { enabled: next });
  // 关掉的那一台如果正开着详情，退回清单（它的连接也没了，留着没意义）
  if (!next && detailId.value === server.id) {
    detailId.value = '';
    detailRef.value = null;
  }
}

function patchName(server: McpServer, event: Event) {
  patchServer(server.id, { name: readInput(event) });
}

function patchUrl(server: McpServer, event: Event) {
  patchServer(server.id, { url: readInput(event).trim() });
}

function act(server: McpServer, action: 'connect' | 'disconnect' | 'refresh') {
  emit('action', { id: server.id, action });
}

function removeServer(server: McpServer) {
  if (!confirm('删掉「' + labelOf(server) + '」？它的工具会立刻从能力里消失。')) return;
  emit('remove', { id: server.id });
  detailId.value = '';
  detailRef.value = null;
}

function addServer() {
  const url = draftUrl.value.trim();
  if (!url) return;
  // 只在界面侧拼一个形状完整的 McpServer；id 交给接线层统一生成
  //（页面不引 core 的 uid，免得插件页多一条对 agent/ 的依赖）
  emit('add', {
    server: {
      id: '',
      name: draftName.value.trim(),
      url,
      headers: {},
      transport: 'http',
      enabled: true,
      disabled_tools: [],
      last_error: '',
      last_ok_at: 0,
    },
  });
  draftName.value = '';
  draftUrl.value = '';
}

/* ---------- 请求头 ---------- */

/**
 * 请求头的**编辑行**（本地状态）。
 *
 * ⚠️ 为什么不直接从 `headers` 这个 record 派生（原来就是这么写的，有真 bug）：
 * record 的键必须非空，所以「刚点＋加了一条、还没填键名」的空行**存不进去** ——
 * 派生的列表里永远看不到那一行，于是「＋ 加一条」点了没反应，根本加不出请求头。
 * 所以编辑中的行放本地数组：能容纳空键，用户填完才写回 headers。
 *
 * 播种时机：换服务器 / 外部把 headers 换掉（导入、恢复默认）时重新播种。
 * 用 JSON 比对，避免父级每次回写都把我们正在编辑的行冲掉。
 */
interface HeaderRow {
  name: string;
  value: string;
}

const rows = ref<HeaderRow[]>([]);
let seededRows = '';

function seedRows(): void {
  const server = detail.value;
  const next: HeaderRow[] = Object.entries(server?.headers ?? {}).map(([name, value]) => ({ name, value }));
  const stamp = detailId.value + '|' + JSON.stringify(next);
  if (stamp === seededRows) return;
  seededRows = stamp;
  rows.value = next;
}

watch([detailId, () => JSON.stringify(detail.value?.headers ?? {})], seedRows, { immediate: true });

/** 行 → headers 的落盘形状：**空键跳过**（那是还没填完的行，不该写进配置） */
function commitRows(server: McpServer): void {
  const headers: Record<string, string> = {};
  for (const row of rows.value) {
    const key = row.name.trim();
    if (key) headers[key] = row.value;
  }
  patchServer(server.id, { headers });
}

function addHeader() {
  // 只加一行空的本地行，**先不写配置**（键还没填，写进去就是垃圾/被丢弃）
  rows.value = [...rows.value, { name: '', value: '' }];
}

function renameHeader(index: number, event: Event) {
  const server = detail.value;
  if (!server) return;
  const next = rows.value.slice();
  next[index] = { ...next[index], name: readInput(event) };
  rows.value = next;
  commitRows(server);
}

function setHeaderValue(index: number, event: Event) {
  const server = detail.value;
  if (!server) return;
  const next = rows.value.slice();
  next[index] = { ...next[index], value: readInput(event) };
  rows.value = next;
  commitRows(server);
}

function removeHeader(index: number) {
  const server = detail.value;
  if (!server) return;
  rows.value = rows.value.filter((_, at) => at !== index);
  commitRows(server);
}

/* ---------- 逐条停用 ---------- */

function toolEnabled(server: McpServer, name: string): boolean {
  return !server.disabled_tools.includes(name);
}

/**
 * 勾 / 取消勾一条工具。
 *
 * ⚠️ **基准值必须现从 config 里取**，不能用传进来的 `server` 对象 —— 那两个是 props 的
 * 快照：`patchServer` 只 emit、**不就地改 props**（写路径唯一），父级回写前 `server.disabled_tools`
 * 一直是旧的。连续勾两条时第二条会拿旧数组算，把第一条**悄悄抹掉**。
 * （实测：先勾 tool_a 再勾 tool_b，第二次 emit 出 []，两条都没停用。）
 */
function toggleTool(server: McpServer, name: string) {
  const current = config.value.servers.find(item => item.id === server.id)?.disabled_tools ?? [];
  const list = current.slice();
  const at = list.indexOf(name);
  if (at >= 0) list.splice(at, 1);
  else list.push(name);
  patchServer(server.id, { disabled_tools: list });
}

const disabledCount = computed(() => detail.value?.disabled_tools.length ?? 0);

/* ---------- 小工具 ---------- */

function readInput(event: Event): string {
  const el = event.target as HTMLInputElement | null;
  return el ? el.value : '';
}
</script>
