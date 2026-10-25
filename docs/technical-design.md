# 纯文本阅读器 · 技术方案

> 版本：v0.3（手机为主 · GitHub Pages 托管）
> 状态：待评审
> 最后更新：2026-10-25
> 上游文档：[product-design.md](./product-design.md)
> 部署手册：[deploy-github-pages.md](./deploy-github-pages.md)
> 版本依据：v0.2 定形态为**手机为主**（见 §0）；v0.3 定托管为 **GitHub Pages**，据此新增相对路径纪律与 SW 缓存版本策略（KD-14、KD-15），并重写第 8 节。

本文档是 [product-design.md](./product-design.md) 的工程落地版本。产品范围、验收标准以产品文档为准；本文档只回答"用什么建、怎么切模块、哪些坑必须绕开"。凡是与产品文档冲突之处，以本文档第 12 节的变更记录为准，并已注明理由。

---

## 0. 形态前提：手机为主

这条决策改变了下面几乎每一节。明确它意味着什么：

| 维度 | 结论 | 影响 |
|---|---|---|
| 主战场 | 手机浏览器（iOS Safari / Android Chrome），PWA 安装到主屏 | 交付形态、输入方式、性能预算全部重定 |
| 次战场 | 桌面浏览器 | 保留，但不为它做专属优化 |
| 不做 | 桌面壳（Tauri / Electron）、原生 App | 需求已被 PWA 覆盖，见 KD-1 |
| 一期必做 | 离线可用、纵向单手操作、切后台不丢位置 | 不再是"以后再说" |

**一句话**：这不是"网页版顺便支持手机"，而是"一个手机阅读器，桌面浏览器顺带能用"。

---

## 1. 技术栈定版

| 层 | 选型 | 定版理由 |
|---|---|---|
| 运行形态 | GitHub Pages（静态）+ PWA，全相对路径 | 手机用户无法起本地服务器；零构建下相对路径是唯一可移植解，见 KD-1、KD-14 |
| 构建 | 无 | 原生 ES modules，改一行刷新即见 |
| 框架 | 无 | 原生 DOM，页面复杂度不足以支撑框架成本 |
| 样式 | 原生 CSS + CSS 变量 + `dvh` | 主题切换只改变量，不重排 |
| 并发 | Web Worker（1 个，长驻） | 手机上解码切章更必须离开主线程，见 KD-6 |
| 存储 | IndexedDB（手写薄封装） | 全文与进度；无第三方依赖 |
| 设置 | localStorage | 主题需在首帧前同步应用，见 KD-9 |
| 离线 | Service Worker（app shell 缓存） | 手机弱网/无网场景是主要场景 |
| 编码 | `TextDecoder`（utf-8 / gb18030 / utf-16le / utf-16be） | 浏览器原生，无需 WASM |
| 测试 | `node --test` | 内置，零依赖 |
| 依赖总数 | **0**（含 devDependencies） | 零依赖是硬约束，不是偏好 |

**明确不引入**：打包器、框架、状态库、CSS 预处理器、IndexedDB 封装库、编码库、测试框架、字体子集化工具。

---

## 2. 架构总览

```
┌────────────────────────── 主线程 ──────────────────────────┐
│                                                            │
│  main.js ── 路由（hash: #/shelf | #/read/:id）             │
│    │                                                       │
│    ├── bookshelf.js   书架列表（只读元数据）               │
│    ├── reader.js      阅读器：三段窗口 + 触摸手势 + 哨兵   │
│    ├── settings.js    字号/行距/主题（localStorage）       │
│    ├── backup.js      进度与书单导出/导入（防存储被清）    │
│    └── ui.js          通用 DOM 工具                        │
│                                                            │
│  store.js ── 实现 BookRepository 接口                      │
└───────────────┬────────────────────────┬───────────────────┘
                │ postMessage            │ IndexedDB
                │ (ArrayBuffer transfer) │
┌───────────────▼──────────────┐  ┌──────▼───────────────────┐
│  ingest.worker.js（长驻）    │  │  DB: txt-reader          │
│                              │  │  ├ books     (元数据)    │
│  decode.js    BOM→UTF8→GB18030│ │  ├ texts     (全文)      │
│  normalize.js 章级归一化      │ │  └ progress  (进度)      │
│  chapters.js  单遍索引扫描    │  │                          │
│                              │  │  settings → localStorage │
│  写入 texts / books（自己开）│  │                          │
└──────────────────────────────┘  └──────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  sw.js  ── 缓存 app shell（html/css/js），不碰 IndexedDB 数据 │
└─────────────────────────────────────────────────────────────┘
```

**数据流（导入）**

```
<input type=file>（accept 不可靠，见 KD-12）
  → file.arrayBuffer()
  → postMessage({type:'ingest', buffer}, [buffer])   ← 零拷贝转移
  → [worker] BOM 探测 → 解码 → 置信度评估
  → [worker] 单遍扫描切章（产出 offsets，不产生新字符串）
  → [worker] 写 texts(全文) + books(元数据)
  → postMessage({type:'ingest:done', meta})          ← 只回小对象
  → 主线程刷新书架
```

关键点：**20MB 字符串永不跨越线程边界**。worker 自己写库，主线程只收一张小元数据。

**数据流（阅读）**

```
openBook(id)
  → store.getBookMeta(id)      小对象
  → store.getProgress(id)      小对象
  → store.getChapterText(id, n) → text.slice(offset, length)
  → reader.render({prevTail, current, nextHead})
  → 布局稳定（fonts.ready + 2×rAF）→ 应用 scrollTop
  → 滚动 rAF 节流 → 计算位置 → 500ms 防抖写回 progress
```

---

## 3. 目录结构

```
/
├─ index.html
├─ .nojekyll                     # 空文件，让 Pages 跳过 Jekyll 处理
├─ manifest.webmanifest          # v0.1 必做
├─ sw.js                         # v0.1 必做
├─ assets.manifest.json          # SW 预缓存清单 + 缓存版本号
├─ icons/                        # PWA 图标（SVG 一份 + iOS 需要的 PNG）
├─ styles/
│  ├─ app.css                    # 布局、阅读排版、触摸区
│  └─ themes.css                 # 三主题变量
├─ src/
│  ├─ main.js                    # 启动与 hash 路由
│  ├─ decode.js                  # 编码探测        ← 纯函数
│  ├─ normalize.js               # 章级归一化      ← 纯函数
│  ├─ chapters.js                # 章节切分        ← 纯函数
│  ├─ position.js                # 位置模型换算    ← 纯函数
│  ├─ backup.js                  # 备份序列化/反序列化 ← 纯函数
│  ├─ store.js                   # BookRepository 的 IndexedDB 实现
│  ├─ ingest.worker.js           # worker 薄壳，只做消息转发
│  ├─ ingest.js                  # ingest 管线（worker 与测试共用）← 纯函数
│  ├─ bookshelf.js
│  ├─ reader.js
│  ├─ settings.js
│  └─ ui.js
├─ test/
│  ├─ decode.test.js
│  ├─ normalize.test.js
│  ├─ chapters.test.js
│  ├─ position.test.js
│  ├─ backup.test.js
│  └─ ingest.test.js
└─ docs/
   ├─ product-design.md
   ├─ technical-design.md
   └─ deploy-github-pages.md
```

