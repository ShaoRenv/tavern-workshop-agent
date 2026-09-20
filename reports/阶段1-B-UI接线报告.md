# 阶段 1-B · UI 接线报告（task-27 / ui-wire）

> 目标：界面零变化（6 格、老顺序、老名字），但页签 / 插件开关 / 工具来源全部改走注册表。
> 门禁跑完之后的最终状态（没有再动 src）。

## ① 改了哪些文件

1. src/苍玄助手/components/ui_types.ts
   - :10 去掉 TabId 依赖；:66-69 删掉 TAB_LABELS（页签显示名跟着页面注册表走）
   - :65-69 UiTool 新增 owner?: string（'底座' / 插件名），来源标签的唯一来源
2. src/苍玄助手/components/AppShell.vue
   - :14-20 药丸栏 v-for 从 props.pages 渲染 page.title，:key=page.id；不再 import TAB_IDS / TAB_LABELS
   - :22-49 props = { pages: {id,title}[]; tab: string; title?; status? }，emit update:tab: [string]
3. src/苍玄助手/App.vue
   - :99-101 导入 availablePages / pluginTools(别名 pluginToolsOf) / toolOwner / toolOwnerLabel + PageEntry
   - :2 AppShell 传 :pages="pages"
   - :121 pages = computed(() => availablePages(store.data))
   - :124-133 tab 兜底（active_tab 不在 pages 里 → pages[0].id）+ watch(immediate) 存回 store.setTab
   - :137 imageOn = computed(() => store.pluginEnabled('image'))
   - :145-154 globalCaps = 底座默认开工具 + 已启用插件贡献的工具（插件关着的工具一条都不给）
   - :162-173 工具清单 = 内核清单 ∩（底座 + 已启用插件），每行 owner = toolOwnerLabel(name)
   - :241-249 runAgent 的 genImage：插件关着就不注入（tools_image.ts:43 那条人话分支）
   - :496-517 onPluginToggle / onPluginPatch(id, patch) / onPluginReset(id) → store.setPluginEnabled / setPluginConfig(id, …) / resetPluginConfig(id)
   - :520-534 makeImageGen 读 store.imageConfig()
   - :38-52 CapabilityView 绑定补 @plugin-toggle / @goto
4. src/苍玄助手/views/CapabilityView.vue
   - :34-36 工具行加来源标签 {{ tool.owner || '底座' }}
   - :52-62 转发 @toggle / @patch(id,patch) / @reset(id) / @goto
   - :165-170 预设里引用、但当前清单没有的工具兜底行也打 toolOwnerLabel(name)
   - :250-262 三个转发函数，写路径仍然只有 App.vue → store
5. src/苍玄助手/components/ToolDetail.vue :200-208 sourceLabel = tool.owner || '底座'（外部工具仍是 URL / 粘贴）
6. src/苍玄助手/views/PluginsView.vue（整份重写，注册表驱动）
   - 列表 = PLUGIN_MANIFESTS；状态 = pluginStatus(data, id, 插件自己那段设置)；开关 = pluginEnabled(data, id)
   - 行上「它加了什么」：内置|外部 · v版本 · N 页 · N 工具；事件 toggle(id,enabled) / patch(id,patch) / reset(id) / goto(id)
7. src/苍玄助手/components/PluginDetail.vue
   - 头部 :10-23：def.name / 内置|外部 / v版本 / status（prop，不再自己算 imagePluginStatus）/ 启用开关绑 enabled + emit('toggle')
   - 新增 :25-56「它加了什么」：页面行 + 工具行，点一行 emit('goto', pageId|'capability')
   - :279-343 生图表单整段套 template v-if="isImage"；:345-352 非生图插件显示「它自己的设置」占位
   - :395-… props 改成 PluginManifest / enabled / status；form.enabled、onEnabled、imagePluginStatus、PluginDef 全部删掉

## ② 每条门禁的原始结论

| 门禁 | 命令 | 结论 |
|---|---|---|
| 单测 | node --test "tests/苍玄助手/*.test.ts" | **exit 1**：tests 283 / pass 277 / fail 6。6 条**全部**在 tests/苍玄助手/plugin_image.test.ts（还在用旧 API：imagePluginTools、config.enabled、单参数 store.setPluginConfig），属 task-28 范围；我改的 7 个文件里 0 条 |
| 类型 | npx tsc --noEmit | **exit 2**，输出共 5 行、全是既有 node_modules 噪音（@types/function/worldbook.d.ts 等）；Select-String "src/" 命中 0 条 |
| Lint | npx eslint "src/苍玄助手" | **exit 0，0 问题**（最后又跑一次） |
| 正式构建 | pnpm build | **exit 0**；[build_tavern_script] 脚本正文 538 KB；应用 JS 245 KB，CSS 20 KB |
| 开发构建 | pnpm build:dev | **exit 0**，dist 已更新；Get-ChildItem dist -Recurse -Filter *.chunk.js = **0 个** |

