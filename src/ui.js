/**
 * 通用 DOM / 格式化工具。不依赖任何第三方。
 */

/**
 * 创建元素。
 * @param {string} tag
 * @param {Record<string, any>} [props] class / text / dataset / aria-* / on* / 其它属性
 * @param {Array<Node|string|null|undefined|false>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else node.setAttribute(key, value === true ? '' : String(value))
  }
  append(node, children)
  return node
}

/** 追加子节点（忽略空值），支持嵌套数组 */
export function append(node, children) {
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) append(node, child)
    else if (typeof child === 'string' || typeof child === 'number') node.append(String(child))
    else node.append(child)
  }
  return node
}

/** 清空节点 */
export function clear(node) {
  if (node) node.textContent = ''
  return node
}

/** 查询 */
export function $(selector, root = document) {
  return root.querySelector(selector)
}

let toastTimer = 0

/**
 * 轻提示。同一时刻只显示一条，新覆盖旧。
 * @param {string} message
 * @param {{ duration?: number }} [options]
 */
export function showToast(message, options = {}) {
  const node = document.getElementById('toast')
  if (!node) return
  node.textContent = message
  node.classList.add('is-visible')
  if (toastTimer) clearTimeout(toastTimer)
  const duration = options.duration ?? 2600
  toastTimer = setTimeout(() => {
    node.classList.remove('is-visible')
    toastTimer = 0
  }, duration)
}

/** 0.47 → "47%" */
export function formatPercent(value, digits = 0) {
  const ratio = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  return `${(ratio * 100).toFixed(digits)}%`
}

/** 20971520 → "20.0 MB" */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 8123456 → "812.3 万字" */
export function formatCount(chars) {
  const value = Number(chars) || 0
  if (value < 10000) return `${value} 字`
  return `${(value / 10000).toFixed(1)} 万字`
}

/** 时间戳 → 刚刚 / 3 分钟前 / 昨天 / 2026-10-20 */
export function formatRelativeTime(timestamp, now = Date.now()) {
  const time = Number(timestamp) || 0
  if (!time) return '未读'
  const diff = Math.max(0, now - time)
  const minute = 60 * 1000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 48 * 60 * minute) return '昨天'
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 是否是粗指针（手机/平板）：KD-7 用它决定挂触摸分区还是键盘快捷键 */
export function isCoarsePointer() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(pointer: coarse)').matches
}

/**
 * 等两帧：确保 reflow 完成（KD-8 恢复时序第 6 步）。
 *
 * 带超时兜底：标签页被遮挡/后台时浏览器会把 rAF 暂停或降到 ~1fps，
 * 纯靠 rAF 会让换章流程一直挂着（promoting 卡死，后续操作全部静默失效）。
 * 布局读取本身会强制同步 reflow，所以超时后继续是安全的。
 * @param {number} [timeoutMs]
 */
export function raf2(timeoutMs = 250) {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    requestAnimationFrame(() => requestAnimationFrame(finish))
  })
}

/** 等字体就绪（KD-8 第 4 步） */
export async function waitForFonts() {
  try {
    if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready
  } catch {
    // 字体 API 不可用就算了，位置精度损失可忽略
  }
}

/**
 * 防抖；返回的函数带 flush()/cancel()。
 * @template {(...args:any[])=>any} F
 * @param {F} fn
 * @param {number} delay
 */
export function debounce(fn, delay) {
  let timer = 0
  let lastArgs = []
  const wrapped = (...args) => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = 0
      fn(...lastArgs)
    }, delay)
  }
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = 0
      fn(...lastArgs)
    }
  }
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = 0
  }
  return wrapped
}

/** 触发文件下载（备份导出用） */
export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = el('a', { href: url, download: filename })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** File → ArrayBuffer */
export function readFileAsBuffer(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsArrayBuffer(file)
  })
}

/** File → string（备份导入用） */
export function readFileAsText(file) {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 用一个临时 input 选文件（不依赖 accept，见 KD-12） */
export function pickFile({ multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file' })
    input.style.display = 'none'
    if (multiple) input.multiple = true
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      resolve(files)
    })
    document.body.append(input)
    input.click()
  })
}