**为什么多出 `.nojekyll` 和 `assets.manifest.json`**：

- `.nojekyll`：GitHub Pages 默认会跑一遍 Jekyll 处理静态站点。本项目没有任何 Jekyll 特性，跳过它可以消除一类"文件被忽略/构建延迟"的诡异问题，成本是一个空文件。
- `assets.manifest.json`：零构建意味着没有打包器替我们发现"漏了哪个文件"，所以把 SW 预缓存清单外置成数据文件，让 `node --test` 能直接校验每个路径真实存在（见 §7.1）。详见 KD-15。

**可测性设计**：`decode` / `normalize` / `chapters` / `position` / `backup` / `ingest` 六个模块不碰 DOM、不碰 `indexedDB`、不碰 `self`，全部可在 Node 里直接 import。`ingest.worker.js` 只是十几行消息透传壳。

目的很实际：**导入了 20MB 大文件才发现的切章 bug，能在毫秒级的单元测试里复现**。

---

## 4. 关键决策

### KD-1 交付形态：HTTPS 静态托管 + PWA（v0.1 必做）

手机为主直接否掉了两个原方案。

**否决一：本地 `python -m http.server`。** 手机没法起服务。让手机访问电脑的 `192.168.x.x:8080` 等于要求电脑一直开着——这不是阅读器，是局域网调试工具。

**否决二：`file://` 直接打开。** Chrome 以 `origin: null` 拦掉 ES module，Safari 在 `file://` 下禁用 IndexedDB。手机上这条路完全不存在。

**决策**：

| 阶段 | 形态 |
|---|---|
| 开发 | `python -m http.server 8080`，仅本机调试 |
| 交付 | 静态托管（Cloudflare Pages / GitHub Pages，纯静态、免费 HTTPS、无需构建） |
| 使用 | 手机浏览器打开 → 添加到主屏幕 → 后续从图标启动，离线可用 |

**PWA 是一期范围，不是 v0.5。** 理由：手机上不开 PWA 的浏览器版有三个致命体验损耗——地址栏吃掉 60–100px 视口、每次要输网址/翻历史、Safari 的后台回收更激进。而 PWA 的成本只有 `manifest.webmanifest`（约 25 行）+ `sw.js`（约 60 行）。

**关键约束**：Service Worker 只在 HTTPS 或 localhost 下可用。所以"托管"不是可选项。

**Service Worker 策略**（写死，防止以后乱改）：

- app shell（`index.html` / `styles/*` / `src/*` / `manifest`）→ **cache-first**，版本号变更时整批替换
- `texts` / `books` / `progress` → **不进 SW 缓存**，数据只在 IndexedDB
- 更新：新版本 `install` 后 `skipWaiting()` + `clientsClaim()`，主线程监听 `controllerchange` 提示"已更新，重新打开生效"

### KD-2 存储四分开，`listBooks` 绝不读正文

产品文档把 `text` 放在 `books` 记录里，这在手机上会更快炸：书架打开时若用 `getAll()` 取 `books`，IndexedDB 会把每本书十几 MB 的字符串全部结构化克隆进内存——10 本书就是上百 MB，低端手机直接触发页面回收。

**决策**：拆成两个 store，元数据与正文物理分离。

| store | keyPath | 内容 |
|---|---|---|
| `books` | `id` | 元数据 + `chapters` 数组，**不含 text** |
| `texts` | `bookId` | `{ bookId, text }` 全文 |
| `progress` | `bookId` | 阅读位置 |
| ~~`settings`~~ | — | 改走 localStorage，见 KD-9 |

`listBooks()` 只读 `books`，单条约 1–50KB。

### KD-3 按章取文：接口按章切，实现先整本 + 设置切换条件

`BookRepository` 的读取接口是**章级**的：

```js
getChapterText(bookId, chapterIndex) // → string
```

v0.1 实现为"整本读出 + `slice(offset, length)`"。V8 的 sliced string 与原串共享底层存储，切一章是 O(1)，不复制 3000 字——这一点在手机上很重要，它让"整本驻留"的内存代价只有一份。

**不预做按章分片存储**，但要设一个明确的切换条件（benchmark gate）：

> 若 M3 结束时实测「打开书到首屏可见」在中端安卓上 > 800ms，**必须**在 M4 前把 `texts` 换成按章分片 store（每章一条记录）。
> 判断依据：整本读取要走一次 16MB 反序列化，中端机约 200–500ms；按章读只需几 KB。

调用方不受影响——这正是接口按章设计的目的。

### KD-4 归一化延迟到章级，offsets 永远基于原始解码文本

**决策**：全文只做一次线性扫描（切章），**不生成归一化后的新字符串**。归一化只在渲染单章时对该章文本执行。

**理由**：800 万字的文本连续执行 5 次 `replace`，每次复制一个新串，瞬时内存 80MB 以上。手机上这是页面被 kill 的直接原因。

**坐标系统一原则**（必须遵守）：

> `chapters[].offset/length` 永远指向**原始解码文本**的字符坐标。任何会改变字符数的处理（广告行删除、空行压缩、缩进剥离）一律只允许发生在**章内渲染阶段**。

这样"过滤广告行"再激进，也不会让第 30 章的 offset 失效。

### KD-5 章节切分：单遍索引扫描

**禁止**：

- `text.split('\n')` —— 800 万字产生数十万个字符串对象，手机上 GC 压力显著
- `text.match(GLOBAL_RE)` —— 复杂多分支正则回溯不可控，可能秒级
- 多次 `replace` 链 —— 见 KD-4

**做法**：单遍、基于索引、可中断的扫描。

```js
// chapters.js 的形状（示意，非最终实现）
export function scanChapters(text, opts) {
  // 1. 行首锚定：只接受 offset===0 或前一个字符是 \n 的位置
  // 2. 每行只做一次 lineStartRe.test(line)（非全局正则，无 lastIndex 状态污染）
  // 3. 命中则 push { index, title, offset, length: nextOffset - offset }
  // 4. 每 1MB 检查一次 elapsed，超预算回报进度（可中断，回主线程让步）
}
```

**关键约束**：章节标题正则必须**行首锚定**（`^` + `m`，或手工判断行首）。否则正文里"他在第三章里写道"会被识别成章节，产生假章、错乱进度。这是最容易漏的 bug。

**兜底**：命中数 < 2 时按固定 8000 字切块，`title` 生成 `"第 N 节"`，置 `meta.autoSplit = true`。

### KD-6 导入管线 Worker 化，worker 直接写库

**决策**：

- `postMessage` 用 `[buffer]` transfer 传 `ArrayBuffer`，零拷贝
- 解码、置信度评估、切章、写库全部在 worker 内完成
- worker 内自己 `indexedDB.open`，**只写不读**；主线程只读不写，避免 versionchange 竞争
- 批量写入用**单个 transaction** 包住（否则 800 条记录慢一个数量级）