### 浏览器自检（http://127.0.0.1:8787/frame.html，chrome-devtools MCP，逐条点过）

- ① 顶栏 6 格、顺序 立绘/世界书/对话/能力/记录/设置、名字不变 ✓
- ② 插件列表 3 行：苍玄助手（已启用 · 内置 v0.1 · 1 页）/ 世界书（已启用 · 内置 v0.1 · 1 页 · 7 工具）/ 生图（未启用 · 内置 v0.1 · 1 工具），每行有开关、有「它加了什么」、点 › 进详情 ✓
- ③ 关掉世界书 → 顶栏世界书格消失（余 5 格）、当前页照常渲染、重开立刻回来 ✓；开生图 → 工具段 12 → 13 个、生图行出现；关掉 → 消失 ✓
- ④ 工具行来源标签：底座 / 世界书 / 生图 ✓（生图插件关着时 gen_image 整行不出现）
- ⑤ 生图详情页表单照旧（接口 / Key / 站点 / 模型 / 固定提示词 / 参数 / 高级 / 出图），状态标「缺 API Key」✓
- 附加：非生图插件详情 = 头部 / 它加了什么（页面：世界书 ›、工具：7 个 ›）/「它自己的设置」占位，没有 NovelAI 表单 ✓；「页面：世界书 ›」跳转真的切到世界书页 ✓
- 自检完已把开关恢复默认（世界书开 / 生图关）、页签点回立绘，并关掉自检页

## ③ 没做完 / 不确定 / 与 Lead 口径的差异（如实说）

1. **globalCaps 我加了一道「插件关着就不给」的过滤**（Lead 给的是 [DEFAULT_ON_TOOLS, ...pluginToolsOf(store.data)] 直接拼）。原因：DEFAULT_ON_TOOLS 里有 6 个**世界书插件**的工具（wb_list 等），照抄的话世界书插件关掉后这 6 条仍然进全局能力 = 违反契约「关掉即消失」。现在：世界书关 → 它那 6 个默认开工具与 entry_meta 一起不给模型；生图关 → gen_image 不给。三个插件都开着时与 Lead 的写法逐条一致。
2. **能力·工具段的 tools 改成了响应式过滤**（内核清单 ∩ 底座 + 已启用插件）。Lead 的消息只提了 globalCaps，但验收 ③ 要求「关掉生图 → 能力·工具里 gen_image 消失」，列表本身必须跟着变，否则 gen_image 会一直挂在那儿。副作用见第 3 条。
3. **插件关着时，预设里硬引用过的工具会以兜底行出现**：例：关掉世界书后工具段是 11 行 = 5 条底座 + 6 条 wb_* 兜底行（来源标签仍是「世界书」，但标题是原始工具名、说明显示「（内核还没给一句话说明）」）。这是 CapabilityView 原有的兜底机制（:163-170）在新场景下露头；设计自查 A6 的「被来源停用时行上标已停用」是阶段 2 的活，本轮没加。
4. **genImage 我写成 imageOn.value ? makeImageGen() : undefined**，没用 Lead 给的 computed(() => …) + genImage.value。原因：computed 会缓存那个闭包，makeImageGen 里的 used 计数就不再按轮清零，「一次最多几张」会变成跨轮累计（第二轮第一张就被顶掉）。语义仍是 Lead 要的「插件关着就不注入」。
5. **watch 加了 { immediate: true }**：不 immediate 的话，老数据 active_tab 指向已关插件页面时不会立刻存回，要等下一次切页才修。
6. **「试画一张」在当前 UI 里不存在**（reports/苍玄助手-插件系统.md §9.2 曾列过，但 设计稿/苍玄助手-插件页设计稿.html:405 明确「试画 + 结果预览 —— 全删」，PluginDetail.vue 的注释也写着「试画 / 结果预览 → 不在这里」）。所以「插件关着或缺 Key 时禁用」无从落手；现在的表达是状态标签（未启用 / 缺 API Key / 已启用）+ 头部启用开关。要加试画按钮 = 新功能，请 Lead 定。
7. **core/types.ts 仍然导出 TAB_IDS / TabId**（设计自查 A9 说删）。不在我的写作范围，我没动；界面侧已经一条都不引用（grep 只剩 core/types.ts 自己的定义与注释）。
8. **生图设置「改完能存」只验到接线**：dev frame 里表单照旧渲染、写路径已接（PluginDetail → PluginsView → App.vue → store.setPluginConfig('image', patch)），但 frame 没有酒馆宿主存储，真落盘 / 刷新还在得由 verify / st-verify 在真酒馆里过。plugin_image.test.ts 里那 6 条（含 setPluginConfig 合并 / 恢复默认）现在红着，等 task-28 改完才绿。
9. 没有留 TODO 注释；没有 git commit；src/酒馆助手脚本-苍玄助手.json 与 dist 都是最后一次 build 的产物。
