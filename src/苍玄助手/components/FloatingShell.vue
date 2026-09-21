<template>
  <!--
    悬浮球 + 弹出面板（用户选的 A 方案）。

    宿主背景（阶段 3.5 起，且已经用真代码核对过）：
      - 面板宿主是 #extensions_settings2（酒馆设置面板里的普通 div），**不是 iframe**。
        实测来源：src/extension/index.ts 的 mountTarget() + mount.ts 的 app.mount(container)。
        所以 window/document 就是酒馆页面的，position:fixed 的参照系是酒馆视口。
      - 另一条路（酒馆助手脚本 / tavern_script/frame.html）里 —— 但那是**酒馆助手脚本**自己的
        面板 iframe，里面再套我们这一层 iframe；它有自己的关闭按钮，是另一条路的界面。
        注意：酒馆助手【前端界面】那条路才是「高度自适应 iframe」（会量 body.scrollHeight），
        本组件运行时**不在**那条路上，所以不能按 iframe 的假设写。

    于是：球用 position:fixed 钉在右下角，面板用 position:fixed 浮在上方；
    两者都不占文档流（放进 display:contents 的挂载点里也不影响酒馆布局）。
  -->
  <button
    ref="ballEl"
    class="cx-ball"
    :class="{ on: open }"
    type="button"
    :title="open ? '收起' + title : '打开' + title"
    :aria-expanded="open ? 'true' : 'false'"
    @click="toggle"
  >
    <span class="cx-ball-i" aria-hidden="true">∞</span>
    <span class="cx-ball-r" :class="{ on: running }" aria-hidden="true"></span>
    <span class="cx-sr">{{ tabTitle }}</span>
  </button>

  <div v-if="open" ref="panelEl" class="cx-pw" role="dialog" :aria-label="title">
    <slot></slot>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useSlots } from 'vue';

/**
 * 面板外壳：右下角一颗常驻悬浮球，点开弹出面板，再点 / 点 ✕ / 点面板外收起。
 *
 * ⚠️ slot 必须**直接**写在 <div class="cx-pw"> 里（模板里的 <slot/>）。
 *
 * 为什么包一层 .cx-pw 而不是把 slot 铺在根层级：本组件是**多根节点**模板，
 * 「点面板外收起」要判断 event.target 在不在面板内。包一层真实元素后，
 * 面板里的一切（含视图自己的弹窗）都落在 panelEl.contains() 的覆盖范围里，判定干净。
 *
 * ⚠️⚠️ 更关键的一条（**真机上踩过，别再犯**）：不要用「空壳子组件」去转发这个 slot。
 *   曾经写过：
 *     const SlotTarget = { setup(_, { slots }) { return () => slots.default?.() ?? []; } };
 *     <div class="cx-pw"><SlotTarget /></div>
 *   看起来能把 slot 原样带进去，实际**渲染成空** —— 子组件 setup 里的 slots 是
 *   **它自己**的 slots，而没有任何人给 SlotTarget 传过 slot。
 *   真机现象：点开悬浮球后 .cx-pw.childElementCount === 0（面板是个空盒子，
 *   52×52 的球照常显示），**控制台一声不响、没有任何报错**。
 *   所以这里就用模板里的 <slot/> —— 它在**本组件**的渲染作用域里求值，才是父组件传进来的那份。
 */

const props = withDefaults(
  defineProps<{
    /** 标题（顶栏 + 悬浮球 title 用） */
    title?: string;
    /** 当前页名（悬浮球的可访问性文案） */
    tabTitle?: string;
    /** agent 跑着吗 —— 跑着时悬浮球点亮一个小青点 */
    running?: boolean;
  }>(),
  {
    title: '苍玄助手',
    tabTitle: '',
    running: false,
  },
);
const emit = defineEmits<{ close: [] }>();

const open = ref(false);
const ballEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);

function toggle(): void {
  setOpen(!open.value);
}

function setOpen(next: boolean): void {
  if (open.value === next) return;
  open.value = next;
  if (!next) emit('close');
  syncListeners();
}

/**
 * 点面板外 / 按 Esc 收起。
 *
 * 用 capture 阶段监听：面板里的视图自己会 stopPropagation（比如消息区的点击手势），
 * 冒泡阶段收不到就只能「点了外面没反应」。
 *
 * 面板外的判定有两条豁免：
 *  1. 点的是悬浮球 —— 那是 toggle，不在外面；
 *  2. 点在**别的**浮层里（Sheet 的暗幕 / 弹窗）—— 那多半是用户在操作弹窗，
 *     收起主面板会把弹窗一起带走，非常难受。判定办法：往上找目标元素有没有固定层级的兄弟浮层。
 */
function isInsidePanel(target: Node | null): boolean {
  if (!target) return false;
  if (panelEl.value && panelEl.value.contains(target)) return true;
  if (ballEl.value && ballEl.value.contains(target)) return true;
  return isInForeignOverlay(target);
}

/**
 * 目标是不是落在「面板之外的另一层浮层」里。
 *
 * 判据：沿 target 往上走，遇到一个 fixed/absolute 定位、且带较高 z-index 的祖先，
 * 就认为它属于别的浮层。酒馆页面里 .cx- 前缀之外的元素不归我们管，但那也正是要放过的情况。
 * 只看 z-index >= 95：我们自己的弹窗（.cx-sheet z-index:100）与酒馆的对话弹窗都在这个量级；
 * 页面里普通的相对定位元素（z-index:auto/0）不会被误判。
 */
function isInForeignOverlay(target: Node): boolean {
  let node: Node | null = target;
  while (node && node !== document.body) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node);
      if ((style.position === 'fixed' || style.position === 'absolute') && Number(style.zIndex) >= 95) {
        return true;
      }
    }
    node = node.parentNode;
  }
  return false;
}

function onDocPointerDown(event: Event): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (!isInsidePanel(target)) setOpen(false);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) setOpen(false);
}

function syncListeners(): void {
  if (typeof document === 'undefined') return;
  // 幂等：重复加同一个函数引用不会叠加（addEventListener 会去重）
  if (open.value) {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeydown, true);
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onKeydown, true);
  }
}

/** 供外部（App.vue 的 ✕ / 视图跳转）调用 */
defineExpose({ open, setOpen, toggle });

onMounted(() => {
  // 收敛一次：模块热重载 / 重复挂载时别留下野监听
  syncListeners();
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
});
</script>