**手机上这条比桌面更重要**：中端机主线程被占用 2 秒，用户会以为 App 卡死并返回桌面——返回即触发页面回收，导入白做。

**回报协议**：

```js
// 主 → worker
{ type: 'ingest', id, buffer: ArrayBuffer, fileName, byteSize }

// worker → 主
{ type: 'ingest:progress', id, phase: 'decode'|'scan'|'store', ratio: 0..1 }
{ type: 'ingest:done',     id, meta }            // meta 不含 text
{ type: 'ingest:failed',   id, reason, detail }
// reason: 'empty' | 'too-large' | 'decode-low-confidence'
//       | 'storage-error' | 'quota-exceeded'
```

导入全程必须有**进度条 + 可取消**。手机上用户看不到反馈就会退出。

### KD-7 渲染：三段式滑动窗口 + 触摸手势

产品文档写"只渲染当前章"。纯按章替换会带来体验硬伤：**滚到章尾内容突然没了**。手机上问题更严重——一屏约 400–600 字，一章 3000 字只有 5–7 屏，等于每 6 屏打断一次。

**决策：渲染三段，哨兵驱动无缝换章。**

```html
<div id="viewport">                             <!-- overflow-y:auto，唯一滚动容器 -->
  <section data-chapter="29" data-role="tail">  <!-- 上一章末 800 字 -->
  <section data-chapter="30" data-role="main">  <!-- 当前章全文 -->
  <section data-chapter="31" data-role="head">  <!-- 下一章首 800 字 -->
</div>
```

- 哨兵用 `IntersectionObserver`（root 为 `#viewport`，`rootMargin: '0px 0px 200px 0px'`），不用 `scroll` 事件判断边界
- 视口顶进入 `head` 段 → `promote(31)`：重建为 (30 尾 / 31 全文 / 32 头)
- DOM 上界恒定：约 4600 字 / 150 段落 / 300 节点，与全书大小无关
- 段落容器加 `content-visibility: auto` + `contain: layout paint`，离屏段落跳过排版

**滚动锚定（防止换章瞬间跳屏）**：

```
1. 记录锚点：换章前取 head 段第一个 <p> 的 rect.top
2. 重建 DOM
3. 重新测量同一元素（现在它是 main 段内容）的 rect.top
4. scrollTop += (newTop - oldTop)
5. 一帧后校验：若可视区文本指纹不一致，再补一次（最多 2 轮）
```

手机上还要多处理一件事：**iOS 惯性滚动的 momentum 阶段**。手势抬起后仍有 `scroll` 事件。若在 momentum 中触发 `promote` 并改写 `scrollTop`，会出现"手还在滑、内容突然被拽回"的错乱。对策：`promote` 只在**连续 2 帧 scrollTop 变化 < 1px**（即滚动已静止）时执行，否则标记 pending，静止后立即执行。

**UI 结构（手机）**：

| 元素 | 桌面 | 手机 |
|---|---|---|
| 章节列表 | 左侧栏常驻可折叠 | **全屏抽屉**，从左侧滑入，遮罩关闭 |
| 设置面板 | 侧栏 | 底部 sheet，安全区适配 |
| 顶部/底部工具条 | 常驻 | **默认隐藏**，点击中央区切换 |

**触摸交互（手机）**：

```
点击左 1/4 区域   → 上一章
点击右 1/4 区域   → 下一章
点击中央 1/2 区域 → 切换工具条显隐
```

- 用 `pointerdown/pointerup` 判断位移 < 10px 才算"点击"，避免与滚动、滑动手势冲突
- 阅读区 `user-select: none`：v0.1 不做文本复制，避免长按选中打断阅读
- `touch-action: manipulation` 消除双击缩放延迟
- **不禁止用户缩放**（不加 `user-scalable=no`）。字号设置已覆盖主要需求，禁用缩放会伤害可访问性

**桌面保留**键盘快捷键：`←/→` 切章、`Esc` 关抽屉、`+/-` 调字号。用 `matchMedia('(pointer: coarse)')` 决定挂哪一套。

### KD-8 位置模型：像素比例 + 手机视口时序

```js
// position.js
export function toPercent(scrollTop, scrollHeight, clientHeight) {
  const max = Math.max(0, scrollHeight - clientHeight)
  return max === 0 ? 0 : clamp01(scrollTop / max)   // 内容不满一屏时恒为 0
}

export function toScrollTop(percent, scrollHeight, clientHeight) {
  return percent * Math.max(0, scrollHeight - clientHeight)
}
```

**铁律：一律用滚动容器自身的 `clientHeight`，绝不用 `window.innerHeight`。** 手机地址栏收缩会让 `innerHeight` 变化 60–100px，用它算比例会在滚动中出现位置漂移。

**恢复时序**（顺序错了就会漂）：

```
1. history.scrollRestoration = 'manual'   ← 阻止 Safari 自己的滚动恢复与我们对冲
2. 从 IndexedDB 读出 progress
3. 渲染三段 DOM
4. await document.fonts.ready
5. 应用主题/字号/行距的 CSS 变量
6. 连等 2 帧 requestAnimationFrame       ← 确保 reflow 完成
7. 测量 viewport.scrollHeight / clientHeight
8. 设置 scrollTop = toScrollTop(...)
```

第 1 步是手机特有的坑：iOS 在页面重载/从后台恢复时会尝试恢复自己的滚动位置，与我们的 `scrollTop` 赋值打架，表现为"停在奇怪的地方"。必须显式关掉。

**页面被回收后必须能重建**（手机上这是常态）：

```
visibilitychange → 重新可见
  → 若内存态已丢失（APP 状态为空）→ 重走完整恢复流程
  → 若内存态存在 → 只做一次位置校验（比对期望 scrollTop 与实际，差 > 1 屏则重设）
```

原则：**永远可以从 IndexedDB 冷启动恢复**，不假设内存里还有东西。这条让"切到微信回消息再回来"不会丢位置。

**误差界**：一章 3000 字、手机视口约 500 字/屏 ≈ 200 行，像素比例误差为半行量级，即 **< 0.3%**，优于验收要求的 1%。短章（不满一屏）`max === 0`，直接归零。

**v0.2 升级路径**（留口不做）：把 `chapterPercent` 升级为**字符锚点**——二分 + `Range.getBoundingClientRect()` 求视口顶部对应字符偏移，存 `{chapterIndex, charOffset}`。完全不受字号/字体/窗口影响，代价约 40 行 + 每次约 10 次布局测量。手机上"旋转屏幕"是高频操作，这个升级的价值比桌面大，但没有必要在一期付这个成本。

### KD-9 设置走 localStorage，不走 IndexedDB

**理由**：主题必须在**首帧前**决定，否则暗色用户每次冷启动都看到一次白屏闪烁。手机上这个闪烁尤其刺眼（整屏白闪）。

```html
<!-- index.html <head> 内联，早于样式表 -->
<script>
  document.documentElement.dataset.theme =
    localStorage.getItem('txt-reader:theme') || 'light'
</script>
```

