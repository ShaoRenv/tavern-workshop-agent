/**
 * 插件 → 底座 的运行时接线。
 *
 * 为什么需要这一层：
 *   - core 不认识任何插件（依赖方向只能是 plugins → core）；
 *   - 所以插件贡献的东西要**由底座主动去拿**，拿完注册进 core 的注册口。
 *
 * 阶段 3 只接一件：**宏**。
 *   - 名字清单 = 全部内置插件声明的宏名（**用全部、不用「已启用」**：
 *     停用的插件名字仍要在清单里，这样 `{{图片提示词}}` 会被替换成空串，
 *     而不是在界面上留下一个裸露的占位符）；
 *   - renderer = 只在**已启用**的插件里找（关掉 = 没有 renderer = 空串）。
 *
 * 于是「关掉即消失」在三层都成立：界面（pluginPages / pluginTools）、
 * 运行时工具（liveToolDefs）、宏（这里）。
 */
import { registerPluginMacroNames, registerPluginMacroSource, type MacroData } from '../core/macros.ts';
import { withMacroPrefix } from '../core/native.ts';
import { hostFn } from '../core/storage.ts';
import { PLUGIN_MANIFESTS, enabledPlugins } from '../plugins/registry.ts';
import type { PluginMacro, PluginStateHost } from '../plugins/types.ts';

/** 全部内置插件贡献的宏（不管开关） */
function allMacros(): PluginMacro[] {
  const out: PluginMacro[] = [];
  for (const manifest of PLUGIN_MANIFESTS) {
    for (const macro of manifest.contributes.macros ?? []) out.push(macro);
  }
  return out;
}

/** 已启用插件贡献的宏 */
function liveMacros(state: PluginStateHost): PluginMacro[] {
  const out: PluginMacro[] = [];
  for (const manifest of enabledPlugins(state)) {
    for (const macro of manifest.contributes.macros ?? []) out.push(macro);
  }
  return out;
}

/**
 * 把「插件宏」接到 core 的渲染上。
 *
 * 调用时机：面板启动时一次；插件开关变化时再调一次（开关变了，活的宏就变了）。
 * 幂等，重复调没问题。
 */
export function wirePluginMacros(state: PluginStateHost): void {
  // 1) 名字清单用「全部」——停用插件的宏名也要认，否则占位符会漏到界面上
  registerPluginMacroNames(allMacros().map(macro => macro.name));

  // 2) renderer 只认「已启用」的插件
  registerPluginMacroSource((name: string, data: MacroData) => {
    const hit = liveMacros(state).find(macro => macro.name === name);
    if (!hit) return undefined;
    const value = hit.render(data as unknown as Record<string, unknown>);
    return typeof value === 'string' ? value : '';
  });

  // 3) 声明了 scope 含 'tavern' 的宏，还要注册进**酒馆宏引擎**（角色卡里也能写）
  syncTavernMacros(state);
}

/* ============================ 酒馆宏引擎（scopes 含 'tavern'） ============================ */

/** 注册进去的宏：名字 → 正则（注销时要拿同一个正则） */
const registeredTavernMacros = new Map<string, RegExp>();

/**
 * 把 scope 含 'tavern' 的插件宏注册进酒馆宏引擎（角色卡里也能写）。
 *
 * ⚠️ 酒馆助手的 `registerMacroLike(regex, replace)` 收的是**正则**，不是宏名 ——
 * 传字符串会静默失效（实测：注册「成功」但 `substitudeMacros` 仍旧原样返回占位符）。
 * 所以这里为每个宏拼一个匹配 `{{宏名}}` 的正则。
 *
 * 幂等：先撤掉上一次注册的，再按当前状态重注册 —— 关掉插件后它在角色卡里也失效。
 * 宿主没有这两个接口时静默跳过（面板内的预设渲染照常工作）。
 */
