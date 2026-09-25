import { FSWatcher, watch } from 'chokidar';
import HtmlInlineScriptWebpackPlugin from 'html-inline-script-webpack-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import _ from 'lodash';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { ChildProcess, exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import RemarkHTML from 'remark-html';
import { Server } from 'socket.io';
import TerserPlugin from 'terser-webpack-plugin';
import TsconfigPathsPlugin from 'tsconfig-paths-webpack-plugin';
import unpluginAutoImport from 'unplugin-auto-import/webpack';
import { VueUseComponentsResolver, VueUseDirectiveResolver } from 'unplugin-vue-components/resolvers';
import unpluginVueComponents from 'unplugin-vue-components/webpack';
import { VueLoaderPlugin } from 'vue-loader';
import webpack from 'webpack';
import WebpackObfuscator from 'webpack-obfuscator';
const require = createRequire(import.meta.url);
const HTMLInlineCSSWebpackPlugin = require('html-inline-css-webpack-plugin').default;

interface Config {
  port: number;
  entries: Entry[];
}
interface Entry {
  script: string;
  html?: string;
<<<<<<< HEAD
  /**
   * true = 这个入口要打成**酒馆扩展**（dist 里多出一份 manifest.json，允许分包）。
   *
   * 为什么要区分：扩展与「单文件酒馆脚本」的打包约束**正好相反**。
   * 脚本形态：一个 .json 里就一段代码，import() 拆出的 chunk 永远 404 → 必须单文件。
   * 扩展形态：dist 目录由酒馆的静态服务器伺服 → 允许分包，也就不该再受 LimitChunkCount 的限制。
   * 判定方式：入口同级目录有 manifest.json 就是扩展（官方模板也是这个布局）。
   */
  extension?: boolean;
=======
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
}

function parse_entry(script_file: string) {
  const html = path.join(path.dirname(script_file), 'index.html');
  if (fs.existsSync(html)) {
    return { script: script_file, html };
  }
  return { script: script_file };
}

<<<<<<< HEAD
/** 入口同级有 manifest.json ⇒ 这是扩展入口（照官方模板 / ST 的发现规则） */
function is_extension_entry(script_file: string) {
  return fs.existsSync(path.join(path.dirname(script_file), 'manifest.json'));
}

/** 扩展入口的产出目录：dist 里保持同名目录，dist/extension/index.js */
function extension_out_dir(script_file: string) {
  return path.join(
    import.meta.dirname,
    'dist',
    path.relative(import.meta.dirname, path.dirname(script_file)).replace(/^[^\\/]+[\\/]/, ''),
  );
}

/**
 * 把 manifest.json / style.css 抄进产出目录 —— 酒馆要求 manifest.json 与 js 同级。
 * 扩展的 css 由 MiniCssExtractPlugin 直接产出，不用这里抄。
 */
function copy_extension_assets(script_file: string) {
  const dir = path.dirname(script_file);
  const out = extension_out_dir(script_file);
  return {
    apply(compiler: webpack.Compiler) {
      compiler.hooks.afterEmit.tap('copy_extension_assets', () => {
        try {
          fs.mkdirSync(out, { recursive: true });
          const manifest = path.join(dir, 'manifest.json');
          if (fs.existsSync(manifest)) {
            fs.copyFileSync(manifest, path.join(out, 'manifest.json'));
            console.info(`\x1b[36m[extension]\x1b[0m 已产出 ${path.relative(import.meta.dirname, path.join(out, 'manifest.json'))}`);
          }
          prune_stale_chunks(out);
        } catch (error) {
          console.error('\x1b[31m[extension]\x1b[0m 抄 manifest.json 失败', error);
        }
      });
    },
  };
}

/**
 * 删掉**没有被 index.js 引用**的旧 chunk。
 *
 * ⚠️ 为什么必须做：chunk 是 contenthash 命名的，每次改代码就多一个新名字。
 * webpack 的 `output.clean` 只清**本次 compilation 记过账**的文件，历史上积累的旧 chunk
 * 会一直躺在 dist 里 —— 实测一轮开发下来堆了 **9 个**，而 index.js 只引用其中 1 个。
 *
 * 危害有两个，都很实在：
 *  1. 玩家更新时如果走的是「覆盖拷贝」（而不是先删目录），旧 chunk 会和新的混在一起；
 *     一旦 index.js 与 chunk 版本错配，就是**更新后白屏**（这正是发布原子性要防的）。
 *  2. 包体虚胖：8 个没人引用的 228KB 文件跟着仓库走。
 *
 * 所以构建收尾时主动清一次，保证 dist/extension 里只有「当前这一套」。
 */