`localStorage` 是同步 API，早于首帧；`indexedDB` 是异步的，等它返回时首帧已经画完。

**存储分工**：`localStorage` 只放三个小设置（字体、行距、主题），总计 < 100 字节；书籍与进度一律 IndexedDB。

**注意**：`localStorage` 同样会被 Safari 的 ITP 清理（见 KD-11）。设置丢了不影响阅读，只影响观感，所以接受这个风险；进度丢了才是事故。

### KD-10 零依赖是硬约束

任何"加个小库更快"的念头，先对照：

| 想引入 | 本项目的替代 | 代价 |
|---|---|---|
| idb / Dexie | 手写 40 行 promise 包装 | 半天 |
| iconv-lite | `TextDecoder`（原生 gb18030） | 0 |
| Vite | 无（原生 ESM） | 0 |
| React | 原生 DOM，只有 2 个视图 | 更少 |
| Workbox | 手写 60 行 `sw.js` | 半天 |

手机为主要额外警惕：**包里每 100KB 都是在 4G 下多等的时间**。零依赖在这里从"洁癖"变成"交付质量"。

### KD-11 存储可靠性：持久化申请 + 进度备份（手机命门）

这是手机为主要引入的**最高风险项**，桌面完全不存在。

**事实**：Safari 的 ITP 策略会清理长期未被访问站点的脚本可写存储（含 localStorage 与 IndexedDB）。用户出差两周回来，书架和进度可能都没了。安卓 Chrome 的策略宽松些，但在存储压力下仍会清理非持久化站点的数据。

**三道防线，按可靠性排序**：

| 防线 | 手段 | 可靠性 |
|---|---|---|
| 1 | `navigator.storage.persist()` 申请持久化 | 中。Chrome 常授予（尤其 PWA 安装后），Safari 支持有限且常返回 `false` |
| 2 | 引导"添加到主屏幕"，以 standalone 模式使用 | 中高。已安装的 Web App 不被 ITP 按未访问站点清理 |
| 3 | **进度与书单的导出/导入**（JSON 文件） | **高。唯一可预期的兜底** |

**决策**：三道全做。

- 启动时静默调用 `navigator.storage.persist()`，失败不打扰用户
- 首次进入书架时，一次性提示"安装到主屏幕可离线阅读、数据更稳"（可关闭，不再提示）
- **设置页提供"导出备份 / 导入备份"**，导出内容为：

```js
{
  version: 1,
  exportedAt: 1761415200000,
  books: [ { id, title, charCount, chapterCount, addedAt, lastReadAt } ],  // 不含正文
  progress: [ { bookId, chapterIndex, chapterPercent, updatedAt } ],
  settings: { fontSize, lineHeight, theme }
}
```

约 3KB。手机用户可存到文件 App 或发给自己。

**为什么不备份正文**：20MB × N 本无法塞进一个 JSON，且正文可以重新导入。备份的目标是**保住"读到哪儿"**，这才是用户感知的损失。

**导入逻辑**：按 `id` 合并。若本地已有同 `id` 的书，只恢复 `progress`（取 `updatedAt` 较新者）；若本地没有该书，写入一条 `missing: true` 的占位记录，提示"《XX》的进度已恢复，请重新导入原文件"。这个占位设计让"换手机后恢复进度"成为可能。

**配额处理**：导入写入时捕获 `QuotaExceededError`，明确提示"存储空间不足，请删除旧书或清理浏览器数据"，并给出当前占用（`navigator.storage.estimate()`）。

### KD-12 手机导入路径：不要依赖 `accept`

**事实**：`.txt` 在不同系统/来源下 MIME 不稳定，常为空串或 `application/octet-stream`。用 `accept=".txt,text/plain"` 过滤，在部分安卓机型上会让目标文件变灰不可选。

**决策**：

- `<input type="file">` **不加 `accept`**（或只写 `accept="*/*"`），导入后靠扩展名 + 内容探测双重判断
- 大小上限仍为 50MB，超限即在选中瞬间拒绝（读之前先看 `file.size`，不要先读后拒）
- 文件名兜底：`file.name` 有时带路径或为空 → 取 `lastIndexOf('\\'/'/')` 之后，空则用"未命名"
- 空文件（`size === 0`）直接拒绝，提示"文件为空"

**手机用户的真实导入路径**（决定了引导文案）：

| 来源 | 用户动作 |
|---|---|
| 微信/QQ 收到 txt | 「用其他应用打开」→ 存到「文件」App → 在阅读器里选择 |
| 网盘下载 | 下载到本地 → 文件 App → 选择 |
| 电脑传来的 | AirDrop / 数据线存到文件 App → 选择 |

**v0.2 可选项**：声明 `share_target`（Android Chrome 支持接收分享文件，iOS Safari 不支持），让用户能从微信直接"分享到"阅读器。一期不做。

### KD-13 字体与排版：安卓没有中文衬线

**事实**：产品文档定的字体栈 `Songti SC / SimSun / serif` 是桌面思维。iOS 有 Songti SC，没问题；但**绝大多数安卓机没有中文衬线字体**，`serif` 对中文会静默回退到系统默认的思源黑体（Noto Sans CJK）。结果：同一份设计在安卓上永远是黑体。

**决策**：接受回退，但让回退**好看**。

```css
--font-read: "Songti SC", "STSong", "Noto Serif CJK SC",
             "Source Han Serif SC", "SimSun", serif;
```

- iOS：命中 Songti SC，得到真正的衬线阅读感
- 安卓：多数机型落到 Noto Sans CJK（黑体），排版参数需为黑体调优
- 部分三星/小米机型带 Noto Serif CJK，能命中

**不内嵌字体**：思源宋体子集化后仍有几百 KB 到数 MB，且中文字形覆盖要求高、子集化易漏字。这与"打开即读、零依赖"直接冲突，收益（衬线感）不抵成本。字体选择列入 v0.3。

**排版参数（手机基准）**：

| 参数 | 值 | 理由 |
|---|---|---|
| 正文字号 | 18px 默认，可调 14–28px | 手机单手阅读舒适区 |
| 行高 | 1.8 默认，可调 1.4–2.2 | 中文密排需要更大行距 |
| 段间距 | `0.6em`（不额外加空行） | 避免黑体下视觉过散 |
| 左右内边距 | `1.2em`（`env(safe-area-inset-*)` 叠加） | 容错刘海屏 |
| 每行字数 | 目标 22–30 字/行 | 超出则加内边距 |
| 首行缩进 | `2em`，由 CSS 统一接管 | 剥离原文全角缩进后接管 |

**视口与安全区**：

```html
<meta name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover">
```

```css
html { height: 100dvh; }
@supports not (height: 100dvh) { html { height: 100vh; } }
body { padding-bottom: env(safe-area-inset-bottom); }
```

`dvh` 而非 `vh`：`100vh` 在 iOS 上含被地址栏遮挡的部分，会导致底部一截文字永远看不到。

### KD-14 全相对路径：GitHub Pages 项目站点的唯一正确解

**事实**：GitHub Pages 有两种站点形态。

