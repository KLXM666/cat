#!/usr/bin/env node
/**
 * 本地静态服务器（开发期工具，不是构建步骤）
 *
 * 技术方案里写的是 `python -m http.server 8080`；这里额外给一个零依赖的
 * node 版本，方便在没有 python 的机器上做同样的事。行为对齐：
 *   - 相对当前目录提供文件
 *   - 目录回退到 index.html
 *   - 正确的 UTF-8 / MIME（.js 必须是 text/javascript，否则 module 加载失败）
 *
 * 用法：node scripts/serve.mjs [--port 8080]
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'))

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}))

const portIndex = process.argv.indexOf('--port')
const port = Number(portIndex > -1 ? process.argv[portIndex + 1] : process.env.PORT) || 8080
const openBrowser = process.argv.includes('--open')

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const pathname = decodeURIComponent(url.pathname)
    let filePath = normalize(join(ROOT, pathname))

    // 目录穿越保护
    if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
      response.writeHead(403).end('Forbidden')
      return
    }

    let info = await stat(filePath).catch(() => null)
    if (info?.isDirectory()) {
      filePath = join(filePath, 'index.html')
      info = await stat(filePath).catch(() => null)
    }
    if (!info) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found')
      return
    }

    const body = await readFile(filePath)
    response.writeHead(200, {
      'content-type': MIME.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(body)
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`500 ${error?.message ?? error}`)
  }
})

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`
  console.log(`serving ${ROOT}`)
  console.log(url)
  console.log('按 Ctrl+C 停止')
  if (openBrowser) openInBrowser(url)
})

/**
 * 用系统默认浏览器打开。`--open` 只是为了让人少复制一次地址，
 * 失败也不影响服务器本身（终端里已经打印了 URL）。
 */
function openInBrowser(url) {
  const command =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 打不开就让用户自己点终端里的地址
  }
}