function prune_stale_chunks(out: string) {
  const entry = path.join(out, 'index.js');
  if (!fs.existsSync(entry)) return;

  const code = fs.readFileSync(entry, 'utf8');
  // chunk 文件名形如 index.<hash>.chunk.js；从入口里把所有引用抠出来
  const referenced = new Set(code.match(/index\.[0-9a-f]{16,}\.chunk\.js/g) ?? []);

  let removed = 0;
  for (const file of fs.readdirSync(out)) {
    if (!/\.chunk\.js(\.map)?$/.test(file)) continue;
    // .map 跟着它的同名 chunk 一起留 / 一起删
    const base = file.replace(/\.map$/, '');
    if (referenced.has(base)) continue;
    fs.rmSync(path.join(out, file), { force: true });
    removed += 1;
  }
  if (removed > 0) {
    console.info(`\x1b[36m[extension]\x1b[0m 清掉 ${removed} 个没被引用的旧 chunk（防「更新后白屏」+ 防包体虚胖）`);
  }
}

=======
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
function common_path(lhs: string, rhs: string) {
  const lhs_parts = lhs.split(path.sep);
  const rhs_parts = rhs.split(path.sep);
  for (let i = 0; i < Math.min(lhs_parts.length, rhs_parts.length); i++) {
    if (lhs_parts[i] !== rhs_parts[i]) {
      return lhs_parts.slice(0, i).join(path.sep);
    }
  }
  return lhs_parts.join(path.sep);
}

function glob_script_files() {
  const results: string[] = [];

  fs.globSync(`{示例,src}/**/index.{ts,tsx,js,jsx}`)
    .filter(
      file => process.env.CI !== 'true' || !fs.readFileSync(path.join(import.meta.dirname, file)).includes('@no-ci'),
    )
    .forEach(file => {
      const file_dirname = path.dirname(file);
      for (const [index, result] of results.entries()) {
        const result_dirname = path.dirname(result);
        const common = common_path(result_dirname, file_dirname);
        if (common === result_dirname) {
          return;
        }
        if (common === file_dirname) {
          results.splice(index, 1, file);
          return;
        }
      }
      results.push(file);
    });

  return results;
}

const config: Config = {
  port: 6621,
<<<<<<< HEAD
  entries: glob_script_files().map(parse_entry).map(entry => ({
    ...entry,
    extension: is_extension_entry(entry.script),
  })),
=======
  entries: glob_script_files().map(parse_entry),
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
};

let io: Server;
function watch_tavern_helper(compiler: webpack.Compiler) {
  if (compiler.options.watch) {
    if (!io) {
      const port = config.port ?? 6621;
      io = new Server(port, { cors: { origin: '*' } });
      console.info(`\x1b[36m[tavern_helper]\x1b[0m 已启动酒馆监听服务`);
      io.on('connect', socket => {
        console.info(`\x1b[36m[tavern_helper]\x1b[0m 成功连接到酒馆网页 '${socket.id}', 初始化推送...`);
        io.emit('iframe_updated');
        socket.on('disconnect', reason => {
          console.info(`\x1b[36m[tavern_helper]\x1b[0m 与酒馆网页 '${socket.id}' 断开连接: ${reason}`);
        });
      });
    }

    compiler.hooks.done.tap('watch_tavern_helper', () => {
      console.info('\n\x1b[36m[tavern_helper]\x1b[0m 检测到完成编译, 推送更新事件...');
      if (compiler.options.plugins.some(plugin => plugin instanceof HtmlWebpackPlugin)) {
        io.emit('message_iframe_updated');
      } else {
        io.emit('script_iframe_updated');
      }
    });
  }
}

let watcher: FSWatcher;
const dump = () => {
  exec('pnpm dump', { cwd: import.meta.dirname });
  console.info('\x1b[36m[schema_dump]\x1b[0m 已将所有 schema.ts 转换为 schema.json');
};
const dump_debounced = _.debounce(dump, 500, { leading: true, trailing: false });
function schema_dump(compiler: webpack.Compiler) {
  if (!compiler.options.watch) {
    dump_debounced();
    return;
  }
  if (!watcher) {
    watcher = watch('src', {
      awaitWriteFinish: true,
    }).on('all', (_event, path) => {
      if (path.endsWith('schema.ts')) {
        dump_debounced();
      }
    });
  }
}

