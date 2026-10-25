/**
 * 交付守卫（KD-14 / KD-15 / §7.1 assets.test.js）
 *
 * 零构建意味着没有打包器替我们检查：
 *   - 有没有漏文件（SW 预缓存清单是手写的）
 *   - 有没有绝对路径（项目站点带 /[REPO]/ 前缀，绝对路径线上必挂）
 * 所以这些必须由测试兜住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'assets.manifest.json'), 'utf8'))

function readRepoFile(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

/** './' 这种目录项按 index.html 处理 */
function resolveAssetPath(entry) {
  if (entry === './' || entry === '.') return 'index.html'
  return entry.replace(/^\.\//, '')
}

test('assets.manifest.json 的结构与版本号格式', () => {
  assert.match(manifest.version, /^\d{4}-\d{2}-\d{2}\.\d+$/, `版本号格式不对：${manifest.version}`)
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
  for (const entry of manifest.files) {
    assert.match(entry, /^\.\//, `清单项必须用 ./ 开头：${entry}`)
  }
})

test('清单里每个路径都在仓库内真实存在', () => {
  const missing = manifest.files.filter((entry) => !existsSync(join(ROOT, resolveAssetPath(entry))))
  assert.deepEqual(missing, [], `清单里有不存在的文件：${missing.join(', ')}`)
})

test('src/ styles/ icons/ 下的每个文件都进了预缓存清单', () => {
  const listed = new Set(manifest.files.map(resolveAssetPath))
  const expected = []
  for (const dir of ['src', 'styles', 'icons']) {
    for (const file of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${file}`
      if (statSync(join(ROOT, rel)).isFile()) expected.push(rel)
    }
  }
  const missing = expected.filter((file) => !listed.has(file))
  assert.deepEqual(missing, [], `这些文件没写进 assets.manifest.json：${missing.join(', ')}`)
})

test('index.html 不含绝对路径引用（KD-14）', () => {
  const html = readRepoFile('index.html')
  const absolute = [...html.matchAll(/(?:src|href)\s*=\s*"(\/[^"]*)"/g)].map((match) => match[1])
  assert.deepEqual(absolute, [], `index.html 出现绝对路径：${absolute.join(', ')}`)
  assert.ok(html.includes('src="./src/main.js"'), 'main.js 必须用相对路径')
})

test('index.html 的主题脚本早于样式表（KD-9 防白闪）', () => {
  const html = readRepoFile('index.html')
  const themeIndex = html.indexOf('txt-reader:theme')
  const cssIndex = html.indexOf('styles/themes.css')
  assert.ok(themeIndex > -1, 'index.html 必须内联主题脚本')
  assert.ok(cssIndex > -1, 'index.html 必须引用 themes.css')
  assert.ok(themeIndex < cssIndex, '主题脚本必须早于样式表')
  assert.ok(html.includes('viewport-fit=cover'), '刘海屏需要 viewport-fit=cover')
  assert.ok(html.includes('<meta charset="utf-8">'), '必须声明 UTF-8')
})

test('manifest.webmanifest 的 start_url 与 scope 是 "./"（KD-14）', () => {
  const webmanifest = JSON.parse(readRepoFile('manifest.webmanifest'))
  assert.equal(webmanifest.start_url, './')
  assert.equal(webmanifest.scope, './')
  assert.equal(webmanifest.display, 'standalone')
  assert.equal(webmanifest.orientation, undefined, '不能锁方向，验收要测横竖屏旋转')
  const sources = webmanifest.icons.map((icon) => icon.src)
  for (const src of sources) {
    assert.match(src, /^\.\//, `图标路径必须相对：${src}`)
    assert.ok(existsSync(join(ROOT, resolveAssetPath(src))), `图标不存在：${src}`)
  }
  assert.ok(sources.some((src) => src.endsWith('.png')), '需要 PNG 图标（iOS 不认 SVG）')
})

test('src 下的 ES module 相对导入都能解析到真实文件', () => {
  const files = readdirSync(join(ROOT, 'src')).filter((file) => file.endsWith('.js'))
  const problems = []
  for (const file of files) {
    const source = readRepoFile(`src/${file}`)
    for (const match of source.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolve(ROOT, 'src', match[1])
      if (!existsSync(target)) problems.push(`${file} → ${match[1]}`)
    }
    for (const match of source.matchAll(/(?:from|import)\s+['"](\/[^'"]+)['"]/g)) {
      problems.push(`${file} 使用了绝对导入 ${match[1]}`)
    }
    for (const match of source.matchAll(/["'`](https?:\/\/[^"'`]+)["'`]/g)) {
      const url = match[1]
      if (!url.startsWith('http://www.w3.org')) problems.push(`${file} 硬编码了外部 URL ${url}`)
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('sw.js 使用相对清单路径且不缓存数据', () => {
  // 注释里会解释数据边界，断言只看代码
  const sw = readRepoFile('sw.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.ok(sw.includes("'./assets.manifest.json'"), '清单路径必须是相对的')
  assert.ok(sw.includes("cache: 'no-store'"), '清单请求必须绕开 CDN 缓存')
  assert.ok(sw.includes('skipWaiting'))
  assert.ok(sw.includes('clients.claim'))
  assert.ok(sw.includes('txt-reader-'))
  assert.ok(!sw.includes('indexedDB'), 'SW 不应碰 IndexedDB')
  assert.ok(!/caches\.open\([^)]*(books|texts|progress)/.test(sw), 'SW 不应缓存数据 store')
})

test('main.js 以相对路径注册 Service Worker', () => {
  const source = readRepoFile('src/main.js')
  assert.ok(source.includes("'./sw.js'"), '注册路径必须相对')
  assert.ok(source.includes("updateViaCache: 'none'"), '必须绕开 HTTP 缓存')
})

test('.nojekyll 存在（GitHub Pages 跳过 Jekyll）', () => {
  const path = join(ROOT, '.nojekyll')
  assert.ok(existsSync(path))
  assert.equal(statSync(path).size, 0, '.nojekyll 必须是空文件')
})

test('依赖总数为 0（零构建是硬约束，见 KD-10）', () => {
  const pkg = JSON.parse(readRepoFile('package.json'))
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.type, 'module')
})

test('关键文本文件不带 UTF-8 BOM（BOM 会让 JSON.parse 直接失败）', () => {
  const files = ['assets.manifest.json', 'manifest.webmanifest', 'package.json', 'index.html', 'sw.js']
  const withBom = files.filter((file) => {
    const bytes = readFileSync(join(ROOT, file))
    return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  })
  assert.deepEqual(withBom, [], `这些文件带了 BOM：${withBom.join(', ')}`)
})

test('仓库根目录没有把 node_modules 之类的构建产物提交进来', () => {
  const entries = readdirSync(ROOT)
  assert.ok(!entries.includes('node_modules'))
  assert.ok(!entries.includes('dist'))
  const relativeRoot = relative(ROOT, ROOT) || '.'
  assert.equal(relativeRoot.split(sep).length >= 1, true)
})
