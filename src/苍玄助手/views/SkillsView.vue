<template>
  <div class="cx-body">
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">技能</span>
        <span class="cx-n">{{ data.skills.length }} 个 · 启用 {{ enabledCount }}</span>
        <span class="cx-spacer"></span>
        <button class="cx-ghost" type="button" @click="createSkill">＋ 新建</button>
      </div>
      <SkillCard
        v-for="skill in data.skills"
        :key="skill.id"
        :skill="skill"
        @edit="openEdit(skill)"
        @toggle="toggleSkill(skill)"
      />
      <p v-if="data.skills.length === 0" class="cx-hint">还没有技能。点「＋ 新建」写一个：名称 + 一句话描述 + 正文。</p>
    </div>

    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">怎么用</span>
      </div>
      <div class="cx-hint">
        · 只有<b>名称 + 一句话描述</b>会进模型，正文等它需要时才读 —— 不占 token<br />
        · 模型调用 <span class="cx-code-i">skill("名字")</span> 就能拿到正文，<span class="cx-code-i">read_skill_file</span> 拿参考文件<br />
        · 关掉的技能完全不给模型看<br />
        · 能导入/导出，跟别人换着用
      </div>
    </div>
  </div>

  <!-- 技能编辑弹窗 -->
  <Sheet v-if="draft" :title="isNew ? '新建技能' : '编辑技能'" @close="closeEdit">
    <template #head>
      <Sw :model-value="draft.enabled" @update:model-value="draft.enabled = $event" />
      <span class="cx-tag" :class="draft.enabled ? 'ok' : ''">{{ draft.enabled ? '启用' : '已关' }}</span>
    </template>
    <div>
      <span class="cx-lab">名称</span>
      <input v-model="draft.name" type="text" placeholder="例：世界书精修" />
    </div>
    <div>
      <span class="cx-lab">一句话描述（这句会进模型，写清楚什么时候用）</span>
      <input v-model="draft.summary" type="text" placeholder="例：把啰嗦的条目压成蓝灯精简，保持人设口吻" />
    </div>
    <div>
      <span class="cx-lab">正文（模型调用时才读）</span>
      <textarea v-model="draft.body" class="cx-mono" style="min-height: 170px"></textarea>
    </div>
    <div>
      <span class="cx-lab">参考文件</span>
      <div v-for="(file, index) in draft.files" :key="index" class="cx-sfile">
        <span class="cx-fn">{{ file.name }}</span>
        <span class="cx-fs">{{ sizeLabel(file.content) }}</span>
        <button class="cx-tiny" type="button" @click="openFile(index)">看</button>
        <button class="cx-tiny" type="button" @click="draft.files.splice(index, 1)">删</button>
      </div>
      <button class="cx-tiny cx-mt6" type="button" @click="addFile">＋ 添加文件</button>
    </div>
    <template #footer>
      <button class="cx-ghost dang" type="button" @click="removeSkill">删除</button>
      <button class="cx-ghost dim" type="button" @click="duplicateSkill">复制</button>
      <button class="cx-ghost dim" type="button" @click="emit('export', draft)">导出</button>
      <span class="cx-spacer"></span>
      <button class="cx-ghost" type="button" @click="saveSkill">保存</button>
    </template>
  </Sheet>

  <!-- 参考文件弹窗 -->
  <Sheet v-if="draft && fileIndex !== null && draft.files[fileIndex]" title="参考文件" @close="fileIndex = null">
    <div>
      <span class="cx-lab">文件名</span>
      <input v-model="draft.files[fileIndex].name" type="text" />
    </div>
    <div>
      <span class="cx-lab">内容（跟着技能一起保存）</span>
      <textarea v-model="draft.files[fileIndex].content" class="cx-mono" style="min-height: 220px"></textarea>
    </div>
    <template #footer>
      <button class="cx-ghost dang" type="button" @click="removeFile">删掉这个文件</button>
      <span class="cx-spacer"></span>
      <button class="cx-ghost" type="button" @click="fileIndex = null">关闭</button>
    </template>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from 'vue';

