<template>
  <section class="flex flex-col gap-2">
    <nav class="flex flex-wrap gap-1">
      <button v-for="item in SECTIONS" :key="item.id" class="cx-btn" :style="tab === item.id ? activeStyle : undefined" @click="tab = item.id">
        {{ item.label }}
      </button>
    </nav>

    <!-- LLM 预设 -->
    <div v-if="tab === 'llm'" class="grid gap-2" style="grid-template-columns: 200px 1fr">
      <div class="flex flex-col gap-1">
        <button class="cx-btn" @click="newLlmPreset()">新建预设</button>
        <div class="cx-scroll" style="max-height: 320px">
          <div v-for="preset in store.data.llm_presets" :key="preset.id" class="flex items-center gap-1">
            <button class="cx-btn" style="flex: 1" :style="store.activePresetId === preset.id ? activeStyle : undefined" @click="store.activePresetId = preset.id">
              {{ preset.name }}
            </button>
            <button v-if="!preset.builtin" class="cx-btn cx-btn-danger" @click="store.removeLlmPreset(preset.id)">删</button>
          </div>
        </div>
      </div>

      <div v-if="store.activePreset" class="flex flex-col gap-2">
        <label class="flex flex-col gap-1"><span class="cx-label">名称</span>
          <input v-model="store.activePreset.name" class="cx-input" /></label>
        <div class="flex flex-wrap gap-2">
          <label class="flex flex-col gap-1"><span class="cx-label">目标格式</span>
            <select v-model="store.activePreset.target" class="cx-select" style="min-width: 140px">
              <option value="zhihatsuki">智绘姬</option><option value="xiaobaix">小白x</option><option value="custom">自定义</option>
            </select></label>
          <label class="flex flex-col gap-1"><span class="cx-label">冲突处理</span>
            <select v-model="store.activePreset.conflict" class="cx-select" style="min-width: 140px">
              <option value="overwrite">覆盖</option><option value="skip">跳过</option><option value="rename">改名保留</option>
            </select></label>
          <label class="flex flex-col gap-1"><span class="cx-label">批大小</span>
            <input v-model.number="store.activePreset.batch_size" type="number" min="1" max="20" class="cx-input" style="width: 80px" /></label>
          <label class="flex flex-col gap-1"><span class="cx-label">温度</span>
            <input v-model.number="store.activePreset.temperature" type="number" step="0.1" min="0" max="2" class="cx-input" style="width: 80px" /></label>
          <label class="flex flex-col gap-1"><span class="cx-label">重试次数</span>
            <input v-model.number="store.activePreset.max_retries" type="number" min="0" max="5" class="cx-input" style="width: 80px" /></label>
        </div>
        <div class="flex flex-wrap gap-2">
          <label class="flex flex-col gap-1"><span class="cx-label">模板挂载</span>
            <select v-model="store.activePreset.template_mode" class="cx-select" style="min-width: 160px">
              <option value="reference">引用模板库</option><option value="embedded">内嵌本预设</option>
            </select></label>
          <label v-if="store.activePreset.template_mode === 'reference'" class="flex flex-col gap-1">
            <span class="cx-label">引用的模板</span>
            <select v-model="store.activePreset.template_id" class="cx-select" style="min-width: 220px">
              <option v-for="template in store.data.templates" :key="template.id" :value="template.id">{{ template.name }}</option>
            </select></label>
          <label class="flex flex-col gap-1"><span class="cx-label">元数据规则</span>
            <select v-model="store.activePreset.meta_extract_rule_id" class="cx-select" style="min-width: 200px">
              <option v-for="rule in store.data.meta_extract_rules" :key="rule.id" :value="rule.id">{{ rule.name }}</option>
            </select></label>
        </div>
        <label class="flex items-center gap-2 text-[11px]">
          <input v-model="store.activePreset.use_json_schema" type="checkbox" />
          <span>把模板里的 JSON Schema 交给酒馆做强制结构化输出</span>
        </label>

        <label class="flex flex-col gap-1"><span class="cx-label">系统提示词</span>
          <textarea v-model="store.activePreset.system_prompt" class="cx-textarea" style="min-height: 60px"></textarea></label>
        <label class="flex flex-col gap-1"><span class="cx-label">转换指令（核心）</span>
          <textarea v-model="store.activePreset.instruction" class="cx-textarea" style="min-height: 140px"></textarea></label>
        <label class="flex flex-col gap-1"><span class="cx-label">参考示例（可选）</span>
          <textarea v-model="store.activePreset.few_shot" class="cx-textarea" style="min-height: 80px"></textarea></label>

        <fieldset class="flex flex-col gap-1" style="border: 1px solid var(--cx-border-soft); border-radius: 6px; padding: 6px">
          <legend class="cx-label">从回复中提取 JSON</legend>
          <div class="flex flex-wrap gap-2">
            <label class="flex flex-col gap-1"><span class="cx-label">标记名</span>
              <input v-model="store.activePreset.reply_extract.label" class="cx-input" style="width: 100px" /></label>
            <label class="flex flex-col gap-1"><span class="cx-label">提取方式</span>
              <select v-model="store.activePreset.reply_extract.mode" class="cx-select" style="min-width: 200px">
                <option value="fenced">代码块围栏</option>
                <option value="labeled_brace">标记名 + 花括号</option>
                <option value="regex">自定义正则</option>
                <option value="whole">整段即 JSON</option>
              </select></label>
            <label class="flex flex-col gap-1"><span class="cx-label">JSON 路径（可选）</span>
              <input v-model="store.activePreset.reply_extract.json_path" class="cx-input" style="width: 180px" /></label>
          </div>
          <label v-if="store.activePreset.reply_extract.mode === 'regex'" class="flex flex-col gap-1">
            <span class="cx-label">正则（取第 1 个捕获组）</span>
            <input v-model="store.activePreset.reply_extract.custom_regex" class="cx-input" /></label>
        </fieldset>
      </div>
    </div>
