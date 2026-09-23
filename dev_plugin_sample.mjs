/**
 * 示例外部插件（阶段 7）—— **这就是「一个外部插件包」的全部要求**。
 *
 * 一个外部插件包 = **一个 JS 模块**，导出 `manifest`（或 `export default`），形状与内置插件的
 * `manifest.ts` 完全一致（这是阶段 3 定「插件 = 自包含目录 + 一份 manifest」时就留好的路）。
 *
 * 装载流程（底座做的，插件作者不用管）：
 *   1. 下载 / 粘贴 → 存成酒馆真文件（`/user/files/cx-plugin-<id>.js`）
 *   2. 动态 import 执行它 → 读 `manifest`
 *   3. 校验 apiVersion 与形状 → 注册进插件表（页面 / 工具 / 宏 / 技能 / 设置照常生效）
 *   4. 刷新页面时按安装清单重新装载（所以**代码里不要写一次性副作用**，要幂等）
 *
 * ⚠️ 装进来的代码是**全权执行**的：它和酒馆同权限。底座不做权限门禁（既定口径），
 *    所以「只装你信得过的东西」这条只能靠你自己。
 */
export const manifest = {
  id: 'cx-sample-plugin',
  name: '示例外部插件',
  desc: '演示外部插件能贡献什么：一个宏 + 一个工具。装完就能在能力页看到它。',
  version: '0.1',
  apiVersion: 1,
  builtin: false,
  defaultEnabled: true,
  contributes: {
    // ① 宏：进我们自己的预设渲染（中文名可以；要进酒馆宏引擎才需要 ASCII 的 tavernAlias）
    macros: [
      {
        name: '示例宏',
        scopes: ['preset'],
        desc: '外部插件渲染出来的一句话',
        render: () => '这是外部插件「示例外部插件」渲染的内容',
      },
    ],
    // ② 工具：形状与内置插件的 ToolDef 完全一样
    tools: [
      {
        name: 'ext_hello',
        group: 'external',
        title: '打招呼',
        desc: '示例外部工具：回一句问候，用来确认外部工具真的能被模型调用。',
        model_description: '回一句问候。这是外部插件提供的示例工具，只在你明确想验证外部工具时才用。',
        parameters: {
          type: 'object',
          properties: { who: { type: 'string', description: '问候谁（可留空）' } },
          required: [],
        },
        default_on: true,
        source: 'external',
        async run(args) {
          const who = typeof args?.who === 'string' && args.who.trim() ? args.who.trim() : '世界';
          return { ok: true, brief: '外部工具跑通了', detail: '你好，' + who + '！这句话来自外部插件。' };
        },
      },
    ],
  },
};

export default manifest;
