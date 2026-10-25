# GitHub Pages 部署手册

> 配套：[technical-design.md](./technical-design.md) 第 8 节、KD-14、KD-15
> 适用：纯静态站点，零构建，手机为主的 PWA
> 占位符：`[GITHUB_USER]` 你的 GitHub 用户名，`[REPO]` 仓库名

---

## 1. 交付后的最终形态

```
https://[GITHUB_USER].github.io/[REPO]/
  ├─ 手机 Safari / Chrome 打开 → 可读
  ├─ 添加到主屏幕 → 独立图标启动、离线可用、无地址栏
  └─ HTTPS 由 github.io 域名自带，无需配置证书
```

**注意 URL 带 `/[REPO]/` 前缀**（项目站点）。这一个事实决定了全站必须用相对路径，见第 3 节。

---

## 2. 一次性配置

### 2.1 仓库要求

| 项 | 要求 |
|---|---|
| 可见性 | **public 最省事**。private 仓库发布 Pages 需要 Pro 或更高套餐 |
| 默认分支 | `main` |
| 发布目录 | 根目录 `/`（`/docs` 已被设计文档占用） |

### 2.2 推送代码

```powershell
git init
git branch -M main
git add .
git commit -m "chore: 初始化阅读器项目"
git remote add origin https://github.com/[GITHUB_USER]/[REPO].git
git push -u origin main
```

### 2.3 关闭 Jekyll

GitHub Pages 默认会跑一遍 Jekyll。本项目是纯静态，跳过它可以消除一类"文件被忽略/构建延迟"的问题。

```powershell
New-Item -ItemType File -Name .nojekyll -Force
git add .nojekyll
git commit -m "chore: 关闭 Jekyll 处理"
git push
```

`.nojekyll` 是**空文件**，内容为零字节，名字以点开头。

### 2.4 开启 Pages

仓库页面 → **Settings** → 左侧 **Pages**：

| 字段 | 值 |
|---|---|
| Source | `Deploy from a branch` |
| Branch | `main` |
| Folder | `/ (root)` |
| Save | 点击 |

等 1–2 分钟，页面顶部会出现站点地址。首次发布完成后访问：

```
https://[GITHUB_USER].github.io/[REPO]/
```

**如果出现 404**：确认步骤 2.3 的 `.nojekyll` 已推送、分支名与 Folder 选择正确、仓库是 public（或套餐支持）。

### 2.5 确认 HTTPS

`*.github.io` 域名默认启用 HTTPS，通常无需操作。若 Pages 设置页出现 **Enforce HTTPS** 复选框且可勾选，勾上。

---

## 3. 路径纪律（最重要的一节）

项目站点带 `/[REPO]/` 前缀。**绝对路径在本地正常、线上必挂**，而且症状是白屏，很难一眼看出原因。

### 3.1 硬规则

```html
<!-- 对 -->
<script type="module" src="./src/main.js"></script>
<link rel="stylesheet" href="./styles/app.css">
<link rel="manifest" href="./manifest.webmanifest">

<!-- 错（本地 OK，线上 404） -->
<script type="module" src="/src/main.js"></script>
```

```js
// 对：ES module 一律相对
import { decode } from './decode.js'

// 错：绝对 URL
import { decode } from '/src/decode.js'
```

```json
// manifest：start_url 与 scope 必须是 "./"
{ "start_url": "./", "scope": "./" }
```

```js
// SW 注册：相对路径 + 绕开 HTTP 缓存
navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
```

```js
// SW 内部：addAll 用相对 URL（相对 sw.js 解析）
await cache.addAll(['./', './index.html', './styles/app.css'])
```

### 3.2 自动化守卫

`test/assets.test.js` 必须拦住这三类错误，否则靠人眼迟早漏：

| 检查 | 断言 |
|---|---|
| 漏文件 | `assets.manifest.json` 的 `files` 每一项在仓库内存在 |
| 绝对路径 | `index.html` 中不存在 `src="/` 或 `href="/` |
| manifest 前缀 | `manifest.webmanifest` 的 `start_url` 与 `scope` 均为 `"./"` |