<!-- 其余子页签在下一段补充 -->
    <!-- JSON 模板 -->
    <div v-if="tab === 'template'" class="grid gap-2" style="grid-template-columns: 200px 1fr">
      <div class="flex flex-col gap-1">
        <button class="cx-btn" @click="newTemplate()">新建模板</button>
        <div class="cx-scroll" style="max-height: 320px">
          <div v-for="tpl in store.data.templates" :key="tpl.id" class="flex items-center gap-1">
            <button class="cx-btn" style="flex: 1" :style="editingTemplateId === tpl.id ? activeStyle : undefined" @click="editingTemplateId = tpl.id">{{ tpl.name }}</button>
            <button v-if="!tpl.builtin" class="cx-btn cx-btn-danger" @click="store.removeTemplate(tpl.id)">删</button>
          </div>
        </div>
      </div>
      <div v-if="editingTemplate" class="flex flex-col gap-2">
        <label class="flex flex-col gap-1"><span class="cx-label">名称</span><input v-model="editingTemplate.name" class="cx-input" /></label>
        <div class="flex flex-wrap gap-2">
          <label class="flex flex-col gap-1"><span class="cx-label">目标格式</span>
            <select v-model="editingTemplate.target" class="cx-select" style="min-width: 140px">
              <option value="zhihatsuki">智绘姬</option><option value="xiaobaix">小白x</option><option value="custom">自定义</option>
            </select></label>
          <label class="flex flex-col gap-1"><span class="cx-label">合并方式</span>
            <select v-model="editingTemplate.merge_mode" class="cx-select" style="min-width: 140px">
              <option value="object_map">对象表合并</option><option value="array_push">数组追加</option><option value="custom">自定义</option>
            </select></label>
          <label class="flex flex-col gap-1"><span class="cx-label">角色键前缀</span>
            <input v-model="editingTemplate.key_prefix" class="cx-input" style="width: 120px" /></label>
        </div>
        <label class="flex flex-col gap-1"><span class="cx-label">格式说明（写给 LLM）</span>
          <textarea v-model="editingTemplate.schema_note" class="cx-textarea" style="min-height: 110px"></textarea></label>
        <label class="flex flex-col gap-1"><span class="cx-label">JSON 骨架（供 LLM 参照）</span>
          <textarea v-model="editingTemplate.skeleton" class="cx-textarea" style="min-height: 200px; font-family: Consolas, monospace"></textarea></label>
        <label class="flex flex-col gap-1"><span class="cx-label">JSON Schema（可选，配合预设开关使用）</span>
          <textarea v-model="editingTemplate.json_schema_text" class="cx-textarea" style="min-height: 80px; font-family: Consolas, monospace"></textarea></label>
      </div>
    </div>

    <!-- 元数据提取规则 -->
    <div v-if="tab === 'meta'" class="grid gap-2" style="grid-template-columns: 200px 1fr">
      <div class="flex flex-col gap-1">
        <button class="cx-btn" @click="newMetaRule()">新建规则</button>
        <div class="cx-scroll" style="max-height: 320px">
          <div v-for="rule in store.data.meta_extract_rules" :key="rule.id" class="flex items-center gap-1">
            <button class="cx-btn" style="flex: 1" :style="editingMetaId === rule.id ? activeStyle : undefined" @click="editingMetaId = rule.id">{{ rule.name }}</button>
            <button v-if="!rule.builtin" class="cx-btn cx-btn-danger" @click="store.removeMetaRule(rule.id)">删</button>
          </div>
        </div>
      </div>
      <div v-if="editingMeta" class="flex flex-col gap-2">
        <label class="flex flex-col gap-1"><span class="cx-label">名称</span><input v-model="editingMeta.name" class="cx-input" /></label>
        <label class="flex flex-col gap-1"><span class="cx-label">{{ fieldTemplateHint }}</span>
          <input v-model="editingMeta.field_template" class="cx-input" /></label>
        <div class="flex flex-wrap gap-2">
          <label class="flex flex-col gap-1" style="flex: 1"><span class="cx-label">整体前缀</span>
            <textarea v-model="editingMeta.header" class="cx-textarea" style="min-height: 50px"></textarea></label>
          <label class="flex flex-col gap-1" style="flex: 1"><span class="cx-label">整体后缀</span>
            <textarea v-model="editingMeta.footer" class="cx-textarea" style="min-height: 50px"></textarea></label>
        </div>
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <strong class="text-[12px]">提取字段</strong>
            <button class="cx-btn" @click="addMetaField()">添加字段</button>
          </div>
          <div v-for="(field, index) in editingMeta.fields" :key="field.id + index" class="flex flex-col gap-1" style="border: 1px solid var(--cx-border-soft); border-radius: 6px; padding: 6px">
            <div class="flex flex-wrap items-center gap-2">
              <input v-model="field.label" class="cx-input" style="max-width: 220px" placeholder="字段显示名" />
              <label class="flex items-center gap-1 text-[11px]"><input v-model="field.enabled" type="checkbox" /><span>启用</span></label>
              <button class="cx-btn cx-btn-danger" @click="editingMeta.fields.splice(index, 1)">删除</button>
            </div>
            <label class="flex flex-col gap-1">
              <span class="cx-label">候选路径（每行一条，按顺序取第一个命中的）</span>
              <textarea
                :value="field.paths.join('\n')"
                class="cx-textarea"
                style="min-height: 60px; font-family: Consolas, monospace"
                placeholder="json:v4_prompt.caption.char_captions[*].char_caption"
                @input="setFieldPaths(field, ($event.target as HTMLTextAreaElement).value)"
              ></textarea>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- 世界书预设 -->
    <div v-if="tab === 'worldbook'" class="grid gap-2" style="grid-template-columns: 200px 1fr">
      <div class="flex flex-col gap-1">
        <button class="cx-btn" @click="newWorldbookPreset()">新建预设</button>
        <div class="cx-scroll" style="max-height: 320px">
          <div v-for="preset in store.data.worldbook_presets" :key="preset.id" class="flex items-center gap-1">
            <button class="cx-btn" style="flex: 1" :style="store.activeWorldbookPresetId === preset.id ? activeStyle : undefined" @click="store.activeWorldbookPresetId = preset.id">{{ preset.name }}</button>
            <button v-if="!preset.builtin" class="cx-btn cx-btn-danger" @click="store.removeWorldbookPreset(preset.id)">删</button>
          </div>
        </div>
      </div>
      <div v-if="store.activeWorldbookPreset" class="flex flex-col gap-2">
        <label class="flex flex-col gap-1"><span class="cx-label">名称</span><input v-model="store.activeWorldbookPreset.name" class="cx-input" /></label>
        <label class="flex flex-col gap-1"><span class="cx-label">世界书命名模板（可用 {源名} 与 {日期}）</span>
          <input v-model="store.activeWorldbookPreset.worldbook_name_template" class="cx-input" /></label>
        <div class="flex flex-wrap gap-2">
          <label class="flex flex-col gap-1"><span class="cx-label">条目名模板</span>
            <input v-model="store.activeWorldbookPreset.entry_name_template" class="cx-input" style="min-width: 200px" /></label>
          <label class="flex flex-col gap-1"><span class="cx-label">重名处理</span>
            <select v-model="store.activeWorldbookPreset.name_conflict" class="cx-select" style="min-width: 140px">
              <option value="suffix">加序号后缀</option><option value="timestamp">加时间戳</option>
            </select></label>
          <label class="flex flex-col gap-1"><span class="cx-label">产出形态</span>
            <select v-model="store.activeWorldbookPreset.output_mode" class="cx-select" style="min-width: 140px">
              <option value="text">纯文本行</option><option value="json">先抽 JSON</option>
            </select></label>
          <label class="flex flex-col gap-1"><span class="cx-label">批大小</span>
            <input v-model.number="store.activeWorldbookPreset.batch_size" type="number" min="1" max="30" class="cx-input" style="width: 80px" /></label>
          <label class="flex flex-col gap-1"><span class="cx-label">温度</span>
            <input v-model.number="store.activeWorldbookPreset.temperature" type="number" step="0.1" min="0" max="2" class="cx-input" style="width: 80px" /></label>
        </div>
        <fieldset class="flex flex-col gap-1" style="border: 1px solid var(--cx-border-soft); border-radius: 6px; padding: 6px">
          <legend class="cx-label">新条目的默认属性</legend>
          <div class="flex flex-wrap gap-2">
            <label class="flex flex-col gap-1"><span class="cx-label">激活策略</span>
              <select v-model="store.activeWorldbookPreset.entry_defaults.strategy" class="cx-select" style="min-width: 140px">
                <option value="constant">蓝灯（常驻）</option><option value="selective">绿灯（关键词）</option>
              </select></label>
            <label class="flex flex-col gap-1"><span class="cx-label">插入位置</span>
              <input v-model="store.activeWorldbookPreset.entry_defaults.position_type" class="cx-input" style="min-width: 200px" /></label>
            <label class="flex flex-col gap-1"><span class="cx-label">order</span>
              <input v-model.number="store.activeWorldbookPreset.entry_defaults.order" type="number" class="cx-input" style="width: 80px" /></label>
            <label class="flex flex-col gap-1"><span class="cx-label">depth</span>
              <input v-model.number="store.activeWorldbookPreset.entry_defaults.depth" type="number" class="cx-input" style="width: 80px" /></label>
          </div>
          <label class="flex flex-col gap-1"><span class="cx-label">触发词（每行一个，留空即为纯蓝灯）</span>
            <textarea
              :value="store.activeWorldbookPreset.entry_defaults.keys.join('\n')"
              class="cx-textarea"
              style="min-height: 50px"
              @input="setWorldbookKeys(($event.target as HTMLTextAreaElement).value)"
            ></textarea></label>
        </fieldset>
        <label class="flex flex-col gap-1"><span class="cx-label">系统提示词</span>
          <textarea v-model="store.activeWorldbookPreset.system_prompt" class="cx-textarea" style="min-height: 60px"></textarea></label>
        <label class="flex flex-col gap-1"><span class="cx-label">生成指令</span>
          <textarea v-model="store.activeWorldbookPreset.instruction" class="cx-textarea" style="min-height: 120px"></textarea></label>
        <label class="flex flex-col gap-1"><span class="cx-label">字段/行格式规范</span>
          <textarea v-model="store.activeWorldbookPreset.field_spec" class="cx-textarea" style="min-height: 180px"></textarea></label>
        <label class="flex flex-col gap-1"><span class="cx-label">容错说明</span>
          <textarea v-model="store.activeWorldbookPreset.tolerance_note" class="cx-textarea" style="min-height: 110px"></textarea></label>
        <label class="flex flex-col gap-1"><span class="cx-label">参考示例（可选）</span>
          <textarea v-model="store.activeWorldbookPreset.few_shot" class="cx-textarea" style="min-height: 80px"></textarea></label>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { useWorkshopStore } from '../stores/workshop.ts';
