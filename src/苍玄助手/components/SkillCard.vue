<template>
  <div class="cx-skill" :class="{ off: !skill.enabled }" @click="emit('edit')">
    <input type="checkbox" :checked="skill.enabled" @click.stop @change="emit('toggle')" />
    <div class="cx-skill-main">
      <div class="cx-sn-row">
        <span class="cx-sn">{{ skill.name || '（未命名技能）' }}</span>
        <span v-if="skill.builtin" class="cx-tag">内置</span>
      </div>
      <div class="cx-sd">{{ skill.summary || '（还没写一句话描述）' }}</div>
      <div class="cx-sm">正文 {{ sizeLabel(skill.body) }} 字<template v-if="skill.files.length"> · 参考文件 {{ skill.files.length }} 个</template><template v-else> · 无参考文件</template><template v-if="!skill.enabled"> · 已关</template></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Skill } from '../core/types.ts';
import { sizeLabel } from './ui_types.ts';

/** 技能页的一张卡片：开关 + 名称 + 描述 + 正文大小 / 参考文件数 */
defineProps<{ skill: Skill }>();
const emit = defineEmits<{ edit: []; toggle: [] }>();
</script>