let child_process: ChildProcess;
const bundle = () => {
  exec('pnpm sync bundle all', { cwd: import.meta.dirname });
  console.info('\x1b[36m[tavern_sync]\x1b[0m 已打包所有配置了的角色卡/世界书/预设');
};
const bundle_debounced = _.debounce(bundle, 500, { leading: true, trailing: false });
function tavern_sync(compiler: webpack.Compiler) {
  if (!compiler.options.watch) {
    bundle_debounced();
    return;
  }
  compiler.hooks.watchRun.tap('watch_tavern_sync', () => {
    if (!child_process) {
      child_process = spawn('pnpm', ['sync', 'watch', 'all', '-f'], {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: import.meta.dirname,
        env: { ...process.env, FORCE_COLOR: '1' },
      });
      child_process.stdout?.on('data', (data: Buffer) => {
        console.info(
          data
            .toString()
            .trimEnd()
            .split('\n')
            .map(string => (/^\s*$/s.test(string) ? string : `\x1b[36m[tavern_sync]\x1b[0m ${string}`))
            .join('\n'),
        );
      });
      child_process.stderr?.on('data', (data: Buffer) => {
        console.error(
          data
            .toString()
            .trimEnd()
            .split('\n')
            .map(string => (/^\s*$/s.test(string) ? string : `\x1b[36m[tavern_sync]\x1b[0m ${string}`))
            .join('\n'),
        );
      });
      child_process.on('error', error => {
        console.error(`\x1b[31m[tavern_sync]\x1b[0m Error: ${error.message}`);
      });
    }
  });
  compiler.hooks.watchClose.tap('watch_tavern_sync', () => {
    child_process?.kill();
  });
  ['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
      child_process?.kill();
    });
  });
}