import { JsonTemplateSchema, LlmPresetSchema, MetaExtractRuleSchema, WorldbookPresetSchema } from '../llm/schema.ts';

const store = useWorkshopStore();

// 占位符文本本身就是双花括号，直接写进模板会被 Vue 当成插值，故放在变量里
const fieldTemplateHint = '字段渲染模板（占位符 ' + '{{label}}' + ' 与 ' + '{{value}}' + '）';

const SECTIONS = [
  { id: 'llm', label: 'LLM 预设' },
  { id: 'template', label: 'JSON 模板' },
  { id: 'meta', label: '元数据提取规则' },
  { id: 'worldbook', label: '世界书预设' },
];

const activeStyle = { background: 'rgba(139, 92, 246, 0.42)', borderColor: 'var(--cx-accent)' };
const tab = ref('llm');

const editingTemplateId = ref('');
const editingMetaId = ref('');

const editingTemplate = computed(() =>
  store.data.templates.find(item => item.id === editingTemplateId.value) ?? store.data.templates[0] ?? null,
);

const editingMeta = computed(() =>
  store.data.meta_extract_rules.find(item => item.id === editingMetaId.value) ?? store.data.meta_extract_rules[0] ?? null,
);

function newLlmPreset(): void {
  const base = store.activePreset;
  const preset = LlmPresetSchema.parse({
    ...(base ? { ...base } : {}),
    id: store.makeId('preset', store.data.llm_presets.map(item => item.id)),
    name: (base?.name ?? '新预设') + ' 副本',
    builtin: false,
  });
  store.upsertLlmPreset(preset);
  store.activePresetId = preset.id;
}