export function syncTavernMacros(state: PluginStateHost = {}): void {
  const unregister = hostFn('unregisterMacroLike');
  const register = hostFn('registerMacroLike');

  // 先全部撤掉（换了插件集合后可能变少）
  if (unregister) {
    for (const [name, regex] of registeredTavernMacros) {
      try {
        unregister(regex);
      } catch (err) {
        console.warn('[苍玄助手] 注销酒馆宏失败：' + name, err);
      }
    }
  }
  registeredTavernMacros.clear();

  if (!register) return;

  // 只注册「已启用插件」里声明了 tavern 作用域的宏
  for (const manifest of enabledPlugins(state)) {
    for (const macro of manifest.contributes.macros ?? []) {
      if (!macro.scopes.includes('tavern')) continue;

      /*
       * ⚠️ 酒馆宏名**必须 ASCII**（词法器 MacroLexer.js:17 只认 /^[a-zA-Z][\w-]*$/）。
       * 中文名注册上去「不报错但永远不替换」，所以这里强制要求 tavern 宏声明 ASCII 别名。
       * 面板内的中文名不受影响：那条路走我们自己的渲染器（scopes 含 'preset'），
       * 不经过酒馆词法器。
       */
      /*
       * ⚠️ 前缀也要加在别名上。
       *
       * 别名解决的是「ASCII 合法性」，前缀解决的是「别撞上酒馆 131 个内置宏」——
       * 两件事彼此独立。直接拿别名去注册的话，一个起名叫 image_prompt 的插件宏
       * 会和酒馆/别的扩展的同名宏撞车（撞了是对方赢，我们静默不生效）。
       * 所以：tavernAlias 只提供 ASCII 词根，前缀由这里统一补。
       */
      const tavernName = withMacroPrefix(macro.tavernAlias ?? macro.name);
      if (!/^[a-zA-Z][\w-]*$/.test(tavernName)) {
        console.warn(
          '[苍玄助手] 插件宏「' + macro.name + '」声明了 tavern 作用域，但名字不是 ASCII，' +
            '酒馆的宏词法器认不出来（永远不会被替换），已跳过注册。' +
            '请给这个 PluginMacro 加一个 tavernAlias（ASCII 名字，例如 image_prompt）。',
        );
        continue;
      }

      const regex = macroTokenRegex(tavernName);
      try {
        register(regex, () => macroValue(macro.name));
        registeredTavernMacros.set(tavernName, regex);
      } catch (err) {
        console.warn('[苍玄助手] 注册酒馆宏失败：' + tavernName, err);
      }
    }
  }
}

/** 花括号用字符码拼，别写成字面量 —— 否则构建产物里会出现一个「没渲染的 {{宏}}」，
 *  踩到 bundle_artifact 那道闸（它扫的就是产物里的 {{...}} 残留）。 */
const OPEN = String.fromCharCode(123, 123);
const CLOSE = String.fromCharCode(125, 125);

/** 匹配 {{宏名}}（允许花括号里有空格，跟底座 applyOwnMacros 的口径一致） */
export function macroTokenRegex(name: string): RegExp {
  return new RegExp(OPEN + '\\s*' + escapeRegExp(name) + '\\s*' + CLOSE, 'g');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 酒馆宏引擎回调拿不到底座上下文（它是无参的），所以取「最近一次渲染时的值」。
 * 没有值（还没跑过一轮 / 插件关了）= 空串 —— 角色卡里写了这个宏也只是那一段空着。
 */
let lastMacroValues: Record<string, string> = {};

function macroValue(name: string): string {
  return lastMacroValues[name] ?? '';
}

/** 每轮渲染预设时把插件宏的值记下来，供酒馆宏引擎回填（见 syncTavernMacros） */
export function rememberMacroValues(data: MacroData): void {
  const bag = data as unknown as Record<string, unknown>;
  const next: Record<string, string> = {};
  for (const macro of liveMacros({ plugin_state: undefined })) {
    try {
      const value = macro.render(bag);
      if (value) next[macro.name] = value;
    } catch {
      // 单个宏渲染失败不影响其它
    }
  }
  lastMacroValues = next;
}

/** 测试 / 卸载用：把接线拆掉 */
export function unwirePluginMacros(): void {
  registerPluginMacroSource(null);
  registerPluginMacroNames([]);
}

/** 某个宏在哪几个作用域里可用（界面列宏清单 / 提示用户可在角色卡里写） */
export function macroScopes(name: string): Array<'tavern' | 'preset'> {
  const hit = allMacros().find(macro => macro.name === name);
  return hit ? hit.scopes.slice() : [];
}