import { RootDataSchema, uid, type RootData, type Skill } from '../core/types.ts';
import Sheet from '../components/Sheet.vue';
import SkillCard from '../components/SkillCard.vue';
import Sw from '../components/Sw.vue';
import { sizeLabel } from '../components/ui_types.ts';

/**
 * 技能页：卡片列表 + 编辑弹窗（名称 / 描述 / 正文 / 参考文件）。
 *
 * 编辑走「本地副本 → 保存时写回」，所以取消（关弹窗）不会改动原技能。
 */
const props = withDefaults(defineProps<{ data?: RootData }>(), {
  data: () => RootDataSchema.parse({}),
});
const emit = defineEmits<{
  save: [skill: Skill];
  delete: [skillId: string];
  duplicate: [skill: Skill];
  export: [skill: Skill];
  /** 卡片上的启用开关：写路径归 store.updateSkill（界面不再直接改 skill.enabled） */
  toggle: [skill: Skill];
}>();

/**
 * 用 ref 句柄拿 data：store 重新 load 时会整个替换 data.value，
 * 缓存成普通对象引用就会一直读旧数据、改到旧对象上。
 */
const data = toRef(props, 'data');

const draft = ref<Skill | null>(null);
const isNew = ref(false);
const fileIndex = ref<number | null>(null);

const enabledCount = computed(() => data.value.skills.filter(skill => skill.enabled).length);

function cloneSkill(skill: Skill): Skill {
  return { ...skill, files: skill.files.map(file => ({ ...file })) };
}

/**
 * 卡片开关：只发事件，真正的写 + 落盘在 store.updateSkill（它内部会 save()）。
 * ⚠️ 这里以前是 `skill.enabled = !skill.enabled` 直接改，靠全局 deep watch 落盘 —— 那条路已经删了。
 */
function toggleSkill(skill: Skill) {
  emit('toggle', skill);
}

function createSkill() {
  draft.value = {
    id: uid('skill'),
    name: '新技能',
    summary: '',
    body: '',
    files: [],
    enabled: true,
    builtin: false,
  };
  isNew.value = true;
  fileIndex.value = null;
}

function openEdit(skill: Skill) {
  draft.value = cloneSkill(skill);
  isNew.value = false;
  fileIndex.value = null;
}

function closeEdit() {
  draft.value = null;
  fileIndex.value = null;
}

function saveSkill() {
  const item = draft.value;
  if (!item) return;
  const index = data.value.skills.findIndex(skill => skill.id === item.id);
  if (index >= 0) data.value.skills[index] = item;
  else data.value.skills.push(item);
  emit('save', item);
  closeEdit();
}

function removeSkill() {
  const item = draft.value;
  if (!item) return;
  if (!isNew.value) {
    const index = data.value.skills.findIndex(skill => skill.id === item.id);
    if (index >= 0) data.value.skills.splice(index, 1);
    emit('delete', item.id);
  }
  closeEdit();
}

function duplicateSkill() {
  const item = draft.value;
  if (!item) return;
  const copy: Skill = cloneSkill(item);
  copy.id = uid('skill');
  copy.name = (item.name || '技能') + '（副本）';
  copy.builtin = false;
  data.value.skills.push(copy);
  emit('duplicate', copy);
  closeEdit();
}

function addFile() {
  const item = draft.value;
  if (!item) return;
  item.files.push({ name: '参考文件' + (item.files.length + 1) + '.md', content: '' });
  fileIndex.value = item.files.length - 1;
}

function openFile(index: number) {
  fileIndex.value = index;
}

function removeFile() {
  const item = draft.value;
  if (!item || fileIndex.value === null) return;
  item.files.splice(fileIndex.value, 1);
  fileIndex.value = null;
}
</script>