function newTemplate(): void {
  const base = editingTemplate.value;
  const template = JsonTemplateSchema.parse({
    ...(base ? { ...base } : {}),
    id: store.makeId('tpl', store.data.templates.map(item => item.id)),
    name: (base?.name ?? '新模板') + ' 副本',
    builtin: false,
  });
  store.upsertTemplate(template);
  editingTemplateId.value = template.id;
}

function newMetaRule(): void {
  const base = editingMeta.value;
  const rule = MetaExtractRuleSchema.parse({
    ...(base ? { ...base } : {}),
    id: store.makeId('meta', store.data.meta_extract_rules.map(item => item.id)),
    name: (base?.name ?? '新规则') + ' 副本',
    builtin: false,
  });
  store.upsertMetaRule(rule);
  editingMetaId.value = rule.id;
}

function newWorldbookPreset(): void {
  const base = store.activeWorldbookPreset;
  const preset = WorldbookPresetSchema.parse({
    ...(base ? { ...base } : {}),
    id: store.makeId('wbpreset', store.data.worldbook_presets.map(item => item.id)),
    name: (base?.name ?? '新预设') + ' 副本',
    builtin: false,
  });
  store.upsertWorldbookPreset(preset);
  store.activeWorldbookPresetId = preset.id;
}

function addMetaField(): void {
  const rule = editingMeta.value;
  if (!rule) return;
  rule.fields.push({
    id: 'field-' + (rule.fields.length + 1),
    label: '新字段',
    enabled: true,
    paths: [],
  });
}

function setFieldPaths(field: { paths: string[] }, value: string): void {
  field.paths = value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function setWorldbookKeys(value: string): void {
  const preset = store.activeWorldbookPreset;
  if (!preset) return;
  preset.entry_defaults.keys = value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}
</script>

<style lang="scss" scoped>
.cx-label {
  font-size: 11px;
  color: var(--cx-muted);
}
</style>