| 形态 | URL | 路径前缀 |
|---|---|---|
| 用户站 | `https://[GITHUB_USER].github.io/` | `/` |
| 项目站 | `https://[GITHUB_USER].github.io/[REPO]/` | `/[REPO]/` |

免费账号只有一个用户站名额，其余仓库都是项目站。**默认情况下站点带一个 URL 子路径前缀**——这是零构建项目最容易踩死的地方，而且一旦写错，本地开发一切正常、线上直接白屏。

| 写法 | 本地 `localhost:8080` | 项目站点 | 结果 |
|---|---|---|---|
| `<script src="/src/main.js">` | ✓ | ✗ 404 | **线上白屏** |
| `<script src="./src/main.js">` | ✓ | ✓ | 正确 |
| manifest `"start_url": "/"` | ✓ | ✗ | 装到主屏后点开跳出浏览器 |
| manifest `"start_url": "./"` | ✓ | ✓ | 正确 |

**决策（写成纪律，进 code review checklist）**：

1. HTML 中所有资源引用一律 `./` 开头，**禁止** `/` 开头
2. ES module `import` 一律相对路径（天然满足，不要写绝对 URL）
3. manifest 的 `start_url` 与 `scope` 一律 `"./"`
4. SW 注册：`navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })`
5. SW 内部 `cache.addAll()` 使用相对 URL（相对 sw.js 解析，规范保证）
6. 不写任何硬编码域名的绝对 URL

**这条纪律的额外收益**：同一套文件在 `localhost:8080`、`[USER].github.io/[REPO]/`、自定义域名、以及将来若迁往 Cloudflare Pages 时**全部零改动可用**。可移植性是顺手拿到的。

**GitHub Pages 的能力边界**（设计时就要知道，别到实现才发现）：

| 能力 | 是否支持 | 影响 |
|---|---|---|
| 自定义响应头 | ✗ 无 `_headers` / `_redirects` | 无法设 `Cache-Control`、CSP、`X-Frame-Options` |
| 服务端重定向 | ✗（只有 `.html` 的隐式扩展名） | 路由必须用 hash（本方案已是 hash 路由） |
| 构建定制 | 仅 Jekyll 或 Actions | 用 `.nojekyll` 关掉 Jekyll |
| 发布目录 | 仅分支根目录或 `/docs` | `/docs` 已被设计文档占用，故用根目录 |
| SW scope 放宽 | ✗（需 `Service-Worker-Allowed` 头） | 本项目不需要 |

**关于 CSP**：无法用响应头设置，只能用 `<meta http-equiv="Content-Security-Policy">`（能力受限，且不支持 `frame-ancestors`）。本项目零外部资源，收益极低，v0.1 不设。

### KD-15 Service Worker 缓存版本策略

**目标**：既要"改了就生效"，又绝不能出现"新 HTML + 旧 JS"的混搭。

**清单外置**：预缓存列表放在 `assets.manifest.json`，而不是内联在 `sw.js` 里。这样 `node --test` 能直接读它验证每个路径存在——零构建下没有打包器替我们检查漏文件，必须自己补这道防线。

```json
{
  "version": "2026-10-25.1",
  "files": [
    "./",
    "./index.html",
    "./manifest.webmanifest",
    "./styles/app.css",
    "./styles/themes.css",
    "./src/main.js",
    "./src/decode.js",
    "./src/normalize.js",
    "./src/chapters.js",
    "./src/position.js",
    "./src/backup.js",
    "./src/store.js",
    "./src/ingest.js",
    "./src/ingest.worker.js",
    "./src/bookshelf.js",
    "./src/reader.js",
    "./src/settings.js",
    "./src/ui.js",
    "./icons/icon.svg"
  ]
}
```

**install：一次装齐，装不全就不装**

```js
const MANIFEST_URL = './assets.manifest.json'

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // cache: 'no-store' 必须加：否则会拿到 Pages CDN 上的旧清单（max-age=600）
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' })
    const { version, files } = await res.json()
    const cache = await caches.open(`txt-reader-${version}`)
    await cache.addAll(files)   // 原子操作：任一文件失败则整体失败
    await self.skipWaiting()
  })())
})
```

`addAll` 的原子性在这里是**保护**而非风险：宁可安装失败保留旧版本可用，也不要装出一个缺文件的半套缓存。

**activate：删旧版本，但离线时宁可不删**

```js
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    let keep = null
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-store' })
      keep = `txt-reader-${(await res.json()).version}`
    } catch { /* 离线，无法判定当前版本 */ }

    if (keep) {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.startsWith('txt-reader-') && n !== keep)
          .map((n) => caches.delete(n))
      )
    }
    await self.clients.claim()
  })())
})
```

判定不了当前版本时**保留所有缓存**——多占几十 KB，好过删错导致离线不可用。

**fetch：cache-first，且刻意不回填**

```js
self.addEventListener('fetch', (e) => {
  const { request } = e
  if (request.method !== 'GET') return
  if (new URL(request.url).origin !== self.location.origin) return

  e.respondWith((async () => {
    // 离线冷启动：导航请求回退到缓存的 index.html
    if (request.mode === 'navigate') {
      const shell = await caches.match('./', { ignoreSearch: true })
      if (shell) return shell
    }
    const hit = await caches.match(request, { ignoreSearch: true })
    return hit || fetch(request)
  })())
})
```

**为什么不回填**：若把网络取回的新文件写进当前缓存，缓存里会混进下一代文件，下次版本迭代时出现"半新半旧"的诡异状态。宁可多走一次网络，也不污染缓存。代价可忽略——app shell 总共不到 100KB。

**更新提示：不自动 reload**

```js
navigator.serviceWorker.addEventListener('controllerchange', () => {
  showToast('已更新，重新打开后生效')
})
```

自动 reload 会打断阅读，且要重走一遍位置恢复。提示 + 让用户自己选择时机更合适。冷启动时本来就是新版本，这条只影响"本次会话中途收到更新"的场景。

**版本号纪律：本项目唯一的人肉环节**

> 改任何 app shell 文件 → **必须**递增 `assets.manifest.json` 的 `version` → 才推送。

防御措施（三道）：

1. `node --test` 校验 `files` 全部真实存在（漏文件立刻红）
2. 校验 `index.html` 无 `/` 开头的资源引用（守 KD-14）
3. 发布清单含"版本号是否递增"检查项；手机验收清单含"改一行文案 → 更新后手机端确实生效"用例

**诚实说明**：零构建下这件事无法完全自动化。如果哪天觉得人肉不可靠，最小的补救是加 `scripts/release.mjs`（仅用 node 内置模块，仍零依赖）自动递增 version 并提交——但不要为了这个引入打包器。

---

## 5. 接口契约

### 5.1 `BookRepository`