---

## 4. 必需文件清单

### 4.1 `manifest.webmanifest`

```json
{
  "name": "纯文本阅读器",
  "short_name": "阅读器",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#f5f1e8",
  "icons": [
    { "src": "./icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "./icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "./icons/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
  ]
}
```

**不锁 `orientation`**：本产品需要支持横竖屏旋转（验收项），锁方向会直接让该用例无法测试。

### 4.2 `index.html` 的 `<head>`

```html
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f1e8">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
<link rel="stylesheet" href="./styles/themes.css">
<link rel="stylesheet" href="./styles/app.css">
<script>
  // 主题必须在首帧前应用，否则暗色用户每次冷启动白闪（KD-9）
  document.documentElement.dataset.theme =
    localStorage.getItem('txt-reader:theme') || 'light'
</script>
<script type="module" src="./src/main.js"></script>
```

`viewport-fit=cover` 是 `env(safe-area-inset-*)` 生效的前提，刘海屏必需。

### 4.3 图标

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `icons/icon.svg` | 矢量 | 现代 Android / 桌面 |
| `icons/icon-192.png` | 192×192 | manifest 标准图标 |
| `icons/icon-512.png` | 512×512 | 启动画面 / 高分辨率 |
| `icons/apple-touch-icon.png` | **180×180** | iOS 主屏图标，缺了会被截图代替 |

iOS 只认 PNG，SVG 无效。这是唯一必须准备位图的理由。

---

## 5. iOS 安装（与 Android 不同）

| 平台 | 安装方式 |
|---|---|
| Android Chrome | 打开站点 → 地址栏右侧出现"安装"图标，或菜单 → 添加到主屏幕 |
| **iOS Safari** | 打开站点 → 分享按钮 → **添加到主屏幕** |
| iOS Chrome / Edge | **不行**。iOS 上第三方浏览器是 WKWebView 外壳，无法安装 PWA |

所以手机首屏的引导文案要区分平台：iOS 必须明确写「请用 Safari 打开，点分享 → 添加到主屏幕」。

**为什么值得引导安装**：已安装的 Web App 不受 Safari ITP 按"未访问站点"清理的影响，这是保护阅读进度的第二道防线（KD-11）。

---

## 6. 发布流程

四条，顺序不可换：

```
1. 改代码
2. 递增 assets.manifest.json 的 version
3. node --test 全绿
4. git push
```

### 6.1 版本号怎么改

```json
{ "version": "2026-10-25.1", "files": [ ... ] }
```

改成 `2026-10-25.2`。格式是 `日期.当日序号`，只要求**单调变化、每次改前端文件都递增**。

### 6.2 为什么不能漏

`version` 是 SW 缓存名的唯一来源。不递增意味着：

- SW 认为没有更新，不重新拉取文件
- 用户手机上永远是旧版
- 你推送的修复"不存在"

这是本项目唯一的人肉环节。`assets.test.js` 能查出漏文件，但查不出"忘了改版本号"——所以第 7 节的验证清单里有专门一条。

### 6.3 推送后别急着验证

GitHub Pages 的 CDN 对静态资源返回 `Cache-Control: max-age=600`。推送后**最多 10 分钟内**仍可能拿到旧文件。

正确做法：

- 等 10 分钟，或用**无痕窗口**（SW 与 HTTP 缓存都不共享）
- 手机端验证时要**完全关闭 PWA 再重开**（不只是切后台）
- 想立刻确认，看仓库的 **Actions / Pages** 页面里那次部署是否显示成功且时间戳是新的

---

## 7. 验证清单

### 7.1 桌面（部署后 5 分钟）

