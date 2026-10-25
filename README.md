# 纯文本阅读器

一个只读 **`.txt`** 的本地网页阅读器：**打开即读、排版稳、进度不丢**。
手机为主的 PWA，零构建、零依赖（含 devDependencies）、数据只存在本机 IndexedDB。

- 产品要求：[docs/product-design.md](./docs/product-design.md)
- 工程方案：[docs/technical-design.md](./docs/technical-design.md)（v0.3，与产品文档冲突处以它为准）
- 部署手册：[docs/deploy-github-pages.md](./docs/deploy-github-pages.md)

---

## 快速开始

```bash
# 单元测试（node 内置 test runner，无需安装任何依赖）
node --test

# 本地开发（任选其一）
python -m http.server 8080
node scripts/serve.mjs --port 8080        # 加 --open 会自动打开浏览器
```

Windows 上直接**双击 `start.cmd`** 也行：它会自动找 Node（PATH 里没有就找常见安装位置），
起好服务器并打开 <http://127.0.0.1:8080/>。
从终端跑要用 `.\start.cmd`（部分环境设置了 `NoDefaultCurrentDirectoryInExePath`，
不认当前目录里的裸命令名）。

然后打开 <http://127.0.0.1:8080/>。

## 打开是一片空白？

**九成是双击了 `index.html`（`file://` 协议）。** 这个阅读器用 ES module + IndexedDB，
浏览器在 `file://` 下会以 `origin: null` 把 module 拦掉（Chrome 控制台报 CORS），
Safari 还会直接禁用 IndexedDB —— 于是整页只剩背景色。这是技术方案的 KD-1，
也是纯静态站最经典的坑。

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面空白、控制台报 `Access to script at 'file:///...' from origin 'null' has been blocked by CORS policy` | 直接双击了 `index.html` | 双击 `start.cmd`，或 `node scripts/serve.mjs --port 8080` 后访问 `http://127.0.0.1:8080/` |
| 空白并显示「不能直接双击 index.html 打开」的说明 | 同上（这是本项目的启动兜底在解释原因） | 同上 |
| 页面空白、Network 里 `main.js` 是 404 | 部署路径不对（例如 GitHub Pages 少了仓库前缀） | 确认所有资源引用都是 `./` 开头；跑 `node --test`，`assets.test.js` 会拦住 |
| 页面空白、控制台报 `TextDecoder: gb18030 is not supported` | 极老的浏览器 | 换 Chrome / Edge / Safari 15+ |
| 只显示「正在启动…」然后没了 | JS 已执行但首屏渲染失败 | 看控制台；`boot()` 的 catch 会把错误写回页面 |

> 用 `file://` 也不是完全没救（`chrome --allow-file-access-from-files`），但那是调试开关，
> 不是交付形态：Service Worker 在 `file://` 下同样注册不了，PWA 装不上、离线也不会生效。


## 目录结构

```
index.html                 单页外壳（内联主题脚本必须早于样式表，KD-9）
manifest.webmanifest       PWA 清单（start_url / scope 都是 "./"，KD-14）
sw.js                      app shell 缓存（cache-first + 版本探测，KD-15）
assets.manifest.json       SW 预缓存清单 + 缓存版本号（改前端就递增）
.nojekyll                  让 GitHub Pages 跳过 Jekyll
icons/                     SVG + 192/512/180 PNG（iOS 只认 PNG）

styles/themes.css          三主题变量（亮 / 暗 / 护眼）
styles/app.css             布局、阅读排版、工具栏、抽屉、面板

src/main.js                启动与 hash 路由（#/shelf、#/read/:id）
src/decode.js              编码探测 + 置信度打分        ← 纯函数
src/normalize.js           章级归一化（分段/去缩进/滤广告/去重标题）← 纯函数
src/chapters.js            单遍索引扫描切章 + 8000 字兜底 ← 纯函数
src/position.js            位置模型换算                ← 纯函数
src/backup.js              备份序列化 / 合并计划        ← 纯函数
src/ingest.js              导入管线（worker 与测试共用）← 纯函数
src/ingest.worker.js       worker 薄壳，只做消息转发
src/store.js               BookRepository 的 IndexedDB 实现 + 内存降级
src/reader.js              三段窗口、哨兵换章、滚动锚定、触摸分区、位置恢复
src/bookshelf.js           书架、导入进度、备份导出/导入
src/settings.js            字号/行距/主题（localStorage）
src/ui.js                  通用 DOM 与格式化工具

test/*.test.js             100 个用例，覆盖 §7.1 全部条目
scripts/serve.mjs          零依赖静态服务器（开发期）
scripts/gen-icons.mjs      一次性生成 PWA 位图图标（开发期）
```

## 测试

```bash
node --test
```