```js
/**
 * 所有方法返回 Promise。实现可以是 IndexedDB、内存（降级）、
 * 或未来的按章分片存储。调用方不得假设实现细节。
 */
export const BookRepository = {
  listBooks():                      Promise<BookMeta[]>   // 绝不含 text
  getBookMeta(id):                  Promise<BookMeta | null>
  getChapterText(id, chapterIndex): Promise<string>       // 章级读（KD-3）

  putBook(meta, text):              Promise<void>         // worker 内调用
  getProgress(id):                  Promise<Progress | null>
  putProgress(progress):            Promise<void>
  deleteBook(id):                   Promise<void>         // 必须级联
}
```

`deleteBook` 必须在**同一个 transaction** 内删 `books`、`texts`、`progress` 三个 store——对应验收标准"删除书本后进度记录同步清除"。

### 5.2 数据模型

```js
// store: books  (keyPath: "id")  —— 不含 text
{
  id: "uuid",
  title: "斗破苍穹",
  charCount: 8123456,
  byteSize: 20971520,
  encoding: "gb18030",
  encodingConfidence: "high",       // high | low
  autoSplit: false,                 // true = 走了 8000 字兜底
  chapterCount: 812,
  addedAt: 1761328800000,
  lastReadAt: 1761415200000,
  missing: false,                   // true = 仅从备份恢复的进度占位（KD-11）
  chapters: [ { index, title, offset, length } ]
}

// store: texts   (keyPath: "bookId")
{ bookId: "uuid", text: "…" }

// store: progress (keyPath: "bookId")
{ bookId: "uuid", chapterIndex: 29, chapterPercent: 0.47, updatedAt: 1761415200000 }

// localStorage
txt-reader:fontSize   = "18"
txt-reader:lineHeight = "1.8"
txt-reader:theme      = "sepia"
txt-reader:hintShown  = "1"        // 安装引导已展示过
```

### 5.3 编码探测契约

```js
/**
 * @param {ArrayBuffer} buffer
 * @returns {{ text, encoding, confidence: 'high'|'low', reasons: string[] }}
 */
export function decode(buffer)
```

**探测顺序**（不可调）：

| 序 | 判据 | 结果 |
|---|---|---|
| 1 | `EF BB BF` | `utf-8`，剥离 BOM，`high` |
| 2 | `FF FE` | `utf-16le`，剥离 BOM，`high` |
| 3 | `FE FF` | `utf-16be`，剥离 BOM，`high` |
| 4 | `utf-8` + `fatal: true` 成功 | `utf-8`，`high` |
| 5 | 回退 `gb18030` | 见下方打分 |

**关于"两种都失败"**：这是产品文档第 6 节的**假失败路径**。`gb18030` 是全覆盖编码，几乎任何字节序列都能解码成功。真正的风险是**静默解错**——用 GB18030 去解 UTF-16LE 文件，会得到满屏无意义汉字且不报错。手机上用户没有开发者工具，只会认为"这个 App 是坏的"。

**因此改为置信度打分**。对解码结果抽样（首/中/尾各 4KB），计算：

| 特征 | 期望 | 权重 |
|---|---|---|
| CJK 统一表意区（U+4E00–U+9FFF）占比 | > 40% | 正向 |
| 常用汉字高频集命中率（约 500 字表） | 越高越好 | 正向 |
| U+FFFD 替换符 | = 0 | 出现即 `low` |
| 控制字符（除 `\t\n\r`） | = 0 | 出现即 `low` |
| 私用区 / CJK 扩展 B+ | 越少越好 | 负向 |

低于阈值 → `confidence: 'low'`，书架条目显示"编码可能识别有误"，阅读页提供手动切换（`utf-8` / `gb18030` / `utf-16le`）。切换后**重新切章并更新 offsets**（坐标系统变了）。

**这个手动切换入口 v0.1 就要有**，成本约 30 行，是编码问题唯一的真实兜底。

### 5.4 章级归一化契约

```js
export function normalizeChapter(rawText): { paragraphs: string[], isBlank: boolean }
```

规则（v0.1）：

1. `\r\n` / `\r` → `\n`
2. 按空行密度自适应分段：空行率 > 30% → 按空行分段；否则按行分段
3. 剥离行首全角/半角缩进，交由 CSS `text-indent` 接管
4. 过滤广告行：命中 `本章未完|请收藏|www\.|http[s]?://|最新网址|手机阅读` 等模式，且**行长 < 80 字符**（避免误杀正文）
5. 压缩连续空行为单段分隔
6. 章首标题行若与 `chapters[i].title` 相似度 > 0.8，从正文剔除，避免重复显示

第 6 条容易漏：`offset` 通常从标题行开始，直接渲染会让正文第一行是标题的重复。

---

## 6. 性能预算（分档）

手机为主的预算不能只写桌面数字。基准设备明确定义，否则无法验收。

| 指标 | 桌面 | 中端手机（验收档） | 测量方式 |
|---|---|---|---|
| 20MB / GB18030 导入 | < 3000ms | **< 6000ms** | `performance.now()` 三段打点，worker 回传 |
| 单章渲染（DOM 重建 + reflow） | < 100ms | < 200ms | 渲染前后打点 |
| 打开书到首屏可见 | < 500ms | **< 800ms**（触发 KD-3 切换条件） | 点击 → 首个 `rAF` 后可见 |
| 滚动帧率 | ≥ 50fps | ≥ 45fps，无 > 200ms 长任务 | `PerformanceObserver({entryTypes:['longtask']})` |
| 书架打开（10 本 20MB 书） | < 300ms | < 600ms | 只读 `books`，不读 `texts` |
| 常驻内存（打开一本 20MB 书） | < 250MB | < 200MB | DevTools Memory / `measureUserAgentSpecificMemory()` |
| 改字号后位置漂移 | < 1% 章长 | < 1% 章长 | 验收脚本 |
| 冷启动到书架可交互（PWA） | < 800ms | < 1500ms | SW 缓存命中后 |

**基准设备**：

- 中端安卓：骁龙 6 Gen 1 / 8GB RAM 级别（2024 年级别机型）
- iOS：iPhone 12 及以上；iPhone SE 3 作为小屏下限

**已知风险**：`content-visibility: auto` 在旧版 Safari 上可能影响 `scrollHeight` 的即时准确性。若恢复位置时 `scrollHeight` 明显偏小，在恢复时序里加一次强制布局读取，或对分段禁用该属性。

---

## 7. 测试策略

### 7.1 单元测试（`node --test`，必须全绿）

