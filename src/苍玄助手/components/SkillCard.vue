<template>
  <div class="cx-skill" :class="{ off: !skill.enabled }" @click="emit('edit')">
    <input type="checkbox" :checked="skill.enabled" @click.stop @change="emit('toggle')" />
    <div class="cx-skill-main">
      <div class="cx-sn-row">
        <span class="cx-sn">{{ skill.name || '（未命名技能）' }}</span>
        <span v-if="skill.builtin" class="cx-tag">插件带的</span>
      </div>
      <div class="cx-sd">{{ skill.summary || '（还没写一句话描述）' }}</div>
      <div class="cx-sm">正文 {{ sizeLabel(skill.body) }} 字<template v-if="skill.files.length"> · 参考文件 {{ skill.files.length }} 个</template><template v-else> · 无参考文件</template><template v-if="!skill.enabled"> · 已关</template></div>
    </div>
    <!--
      B54「恢复默认」：只有**插件带的**技能才有出厂内容可恢复（用户自建的没有「默认」可言）。
      按钮点击必须 stop：整行是「点开编辑」，不 stop 的话恢复完会顺手弹出编辑窗。
    -->
    <button
      v-if="skill.builtin"
      class="cx-tiny"
      type="button"
      title="把这个技能的内容恢复成插件出厂版本（你改过的会没）"
      @click.stop="emit('restore')"
    >
      恢复默认
    </button>
  </div>
</template>

<script setup lang="ts">
import type { Skill } from '../core/types.ts';
import { sizeLabel } from './ui_types.ts';

/** 技能页的一张卡片：开关 + 名称 + 描述 + 正文大小 / 参考文件数 + 恢复默认 */
defineProps<{ skill: Skill }>();
const emit = defineEmits<{ edit: []; toggle: []; restore: [] }>();
</script>