- [ ] 访问站点根路径，不白屏、控制台无 404
- [ ] DevTools → Application → Manifest：无错误，`start_url` 显示为 `./`
- [ ] Application → Service Workers：状态 activated，Scope 为 `/[REPO]/`
- [ ] Application → Cache Storage：存在名为 `txt-reader-<version>` 的缓存，条目数与 `files` 一致
- [ ] 断网刷新（DevTools 的 Offline）：仍能打开书架

### 7.2 手机（首次）

- [ ] Safari / Chrome 打开站点，正文可读
- [ ] 添加到主屏幕，图标为设计图标（不是网页截图）
- [ ] 从主屏图标启动：无地址栏、无浏览器 UI
- [ ] 飞行模式下冷启动，书架可见、已读的书能继续读

### 7.3 手机（每次发布）

- [ ] 完全关闭 PWA → 重开 → 看到本次改动
- [ ] 若未生效：确认 `version` 已递增，再等 10 分钟重试

---

## 8. 故障排查

| 症状 | 最可能原因 | 处理 |
|---|---|---|
| 线上白屏，控制台 404 `/src/main.js` | HTML 用了绝对路径 | 改 `./`；`assets.test.js` 应拦住 |
| 页面正常但 JS 不执行 | module 路径错 / MIME 异常 | 看 Network 面板里 `main.js` 的状态码与 `Content-Type` |
| 点主屏图标后跳进浏览器并带地址栏 | manifest `start_url` 是绝对路径 | 改 `"./"` |
| 改了代码线上没变 | CDN 缓存（10 分钟）或 `version` 未递增 | 无痕窗口验证；确认版本号 |
| SW 一直停留在 activated (waiting) | 旧客户端未全部关闭 | 关闭所有该站点标签/PWA 后重开 |
| `cache.addAll` 安装失败 | `files` 里有不存在的路径，或缺 `.nojekyll` 导致文件被忽略 | 跑 `node --test`；确认文件已推送 |
| iOS 装不上 | 用了 Chrome/Edge | 必须 Safari → 分享 → 添加到主屏幕 |
| 主屏图标是网页截图 | 缺 `apple-touch-icon.png` | 补 180×180 PNG |
| 页面中文乱码 | 缺 `<meta charset="utf-8">` | 补到 `<head>` 首行 |
| Pages 报构建失败 | Jekyll 尝试处理 | 加 `.nojekyll` 空文件 |
| 404 但文件确实在仓库 | Pages 的 Branch / Folder 配置错 | 重新检查 Settings → Pages |
| 仓库根 `docs/` 也能被访问 | 根目录全量发布 | 无害（设计文档本来就是公开的）；不希望暴露则改用 Actions 只发布必要文件 |

---

## 9. 自定义域名（可选）

1. Pages 设置 → Custom domain 填入域名 → Save
2. DNS 配 `CNAME` 指向 `[GITHUB_USER].github.io`（subdomain）或 `A` 记录（apex 域名）
3. 等证书签发（几分钟到 24 小时），然后勾选 **Enforce HTTPS**
4. 仓库根会出现一个 `CNAME` 文件，内容只有域名一行（不含 `https://`），提交时不要删

**代价**：需要域名和 DNS 维护；**收益**：URL 短、脱离 `/[REPO]/` 前缀（不过按 KD-14 全相对路径写，前缀本来也不构成问题）。

---

## 10. 退路：迁到 Cloudflare Pages

如果国内移动网络下 GitHub Pages 实测太慢或不稳，迁移成本接近零——因为全站相对路径。

| 步骤 | 操作 |
|---|---|
| 1 | Cloudflare Pages → Connect to Git → 选同一仓库 |
| 2 | Build command 留空 |
| 3 | Output directory 留 `/` |
| 4 | Deploy |

不需要改一行代码。额外好处：Cloudflare Pages **支持 `_headers` 文件**，可以设真正的 `Cache-Control`、CSP、`X-Frame-Options`，这些都绕不开 GitHub Pages 的能力边界（KD-14）。

迁移后记得把新的域名重新做一次手机安装引导。