| 文件 | 覆盖点 |
|---|---|
| `decode.test.js` | UTF-8 BOM / 无 BOM UTF-8 / GB18030 / UTF-16LE BOM / UTF-16BE BOM / 纯 ASCII / 非法 UTF-8 触发回退 / 空文件 / 仅 BOM / 低置信度样本（UTF-16LE 无 BOM 误判为 GB18030） |
| `normalize.test.js` | CRLF / CR / 每行一段 / 空行分段 / 全角缩进剥离 / 广告行过滤且不误杀长正文 / 章首标题去重 / 纯空白章 |
| `chapters.test.js` | `第一章` / `第1章` / `第001章` / `第一回` / `第1节` / `序章` / `楔子` / `番外` / 卷标题 / **正文引用"第三章"不得误匹配** / 无章节兜底 8000 字 / 超长单行 / 空章 / 全半角空格 |
| `position.test.js` | `toPercent`/`toScrollTop` 往返 / `max === 0` 归零 / 越界 clamp / 0 与 1 边界 |
| `backup.test.js` | 导出结构完整性 / 导入按 id 合并 / 同 id 取 `updatedAt` 较新者 / 无对应书时写 `missing: true` 占位 / 版本号不匹配时拒绝 / 缺失 `progress` 字段容错 |
| `ingest.test.js` | 管线端到端（fixture ArrayBuffer，断言 meta 与 chapters 结构；存储用内存桩替换 IndexedDB） |
| `assets.test.js` | `assets.manifest.json` 的 `files` 每项在仓库内真实存在；`version` 非空且格式合法；`index.html` 不含 `/` 开头的 `src`/`href` 引用（守 KD-14）；`manifest.webmanifest` 的 `start_url`/`scope` 为 `"./"` |

**环境断言（必须显式写一条）**：

```js
// test/decode.test.js 首个用例
test('runtime supports gb18030 decoder', () => {
  assert.doesNotThrow(() => new TextDecoder('gb18030'))
})
```

`TextDecoder('gb18030')` 依赖 ICU 完整数据。Node 官方预编译包默认带 full-ICU，但 small-ICU 构建会直接抛 `RangeError`。这条断言在 CI 环境不对时**立刻**给出准确报错，而不是让所有中文用例莫名失败。

### 7.2 手机验收清单（编号执行，逐条勾）

**核心路径**

- [ ] 20MB GB18030 小说导入，中端安卓 < 6s，中文无乱码，章节数正确
- [ ] 读到第 30 章 → 完全关闭 PWA → 重开 → 回到原位置，误差 < 1%
- [ ] 改字号到最大 → 重开 → 仍在原位置
- [ ] 连续滚过 10 个章边界 → 无跳屏、无白屏、手滑过程中无"被拽回"

**手机特有（必须逐项测，最容易漏）**

- [ ] **地址栏收缩/展开**时位置不跳
- [ ] **横竖屏旋转**后位置不跳（按比例保持）
- [ ] **切到微信 5 分钟再回来** → 位置保持（验证页面被回收后能从 IndexedDB 重建）
- [ ] **惯性滑动中途跨越章边界** → promote 延后到静止，无内容回弹
- [ ] 点击左/右/中央三区行为正确，滚动时不误触发
- [ ] 刘海屏 / 底部指示条不遮挡正文
- [ ] 飞行模式下从主屏图标冷启动 → 书架可见、已读的书可继续读
- [ ] 三主题切换即时生效，无白闪

**可靠性**

- [ ] 导出备份 → 清除站点数据 → 重新导入 → 进度恢复
- [ ] 导出备份后删除原书，再导入备份 → 出现"请重新导入原文件"占位提示
- [ ] Safari 无痕模式（IndexedDB 受严格限制）→ 降级内存模式且有明确提示
- [ ] 删除书本 → 刷新 → 进度记录确实消失
- [ ] 存储接近配额时导入 → 明确提示，不静默失败

**编码**

- [ ] 无 BOM 的 UTF-16LE 文件 → 提示"编码可能识别有误"，手动切换后正常

---

## 8. 运行与交付（GitHub Pages）

```bash
# 本地开发（仅调试用，禁止用来判断线上行为）
python -m http.server 8080

# 测试
node --test
```

**交付物**：仓库根目录即产物。无 build 步骤、无 `node_modules` 运行期依赖、无 CI 构建配置。

**托管**：GitHub Pages，仓库根目录（branch deploy）。完整操作步骤、验证清单、故障排查见 [deploy-github-pages.md](./deploy-github-pages.md)，此处只记方案层面的定版结论：

| 项 | 定版 | 依据 |
|---|---|---|
| 站点形态 | 项目站点 `https://[GITHUB_USER].github.io/[REPO]/` | 免费账号仅一个用户站名额 |
| 路径策略 | 全相对路径，零绝对引用 | KD-14；同时使迁移零成本 |
| Jekyll | `.nojekyll` 关闭 | 纯静态，不需要站点生成 |
| 路由 | hash（`#/shelf`、`#/read/:id`） | Pages 无服务端重写能力 |
| 首屏资源 | SW 预缓存 app shell | 离线冷启动 + 弱网可用 |
| 首次引导 | 手机浏览器打开 → 添加到主屏幕 | iOS 只能经 Safari 安装 |

**发布流程**（四条，顺序不可换）：

```
1. 改代码
2. 递增 assets.manifest.json 的 version
3. node --test 全绿
4. git push → 等 Pages 发布（约 1 分钟）→ 手机端验证
```

第 2 步是本项目唯一的人肉环节，理由与防御见 KD-15。

**关于 GitHub Pages 的 CDN 缓存**：静态资源响应带 `Cache-Control: max-age=600`，意味着推送后**最多 10 分钟内可能仍返回旧文件**。因此：

- 推送后立刻验证**没有意义**，等 10 分钟或换个无痕窗口
- SW 的 manifest 与 sw.js 请求都带 `cache: 'no-store'` / `updateViaCache: 'none'`，绕开这层缓存
- 不存在"设 `immutable` 长缓存"的可能（Pages 不支持自定义头），所以也不会有 stale-while-revalidate 的复杂度

---

## 9. 实施里程碑

按"每个里程碑结束都能在手机上看到东西"排序。

| 里程碑 | 内容 | 完成判据 |
|---|---|---|
| **M1** 地基 | `decode` / `normalize` / `chapters` / `position` / `backup` 五模块 + 全部单测 | `node --test` 全绿，覆盖 §7.1 所有用例 |
| **M2** 存储 | `store.js`（三 store + 事务 + 级联删除）+ 内存降级桩 + 配额错误处理 | 内存桩单测过；手测可写入并读回 20MB 文本 |
| **M3** 阅读 | `reader.js` 三段窗口 + 哨兵换章 + 滚动锚定 + 触摸手势 + 位置恢复 | 手机验收清单"核心路径" 4 条 + 地址栏/旋转 2 条通过 |
| **M4** 管线 | `ingest.worker.js` + `ingest.js`，导入全流程走 worker，进度与取消 | 20MB 导入中端安卓 < 6s；无 worker 时降级可用 |
| **M5** 手机化交付 | 书架、设置 sheet、主题、PWA（manifest + sw + 安装引导）、备份导出/导入 | 手机验收清单全通过；性能预算逐项打点确认 |

**M1 可完全独立于 UI 完成并验收**——把切章、编码这两个最易出错的模块，在还没有一行 DOM 代码时就钉死。这是唯一能降低后期返工的安排。

**M3 结束时必须做一次真机基准测试**，作为 KD-3 是否切换到按章分片存储的判据（阈值：打开书到首屏 > 800ms）。

---

## 10. 未来换壳的边界（当前不做）

目标形态是手机为主，PWA 已覆盖需求，**桌面壳不是待办，是不需要**。但结构上留好了口子：

