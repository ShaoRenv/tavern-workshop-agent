# 苍玄界 · 扩展安装分支

这个分支**不是源码**，只是构建产物的发布分支 —— 供 SillyTavern 用「安装扩展」直接拉取。

源码在 `main` 分支；这里的内容由 `pnpm build:ext` 产出（即 `dist/extension/`）。

## 安装

1. SillyTavern → 扩展（Extensions）→ **安装扩展（Install extension）**
2. URL 填本仓库地址 `https://github.com/ShaoRenv/tavern-workshop-agent`
3. **分支名填 `extension`**（这一栏是必填的，否则拉的是 main 分支，找不到 manifest.json）
4. 刷新页面即可：扩展会出现在扩展列表里，**不需要手动启用**

## 为什么单独开一个分支

酒馆的安装流程是 `git clone` **仓库根目录**，然后读根目录的 `manifest.json`。
而本仓库的根目录是整套 webpack 工程（源码、测试、示例），没有 `manifest.json` ——
所以直接把仓库地址交给酒馆是装不上的。这个分支的根目录就是那 4 个运行所需文件：

- `manifest.json`
- `index.js`（扩展入口）
- `index.css`（样式）
- `index.<hash>.chunk.js`（应用本体）

不含 sourcemap（约 1.3 MB，对使用者无用）。

## 更新

重新 `pnpm build:ext` 后把 `dist/extension/` 的内容推到本分支即可。
酒馆侧用扩展列表里的「更新」按钮拉取（本分支的更新走同一个 clone 的 git pull）。