| 文件 | 覆盖点 |
|---|---|
| `decode.test.js` | 环境断言（gb18030/utf-16be）、BOM 三态、严格 UTF-8、GB18030 回退、纯 ASCII、非法字节、空文件、低置信度样本、强制编码 |
| `normalize.test.js` | CRLF/CR、每行一段、空行分段、西文折行、全角缩进、广告过滤与不误杀、标题去重、纯空白章、相似度 |
| `chapters.test.js` | 十余种标题格式、正文引用不误匹配、超长行、前置内容、相邻标题、8000 字兜底、超长单行、进度回调、连续性 |
| `position.test.js` | 往返换算、不满一屏归零、越界收敛、脏进度容错 |
| `backup.test.js` | 导出结构、解析容错、版本拒绝、按 id 合并、更新者优先、`missing` 占位、摘要文案 |
| `ingest.test.js` | 端到端入库、GB18030、空文件、超限、配额失败、进度单调、低置信度留存字节、重解码、书名兜底 |
| `assets.test.js` | 清单文件存在性、无绝对路径、manifest 前缀、相对导入可解析、SW 不碰数据、BOM 守卫、零依赖 |

## 发布（GitHub Pages）

```
1. 改代码
2. 递增 assets.manifest.json 的 version（格式 日期.当日序号）
3. node --test 全绿
4. git push → 等 Pages 发布（约 1 分钟）→ 手机端「完全关闭后重开」验证
```

第 2 步是唯一的人肉环节：`version` 是 SW 缓存名的唯一来源。

## 与设计文档的差异（实现记录）

实现过程中有 5 处必须偏离或补强原方案，都写在代码注释里，这里集中列出：

| # | 原方案 | 实现 | 原因 |
|---|---|---|---|
| 1 | `books / texts / progress` 三个 store | 增加第四个 `raws` | §5.3 要求"手动切换编码并重切章"，而正文解码后无法反推原始字节。只在**置信度低**（罕见）时留存原始字节，其余正常导入不占额外空间 |
| 2 | KD-7 建议离屏段落用 `content-visibility: auto` | tail/head 段不使用，只保留 `contain` | 实测 Chromium 会让段落高度先估算后落定，触发滚动锚定改写 `scrollTop`（换章后自己往下窜），并把章内百分比算成 >100%。KD-8 已把该风险列出并允许"对分段禁用该属性" |
| 3 | KD-15：只递增 `assets.manifest.json` 的 `version` 即可生效 | 导航时无状态探测清单：装最新版本、保留最新两个缓存、删更旧的 | ① 浏览器只在 **`sw.js` 字节变化**时才重跑 `install`，只改清单版本新版本永远装不进来（实测确认）；② SW 空闲约 30s 会被杀，模块级"待生效版本"变量不可靠，所以缓存维护必须无状态；③ 保留两个而不是一个，避免"HTML 来自旧缓存、JS 已切到新缓存"的混搭 |
| 4 | 目录抽屉一次性渲染全部章节 | 固定行高虚拟列表（只渲染视口附近约 20 行） | 4000 章实测建 DOM 需要 ~1.9s；虚拟化后同步耗时 ~2ms |
| 5 | `raf2()` 纯等两帧 | 等两帧 + 250ms 超时兜底 | 标签页被遮挡/后台时浏览器把 rAF 暂停或降到 ~1fps，纯等帧会让换章流程永久卡住（`promoting` 不归零，后续操作静默失效） |

另有 3 处实现细节选择：

- **桌面字号**：宽度 ≥720px 只限制行宽（`40em`），不覆盖用户字号，否则设置面板在桌面上失效。
- **触摸分区只服务粗指针**：`pointerType === 'touch'` 或 `(pointer: coarse)` 才生效，桌面走快捷键与工具栏按钮（KD-7 原意）。
- **滚动锚定**：`overflow-anchor: none`，避免浏览器自带锚定与我们自己的 `captureAnchor/applyAnchor` 互相打架。

## 已实测的性能（桌面 Chromium，非验收基准机）

| 指标 | 实测 | 预算 |
|---|---|---|
| 20MB / GB18030 导入（4000 章 / 1054 万字） | **995 ms** | 桌面 < 3000ms，中端机 < 6000ms |
| 打开书到首屏可见 | **246 ms** | 桌面 < 500ms，中端机 < 800ms（未触发 KD-3 分片切换条件） |
| 单章渲染后 DOM 节点总数 | **84–206** | 与全书大小无关 |
| 改字号 18→28 后位置漂移 | **0.025%** | < 1% |
| 关掉再打开（进度恢复误差） | **0.0035%** | < 1% |
| 目录抽屉打开（4000 章，同步耗时） | **~2 ms** | — |
| 离线冷启动 → 打开已读书并读到正文 | 通过 | 通过 |

## 已知边界

- 章节正则只覆盖常见中文网文标题格式；罕见格式会走 8000 字兜底（`autoSplit: true`，书架显示"自动分节"）。
- 低置信度编码需要原始字节才能手动切换；若原始字节缺失（如从备份恢复的占位书），会提示重新导入。
- 安卓多数机型没有中文衬线字体，会回退到系统黑体（KD-13 已接受该回退）。