| 层 | v0.1 | 若哪天要桌面（Tauri） | 调用方要改吗 |
|---|---|---|---|
| `decode`/`normalize`/`chapters`/`position`/`backup` | 原生 ESM | 可原样保留 | 否（纯函数契约不变） |
| `reader`/`bookshelf`/`settings` | 原生 DOM | 原样保留 | 否 |
| `BookRepository` | IndexedDB | 换 SQLite 实现 | **否**（KD-3 的目的） |
| `ingest` | Web Worker | 换 Rust 流式处理 | 否（接口不变） |
| 大文本过 IPC | 不存在（同进程） | 必须按章拉取，**不可整本传** | 取决于实现 |

**给未来的自己留一句警告**：Tauri 的 IPC 是 JSON 序列化。把 20MB 字符串整本从 Rust 传给前端，光序列化就吃掉几百毫秒到 1 秒，直接击穿导入预算。IPC 边界**必须**按章设计。

---

## 11. 风险登记

按"手机为主"重新排序，前三条是这版新增的。

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| **Safari ITP 清理本地存储** | 高 | 书架与进度全丢，核心主张破产 | 三道防线：persist 申请 / 安装 PWA / 备份导出（KD-11） |
| **页面被后台回收** | 高 | 回来位置丢失或白屏 | 冷启动恢复时序 + `visibilitychange` 校验（KD-8） |
| **地址栏 / 旋转变更视口** | 高 | 位置漂移、底部文字被遮 | `dvh` + 容器 `clientHeight` + `scrollRestoration='manual'`（KD-8、KD-13） |
| 章节正则误报（正文引用被当标题） | 中 | 假章、进度错乱 | 行首锚定 + 固定单测用例（KD-5） |
| 章节正则漏报（罕见格式） | 中 | 目录为空 | 8000 字兜底 + `autoSplit` 标记 |
| 编码静默解错 | 中 | 满屏乱码，用户判定"App 是坏的" | 置信度打分 + 手动切换（§5.3） |
| iOS 惯性滚动与 promote 打架 | 中 | 内容回弹，手感极差 | 静止后才 promote（KD-7） |
| 安卓无中文衬线 | 高 | 设计感损失（非功能缺陷） | 接受黑体回退，排版参数为其调优（KD-13） |
| `content-visibility` 致 `scrollHeight` 不准 | 中 | 恢复位置偏移 | 强制布局读取；必要时按段禁用 |
| 存储配额耗尽 | 中 | 导入失败 | `QuotaExceededError` 捕获 + 占用展示 |
| 低端机 20MB 全文驻留 | 中 | 内存压力 | KD-3 的 benchmark gate，接口已留分片路径 |
| GitHub Pages 国内访问不稳定 | 中 | 移动网络下首屏慢或偶发失败 | 全相对路径使迁移 Cloudflare Pages 为零改动（KD-14）；上线后实测一次再决定 |
| PWA 更新不生效（旧缓存） | 中 | 用户用着旧版以为是新 bug | `version` 递增纪律 + `addAll` 原子安装 + `controllerchange` 提示（KD-15） |
| 项目站点路径前缀导致线上白屏 | 中 | 本地正常、线上全挂 | 全相对路径纪律 + `assets.test.js` 自动校验（KD-14） |

---

## 12. 与产品设计文档的变更记录

| # | 产品文档原文 | 本方案 | 理由 |
|---|---|---|---|
| 1 | 设计原则 4："`index.html` + ES modules，浏览器直接跑" | 澄清为"零构建，非零部署"：HTTPS 托管 + PWA | 手机无法起本地服务；`file://` 下 module 被拦、IndexedDB 被禁（KD-1） |
| 2 | 数据模型：`text` 在 `books` 记录内 | 拆出独立 `texts` store | `listBooks()` 会把所有全文读进内存，低端机触发页面回收（KD-2） |
| 3 | 数据模型：`settings` 存 IndexedDB | 改 localStorage | 主题需首帧前同步应用，否则每次冷启动白闪（KD-9） |
| 4 | 第 6 节失败路径："编码两种都失败" | 改为置信度打分 + 手动切换编码 | gb18030 全覆盖，该路径走不到；真风险是静默解错（§5.3） |
| 5 | 4.1 节"阅读：只渲染当前章" | 三段式窗口（上章尾/本章/下章头） | 手机一屏约 500 字，纯按章替换每 6 屏断流一次（KD-7） |
| 6 | 8 节：无 Worker 提及 | 导入管线 Worker 化，worker 直写 IndexedDB | 中端机主线程占 2s 会让用户返回桌面，导入白做（KD-6） |
| 7 | 8 节：`normalize` 作为全文处理步骤 | 降为章级延迟处理，offsets 基于原始文本 | 800 万字多次 replace 瞬时 80MB，手机直接被 kill（KD-4） |
| 8 | 9 节：v0.5 才做 PWA | **PWA 提到 v0.1** | 手机为主时，非 PWA 体验有地址栏遮挡、启动路径长、后台更易回收（KD-1） |
| 9 | 4.1 节：快捷键 `←/→/Esc/+/-` | 手机改触摸分区（左/右/中三区），快捷键仅桌面 | 手机没有键盘（KD-7） |
| 10 | 4.1 节："侧栏章节列表" | 手机改全屏抽屉 | 手机屏宽不足以容纳侧栏（KD-7） |
| 11 | 11 节：字体栈 `Songti SC / SimSun / serif` | 补充 Noto Serif CJK / Source Han Serif，并接受安卓黑体回退 | 安卓基本无中文衬线，原栈会静默回退（KD-13） |
| 12 | 无"数据备份"相关设计 | 新增进度/书单导出导入（KD-11） | Safari ITP 会清理长期未访问站点存储，无备份即数据丢失 |
| 13 | 4.1 节：导入"选择本地 .txt 文件" | 明确不依赖 `accept`，靠扩展名 + 内容探测 | `.txt` MIME 不稳定，安卓部分机型会禁用可选文件（KD-12） |

---

## 13. 待评审项

托管已定（GitHub Pages），形态已定（手机为主）。剩下的都是实现细节，可在 M1–M3 期间再定，不阻塞开工：

1. **仓库名**：决定 URL 前缀。建议短且语义明（如 `txtreader`），因为手机上要输一次这个地址才装得上 PWA。若想彻底摆脱前缀，可建用户站 `[GITHUB_USER].github.io`，但那样一个账号只能有一个站点。
2. **触摸交互方案确认**：本方案取「左/右 1/4 切章 + 中央切工具条」。备选是「底部固定悬浮按钮」——前者不遮挡正文、接近主流阅读器习惯，但有误触可能；后者明确但占屏。
3. **`chapterPercent` 是否直接上字符锚点**：手机旋屏是高频操作，字符锚点在这一点明显更稳。像素比例已满足 < 1% 验收，若转屏后手感可感知，建议提前到 v0.1.1。
4. **PWA 图标**：零依赖下不内嵌字体，图标建议用极简字形（单色底 + 一笔白色竖线或首字）以 SVG 出图，另备 180×180 PNG 供 iOS 的 `apple-touch-icon`。M5 前生成即可。