function parse_configuration(entry: Entry): (_env: any, argv: any) => webpack.Configuration {
  const should_obfuscate = fs
    .readFileSync(path.join(import.meta.dirname, entry.script), 'utf-8')
    .includes('@obfuscate');
  const script_filepath = path.parse(entry.script);

  return (_env, argv) => ({
<<<<<<< HEAD
    /**
     * 给每个配置一个稳定名字，供 `--config-name` 精确选中。
     *
     * 为什么需要：这个文件导出 **11 个配置**，`webpack --mode development` 会一次全编。
     * 开发时只想动扩展（src/extension），但全编会把 `dist/苍玄助手/index.html`（单文件
     * 脚本形态的产物）也覆盖成 dev 版 —— 而 `build_tavern_script.mjs` 正是读它来生成
     * `src/酒馆助手脚本-苍玄助手.json`，于是打包产物被 dev 版污染、bundle 相关测试全红。
     *
     * 名字取入口目录相对路径（正斜杠），例如 `extension`、`苍玄助手`。
     */
    name: path.relative(import.meta.dirname, path.dirname(entry.script)).replace(/\\/g, '/'),
=======
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
    experiments: {
      outputModule: true,
    },
    devtool: argv.mode === 'production' ? 'source-map' : 'eval-source-map',
    watchOptions: {
      ignored: ['**/dist', '**/node_modules'],
    },
    entry: path.join(import.meta.dirname, entry.script),
    target: 'browserslist',
    output: {
      devtoolNamespace: 'tavern_helper_template',
      devtoolModuleFilenameTemplate: info => {
        const resource_path = decodeURIComponent(info.resourcePath.replace(/^\.\//, ''));
        const is_direct = info.allLoaders === '';
        const is_vue_script =
          resource_path.match(/\.vue$/) &&
          info.query.match(/\btype=script\b/) &&
          !info.allLoaders.match(/\bts-loader\b/);

        return `${is_direct === true ? 'src' : 'webpack'}://${info.namespace}/${resource_path}${is_direct || is_vue_script ? '' : '?' + info.hash}`;
      },
<<<<<<< HEAD
      // 扩展入口固定产出 index.js / index.css（manifest.json 里就写这两个名字）；
      // 脚本入口沿用模板的「一个目录一个同名文件」。
      filename: entry.extension ? 'index.js' : `${script_filepath.name}.js`,
      ...(entry.extension ? { cssFilename: 'index.css', assetModuleFilename: '[name][ext]' } : {}),
=======
      filename: `${script_filepath.name}.js`,
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
      path: path.join(
        import.meta.dirname,
        'dist',
        path.relative(import.meta.dirname, script_filepath.dir).replace(/^[^\\/]+[\\/]/, ''),
      ),
      chunkFilename: `${script_filepath.name}.[contenthash].chunk.js`,
<<<<<<< HEAD
      /**
       * publicPath 定死为 './'（相对）。
       *
       * 扩展的 dist 目录在 `/scripts/extensions/third-party/<名字>/` 下，具体路径取决于
       * 用户把仓库 clone 到哪，**编译期无从得知**。用 './' 让 webpack 按 chunk 自身位置
       * 解相对 URL，装到哪都对。
       * 脚本入口用 ''（酒馆里也是相对自身）。
       */
      publicPath: entry.extension ? './' : '',
      asyncChunks: entry.extension,
=======
      asyncChunks: true,
      clean: true,
      publicPath: '',
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
      library: {
        type: 'module',
      },
    },
    module: {
      rules: [
        {
          test: /\.vue$/,
          use: 'vue-loader',
          exclude: /node_modules/,
        },
        {
          oneOf: [
            {
              test: /\.tsx?$/,
              loader: 'ts-loader',
              options: {
                transpileOnly: true,
                onlyCompileBundledFiles: true,
                compilerOptions: {
                  noUnusedLocals: false,
                  noUnusedParameters: false,
                },
              },
              resourceQuery: /raw/,
              type: 'asset/source',
              exclude: /node_modules/,
            },
            {
              test: /\.(sa|sc)ss$/,
              use: ['postcss-loader', 'sass-loader'],
              resourceQuery: /raw/,
              type: 'asset/source',
              exclude: /node_modules/,
            },
            {
              test: /\.css$/,
              use: ['postcss-loader'],
              resourceQuery: /raw/,
              type: 'asset/source',
              exclude: /node_modules/,
            },
            {
              resourceQuery: /raw/,
              type: 'asset/source',
              exclude: /node_modules/,
            },
            {
              test: /\.tsx?$/,
              loader: 'ts-loader',
              options: {
                transpileOnly: true,
                onlyCompileBundledFiles: true,
                compilerOptions: {
                  noUnusedLocals: false,
                  noUnusedParameters: false,
                },
              },
              resourceQuery: /url/,
              type: 'asset/inline',
              exclude: /node_modules/,
            },
            {
              test: /\.(sa|sc)ss$/,
              use: ['postcss-loader', 'sass-loader'],
              resourceQuery: /url/,
              type: 'asset/inline',
              exclude: /node_modules/,
            },
            {
              test: /\.css$/,
              use: ['postcss-loader'],
              resourceQuery: /url/,
              type: 'asset/inline',
              exclude: /node_modules/,
            },
            {
              resourceQuery: /url/,
              type: 'asset/inline',
              exclude: /node_modules/,
            },
            {
              test: /\.tsx?$/,
              loader: 'ts-loader',
              options: {
                transpileOnly: true,
                onlyCompileBundledFiles: true,
                compilerOptions: {
                  noUnusedLocals: false,
                  noUnusedParameters: false,
                },
              },
              exclude: /node_modules/,
            },
            {
              test: /\.html$/,
              use: 'html-loader',
              exclude: /node_modules/,
            },
            {
              test: /\.md$/,
              use: [
                {
                  loader: 'html-loader',
                },
                {
                  loader: 'remark-loader',
                  options: {
                    remarkOptions: {
                      plugins: [RemarkHTML],
                    },
                  },
                },
              ],
            },
            {
              test: /\.ya?ml$/,
              loader: 'yaml-loader',
              options: { asStream: true },
              resourceQuery: /stream/,
            },
            {
              test: /\.ya?ml$/,
              loader: 'yaml-loader',
            },
          ].concat(
<<<<<<< HEAD
            entry.html === undefined || entry.extension
=======
            entry.html === undefined
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
              ? ([
                  {
                    test: /\.vue\.s(a|c)ss$/,
                    use: [
                      { loader: 'vue-style-loader', options: { ssrId: true } },
                      { loader: 'css-loader', options: { url: false } },
                      'postcss-loader',
                      'sass-loader',
                    ],
                    exclude: /node_modules/,
                  },
                  {
                    test: /\.vue\.css$/,
                    use: [
                      { loader: 'vue-style-loader', options: { ssrId: true } },
                      { loader: 'css-loader', options: { url: false } },
                      'postcss-loader',
                    ],
                    exclude: /node_modules/,
                  },
                  {
                    test: /\.s(a|c)ss$/,
<<<<<<< HEAD
                    // 扩展要真产出一个 index.css（manifest.json 的 css 字段指向它），
                    // 所以走 MiniCssExtract；脚本形态没有独立 css 文件可伺服，只能 style-loader 内联。
                    use: [
                      entry.extension ? MiniCssExtractPlugin.loader : 'style-loader',
=======
                    use: [
                      'style-loader',
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
                      { loader: 'css-loader', options: { url: false } },
                      'postcss-loader',
                      'sass-loader',
                    ],
                    exclude: /node_modules/,
                  },
                  {
                    test: /\.css$/,
<<<<<<< HEAD
                    use: [
                      entry.extension ? MiniCssExtractPlugin.loader : 'style-loader',
                      { loader: 'css-loader', options: { url: false } },
                      'postcss-loader',
                    ],
=======
                    use: ['style-loader', { loader: 'css-loader', options: { url: false } }, 'postcss-loader'],
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
                    exclude: /node_modules/,
                  },
                ] as any[])
              : ([
                  {
                    test: /\.s(a|c)ss$/,
                    use: [
                      MiniCssExtractPlugin.loader,
                      { loader: 'css-loader', options: { url: false } },
                      'postcss-loader',
                      'sass-loader',
                    ],
                    exclude: /node_modules/,
                  },
                  {
                    test: /\.css$/,
                    use: [
                      MiniCssExtractPlugin.loader,
                      { loader: 'css-loader', options: { url: false } },
                      'postcss-loader',
                    ],
                    exclude: /node_modules/,
                  },
                ] as any[]),
          ),
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js', '.tsx', '.jsx', '.css'],
      plugins: [
        new TsconfigPathsPlugin({
          extensions: ['.ts', '.js', '.tsx', '.jsx'],
          configFile: path.join(import.meta.dirname, 'tsconfig.json'),
        }),
      ],
      alias: {},
    },
<<<<<<< HEAD
    plugins: (entry.html === undefined || entry.extension
      ? [
          new MiniCssExtractPlugin(
            entry.extension
              ? {
                  /**
                   * ⚠️ 扩展的 CSS **必须全部进这一个文件**。
                   *
                   * 为什么：manifest.json 的 `css` 字段只能指向**一个**样式表，
                   * 酒馆就只加载它。只要样式被分到异步 chunk（`<id>.index.css`），
                   * 那个文件就**永远不会被加载** —— 表现是「悬浮球和面板全是裸样式」，
                   * 而且控制台一声不响（没有 404，因为压根没人请求它）。
                   *
                   * 所以 extension 入口下 filename === chunkFilename：
                   * 无论同步还是异步，CSS 都吐进 index.css。
                   */
                  // 样式已经由 splitChunks.cacheGroups.styles 合成一个 chunk，
                  // 所以这里只需要一个固定文件名（manifest.css 指的就是它）。
                  filename: 'index.css',
                  chunkFilename: 'index.css',
                }
              : {},
          ),
        ]
=======
    plugins: (entry.html === undefined
      ? [new MiniCssExtractPlugin()]
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
      : [
          new HtmlWebpackPlugin({
            template: path.join(import.meta.dirname, entry.html),
            filename: path.parse(entry.html).base,
            scriptLoading: 'module',
            cache: false,
          }),
          new HtmlInlineScriptWebpackPlugin(),
          new MiniCssExtractPlugin(),
          new HTMLInlineCSSWebpackPlugin({
            styleTagFactory({ style }: { style: string }) {
              return `<style>${style}</style>`;
            },
          }),
        ]
    )
      .concat(
        { apply: watch_tavern_helper },
        { apply: schema_dump },
        { apply: tavern_sync },
        new VueLoaderPlugin(),
        unpluginAutoImport({
          dts: true,
          dtsMode: 'overwrite',
          imports: [
            'vue',
            'pinia',
            '@vueuse/core',
            { from: 'dedent', imports: [['default', 'dedent']] },
            { from: 'klona', imports: ['klona'] },
            { from: 'vue-final-modal', imports: ['useModal'] },
            { from: 'zod', imports: ['z'] },
            { from: 'type-fest', imports: [['*', 'TypeFest']], type: true },
          ],
        }),
        unpluginVueComponents({
          dts: true,
          syncMode: 'overwrite',
          // globs: ['src/panel/component/*.vue'],
          resolvers: [VueUseComponentsResolver(), VueUseDirectiveResolver()],
        }),
<<<<<<< HEAD
        // 单文件闸：**只对脚本入口**。扩展入口要正常分包（见 optimization.splitChunks）。
        ...(entry.extension ? [] : [new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })]),
=======
        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
        new webpack.DefinePlugin({
          __VUE_OPTIONS_API__: false,
          __VUE_PROD_DEVTOOLS__: process.env.CI !== 'true',
          __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
        }),
      )
<<<<<<< HEAD
      .concat(entry.extension ? [copy_extension_assets(entry.script)] : [])
=======
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
      .concat(
        should_obfuscate
          ? [
              new WebpackObfuscator({
                controlFlowFlattening: true,
                numbersToExpressions: true,
                selfDefending: true,
                simplify: true,
                splitStrings: true,
                seed: 1,
              }),
            ]
          : [],
      ),
    optimization: {
      minimize: true,
      minimizer: [
        argv.mode === 'production'
          ? new TerserPlugin({
              terserOptions: { format: { quote_style: 1 }, mangle: { reserved: ['_', 'toastr', 'YAML', '$', 'z'] } },
            })
          : new TerserPlugin({
              extractComments: false,
              terserOptions: {
                format: { beautify: true, indent_level: 2 },
                compress: false,
                mangle: false,
              },
            }),
      ],
<<<<<<< HEAD
      /**
       * 分包策略：**按入口形态分开**。
       *
       * 脚本入口（一个脚本 = 一个文件）：一刀切关掉。
       *   酒馆脚本是单个 .json 里的单段代码，`import()` 拆出的 chunk 在酒馆里**永远 404**
       *   （没有静态服务器去伺服它）。所以插件页面只能静态 import，构建也不许产出任何 chunk。
       *   上面的 LimitChunkCountPlugin({maxChunks:1}) 单独用不够稳：它只在**超限时合并**，
       *   配合 cacheGroups 仍可能留着异步 chunk 的加载器 —— 直接关掉 splitChunks 才干净。
       *   门禁：`Get-ChildItem dist -Recurse -Filter *.chunk.js` 必须为空。
       *
       * 扩展入口（stage 3.5 决策 7）：**撤销这个妥协**。
       *   扩展的 dist 目录由酒馆的静态服务器伺服，chunk 拿得到，分包是纯收益：
       *   底座初始化不用等整个 Vue 应用；插件页可以动态 import（顺带补上
       *   「插件 = 自包含目录」在 UI 层的破洞）。
       *   ⚠️ chunk 是 contenthash 文件名 —— 发布必须**原子**，index.js 与 chunk 同批上线，
       *      否则就是「更新后白屏」（旧 index.js 引用的 chunk 已经不在了）。
       */
      splitChunks: entry.extension
        ? {
            chunks: 'async',
            /**
             * ⚠️ 所有 CSS 必须合并成**一个** chunk（落到 index.css）。
             *
             * 为什么：manifest.json 的 `css` 字段只能指定一个样式表，酒馆只加载它。
             * 而我们用 `await import()` 动态加载界面 —— 这会顺带拆出一个异步 CSS chunk。
             * 那个 chunk 的文件名虽然也叫 index.css（上面 filename === chunkFilename），
             * 但**两个 chunk 抢同一个文件名**，webpack 直接报
             * 「Conflict: Multiple chunks emit assets to the same filename」。
             *
             * 正解：让 splitChunks 把所有 **样式模块** 都归进同一个 cacheGroup，
             * 于是只产出一份 CSS。JS 仍然照常异步分包（那才是我们要的收益）。
             */
            cacheGroups: {
              styles: {
                name: 'styles',
                type: 'css/mini-extract',
                chunks: 'all',
                enforce: true,
              },
              // 关掉默认的 vendors/default，避免它们再把 CSS 拆走
              defaultVendors: false,
              default: false,
            },
          }
        : false,
=======
      splitChunks: {
        chunks: 'async',
        minSize: 20000,
        minChunks: 1,
        maxAsyncRequests: 30,
        maxInitialRequests: 30,
        cacheGroups: {
          vendor: {
            name: 'vendor',
            test: /[\\/]node_modules[\\/]/,
            priority: -10,
          },
          default: {
            name: 'default',
            minChunks: 2,
            priority: -20,
            reuseExistingChunk: true,
          },
        },
      },
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
    },
    externals: ({ context, request }, callback) => {
      if (!context || !request) {
        return callback();
      }

      if (
        request.startsWith('-') ||
        request.startsWith('.') ||
        request.startsWith('/') ||
        request.startsWith('!') ||
        request.startsWith('http') ||
        request.startsWith('@/') ||
        request.startsWith('@util/') ||
        path.isAbsolute(request) ||
        fs.existsSync(path.join(context, request)) ||
        fs.existsSync(request)
      ) {
        return callback();
      }

      if (
        ['vue', 'vue-router'].every(key => request !== key) &&
        ['pixi', 'react', 'vue'].some(key => request.includes(key))
      ) {
        return callback();
      }
      const global = {
        jquery: '$',
        lodash: '_',
        showdown: 'showdown',
        toastr: 'toastr',
        vue: 'Vue',
        'vue-router': 'VueRouter',
        yaml: 'YAML',
        zod: 'z',
      };
<<<<<<< HEAD
      // ⚠️ 扩展入口**不许**走宿主全局变量这条路。
      // 脚本形态能这么写，是因为酒馆助手的 iframe 里预先把 Vue/z 挂在 window 上；
      // 扩展是直接跑在酒馆页面里的，那里**没有** Vue / z 全局，
      // 照搬会得到一个运行时 undefined。扩展一律自己打包依赖。
      if (entry.extension) {
        const cdn = { sass: 'https://jspm.dev/sass' };
        return callback(null, 'module-import ' + (cdn[request as keyof typeof cdn] ?? `https://testingcf.jsdelivr.net/npm/${request}/+esm`));
      }
=======
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
      if (request in global) {
        return callback(null, 'var ' + global[request as keyof typeof global]);
      }
      const cdn = {
        sass: 'https://jspm.dev/sass',
      };
<<<<<<< HEAD
      return callback(
        null,
        'module-import ' + (cdn[request as keyof typeof cdn] ?? `https://testingcf.jsdelivr.net/npm/${request}/+esm`),
=======
      const package_json = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const package_versions = { ...package_json.devDependencies, ...package_json.dependencies };
      const version = package_versions[request]?.replace(/^[~^]/, '');
      const versioned_request = /^[.\d]+$/.test(version) ? `${request}@${version}` : request;
      return callback(
        null,
        'module-import ' +
          (cdn[request as keyof typeof cdn] ?? `https://testingcf.jsdelivr.net/npm/${versioned_request}/+esm`),
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
      );
    },
  });
}

<<<<<<< HEAD
/**
 * 只构建指定的入口：`CX_ONLY=extension webpack --mode development`。
 *
 * 为什么不用 `--config-name`：本文件导出的是**函数数组**（webpack-cli 在匹配
 * `--config-name` 时不会先调用它们），实测报「Configuration with the name ... was not found」。
 * 而全量构建会把 `dist/苍玄助手/index.html` 一起覆盖成 dev 版，污染
 * `build_tavern_script.mjs` 的输入 —— 开发时只想动扩展，用这个环境变量把范围收窄。
 *
 * 不设这个变量时行为**完全不变**（发布 / CI 走的就是这条路径）。
 */
const only = process.env.CX_ONLY?.trim();
const selected = only ? config.entries.filter(entry => entry.script.replace(/\\/g, '/').startsWith(only)) : config.entries;

if (only) {
  if (selected.length === 0) {
    console.error(`\x1b[31m[webpack]\x1b[0m CX_ONLY="${only}" 没有匹配到任何入口`);
  } else {
    console.info(`\x1b[36m[webpack]\x1b[0m CX_ONLY="${only}" → 只构建 ${selected.length} 个入口：${selected.map(e => e.script).join(', ')}`);
  }
}

export default selected.map(parse_configuration);
=======
export default config.entries.map(parse_configuration);
>>>>>>> f447e54f4effc7980891d89ab7e9b3c9aa02737e
