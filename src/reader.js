/**
 * 阅读器（KD-3 / KD-7 / KD-8）
 *
 * 三段式滑动窗口：上一章末 800 字 / 当前章全文 / 下一章首 800 字。
 * 这样"滚到章尾内容突然没了"的断流不会出现，DOM 上界又与全书大小无关。
 *
 * 位置模型是 {章序号, 章内百分比}：改字号、转屏、重开都不会漂（KD-8）。
 */

import { normalizeProgress, toPercent, toScrollTop } from './position.js'
import { normalizeChapter } from './normalize.js'
import { reencodeBook, describeIngestFailure, IngestError } from './ingest.js'
import { MANUAL_ENCODINGS } from './decode.js'
import { SETTING_RANGES, THEMES, THEME_LABELS, applySettings, clampSetting, loadSettings, saveSetting } from './settings.js'
import { el, clear, showToast, formatPercent, debounce, isCoarsePointer, raf2, waitForFonts } from './ui.js'

/** 相邻章预渲染长度（KD-7） */
export const EDGE_CHARS = 800
/** 段落缓存条目数（够覆盖 tail/main/head 三段） */
const PARAGRAPH_CACHE_SIZE = 6
/** 认为"滚动已静止"的连续帧数（KD-7 惯性滚动对策） */
const IDLE_FRAMES = 2
/** 自动换章前必须发生的最小滚动位移，避免短章连环 promote */
const PROMOTE_MIN_SCROLL = 24
/** 换章冷却，避免哨兵抖动 */
const PROMOTE_COOLDOWN_MS = 250
/** 点击判定：位移小于这个值才算"点击"（KD-7 触摸交互） */
const TAP_SLOP = 10
/** 目录虚拟列表的固定行高（px），与 styles/app.css 的 .drawer-item 高度一致 */
const DRAWER_ROW_HEIGHT = 40
/** 虚拟列表上下多渲染几行，减少快速滚动时的空白 */
const DRAWER_OVERSCAN = 6

/**
 * tail/head 只渲染邻近的一段，但段落索引必须是"章内全局索引"，
 * 否则换章后锚点在重建的 DOM 里找不到。
 */
function sliceForRole(paragraphs, role, edgeChars = EDGE_CHARS) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) return []
  if (role === 'main') return paragraphs.map((text, index) => ({ index, text }))

  const picked = []
  let chars = 0
  if (role === 'head') {
    for (let i = 0; i < paragraphs.length && chars < edgeChars; i += 1) {
      picked.push({ index: i, text: paragraphs[i] })
      chars += paragraphs[i].length
    }
  } else {
    for (let i = paragraphs.length - 1; i >= 0 && chars < edgeChars; i -= 1) {
      picked.unshift({ index: i, text: paragraphs[i] })
      chars += paragraphs[i].length
    }
  }
  return picked
}

export class Reader {
  /**
   * @param {{ mount: HTMLElement, repository: object, meta: object, onExit: Function }} options
   */
  constructor(options) {
    this.mount = options.mount
    this.repository = options.repository
    this.meta = options.meta
    this.onExit = options.onExit ?? (() => {})
    this.bookId = options.meta.id

    this.chapterIndex = 0
    this.settings = loadSettings()
    this.paragraphCache = new Map()
    this.renderToken = 0
    this.destroyed = false
    this.promoting = false
    this.noPromote = false
    this.targetDir = 0
    this.idleLoopRunning = false
    this.stableFrames = 0
    this.lastFrameTop = 0
    this.scrollAtRender = 0
    this.cooldownUntil = 0
    this.scrollTick = 0
    this.drawerOpen = false
    this.sheetOpen = false
    this.lastSaved = null
    this.selectedEncoding = this.meta.encoding

    this.saveProgress = debounce(() => this.flushProgress(), 500)
    this.lastSnapshot = null
    this.pointerStart = null
    this.sheetValues = null
    this.onViewportScroll = () => this.handleScroll()
    this.onDocumentKeyDown = (event) => this.handleKeyDown(event)
    this.onPointerDown = (event) => this.handlePointerDown(event)
    this.onPointerUp = (event) => this.handlePointerUp(event)
    this.onVisibility = () => this.handleVisibility()
    this.onResize = debounce(() => this.handleResize(), 250)
  }

  // ────────────────────────────── 生命周期 ──────────────────────────────

  async open() {
    this.buildDom()
    this.bindEvents()

    const saved = await this.repository.getProgress(this.bookId)
    this.chapterIndex = normalizeProgress(saved, this.meta.chapters.length).chapterIndex

    await this.renderSegments()
    await this.restorePosition(saved)
    this.updateBars()
    this.updateDrawerActive()

    // 书架排序依据
    try {
      await this.repository.updateBookMeta?.({ ...this.meta, lastReadAt: Date.now() })
    } catch {
      // 读不到书架时间不影响阅读
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.saveProgress.flush()
    this.onResize.cancel()
    this.saveProgress.cancel()
    if (this.scrollTick) cancelAnimationFrame(this.scrollTick)
    this.scrollTick = 0
    if (this.drawerScrollTick) cancelAnimationFrame(this.drawerScrollTick)
    this.drawerScrollTick = 0
    this.topObserver?.disconnect()
    this.bottomObserver?.disconnect()
    this.topObserver = null
    this.bottomObserver = null
    this.viewport?.removeEventListener('scroll', this.onViewportScroll)
    document.removeEventListener('keydown', this.onDocumentKeyDown)
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('resize', this.onResize)
    clear(this.mount)
  }

  // ────────────────────────────── DOM ──────────────────────────────

  buildDom() {
    clear(this.mount)
    this.root = el('div', { class: 'reader' })

    this.chapterLabel = el('div', { class: 'bar-chapter' })
    this.bookLabel = el('div', { class: 'bar-book', text: this.meta.title })
    this.topBar = el('header', { class: 'bar bar-top' }, [
      el('button', {
        class: 'bar-btn bar-back',
        type: 'button',
        'aria-label': '返回书架',
        onClick: () => this.onExit(),
      }, '‹'),
      el('div', { class: 'bar-titles' }, [this.bookLabel, this.chapterLabel]),
      el('div', { class: 'bar-actions' }, [
        el('button', { class: 'bar-btn', type: 'button', onClick: () => this.openDrawer() }, '目录'),
        el('button', { class: 'bar-btn', type: 'button', onClick: () => this.openSheet() }, '设置'),
      ]),
    ])

    this.viewport = el('div', { class: 'viewport', tabindex: '0', 'aria-label': '阅读区' })

    this.progressLabel = el('div', { class: 'bar-progress', text: '0%' })
    this.bottomBar = el('footer', { class: 'bar bar-bottom' }, [
      el('button', { class: 'bar-btn', type: 'button', onClick: () => void this.promote(-1) }, '上一章'),
      this.progressLabel,
      el('button', { class: 'bar-btn', type: 'button', onClick: () => void this.promote(1) }, '下一章'),
    ])

    this.drawerList = el('div', { class: 'drawer-list', role: 'list' })
    this.drawer = el('aside', { class: 'drawer', 'aria-hidden': 'true' }, [
      el('div', { class: 'drawer-head' }, [
        el('div', { class: 'drawer-title', text: `${this.meta.title}` }),
        el('button', { class: 'drawer-close', type: 'button', 'aria-label': '关闭目录', onClick: () => this.closeDrawer() }, '×'),
      ]),
      this.drawerList,
    ])
    this.drawerBackdrop = el('div', { class: 'backdrop', onClick: () => this.closeDrawer() })

    this.sheetBody = el('div', { class: 'sheet-body' })
    this.sheet = el('div', { class: 'sheet', 'aria-hidden': 'true' }, [
      el('div', { class: 'sheet-handle' }),
      this.sheetBody,
    ])
    this.sheetBackdrop = el('div', { class: 'backdrop', onClick: () => this.closeSheet() })

    this.root.append(
      this.topBar,
      this.viewport,
      this.bottomBar,
      this.drawerBackdrop,
      this.drawer,
      this.sheetBackdrop,
      this.sheet,
    )
    this.mount.append(this.root)

    this.applyReaderSettings()
    // 手机默认隐藏工具栏（KD-7），桌面保留
    if (isCoarsePointer()) this.root.classList.add('bars-hidden')
  }

  applyReaderSettings() {
    this.settings = loadSettings()
    applySettings(this.settings)
  }

  bindEvents() {
    this.viewport.addEventListener('scroll', this.onViewportScroll, { passive: true })
    this.viewport.addEventListener('pointerdown', this.onPointerDown, { passive: true })
    this.viewport.addEventListener('pointerup', this.onPointerUp, { passive: true })
    document.addEventListener('keydown', this.onDocumentKeyDown)
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('resize', this.onResize)
  }

  // ────────────────────────────── 渲染 ──────────────────────────────

  async getParagraphs(chapterIndex) {
    if (this.paragraphCache.has(chapterIndex)) {
      const cached = this.paragraphCache.get(chapterIndex)
      this.paragraphCache.delete(chapterIndex)
      this.paragraphCache.set(chapterIndex, cached) // LRU 提权
      return cached
    }
    const chapter = this.meta.chapters[chapterIndex]
    let paragraphs = []
    if (chapter) {
      const raw = await this.repository.getChapterText(this.bookId, chapterIndex)
      paragraphs = normalizeChapter(raw, { title: chapter.title }).paragraphs
    }
    this.paragraphCache.set(chapterIndex, paragraphs)
    while (this.paragraphCache.size > PARAGRAPH_CACHE_SIZE) {
      const oldest = this.paragraphCache.keys().next().value
      this.paragraphCache.delete(oldest)
    }
    return paragraphs
  }

  renderSection(chapterIndex, paragraphs, role) {
    const chapter = this.meta.chapters[chapterIndex]
    const section = el('section', {
      class: `seg seg-${role}`,
      'data-chapter': String(chapterIndex),
      'data-role': role,
    })
    if (role !== 'main') section.setAttribute('aria-hidden', 'true')
    else section.appendChild(el('h2', { class: 'chapter-title', text: chapter?.title ?? '' }))

    for (const item of sliceForRole(paragraphs, role)) {
      section.appendChild(
        el('p', {
          class: 'para',
          'data-p': `${chapterIndex}:${item.index}`,
          text: item.text,
        }),
      )
    }
    return section
  }

  /**
   * 重建三段 DOM。竞态保护：快速切章时旧的一次结果直接丢弃。
   */
  async renderSegments() {
    const token = (this.renderToken += 1)
    this.noPromote = true
    const total = this.meta.chapters.length
    const current = this.chapterIndex
    const indices = [current - 1, current, current + 1]

    const lists = await Promise.all(
      indices.map((index) => (index >= 0 && index < total ? this.getParagraphs(index) : Promise.resolve(null))),
    )
    if (token !== this.renderToken || this.destroyed) return

    const scrollTop = this.viewport.scrollTop
    const fragment = document.createDocumentFragment()
    const sections = []
    for (let slot = 0; slot < indices.length; slot += 1) {
      const index = indices[slot]
      const paragraphs = lists[slot]
      if (index < 0 || index >= total || !paragraphs) continue
      const role = slot === 0 ? 'tail' : slot === 1 ? 'main' : 'head'
      const section = this.renderSection(index, paragraphs, role)
      sections.push(section)
      fragment.appendChild(section)
    }

    clear(this.viewport)
    this.viewport.appendChild(fragment)
    // 避免"重建使 scrollTop 归零"影响后续锚定计算
    this.viewport.scrollTop = scrollTop
    this.installObservers()
    this.noPromote = false
  }

  installObservers() {
    this.topObserver?.disconnect()
    this.bottomObserver?.disconnect()
    this.topObserver = null
    this.bottomObserver = null
    if (typeof IntersectionObserver !== 'function') return

    const tail = this.viewport.querySelector('.seg-tail')
    const head = this.viewport.querySelector('.seg-head')

    if (tail) {
      // 上滑进入上一章尾部：tail 的 8% 进入视口才触发（避免 main 起点误触）
      this.topObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.08) this.requestAutoPromote(-1)
          }
        },
        { root: this.viewport, threshold: [0.08, 0.2] },
      )
      this.topObserver.observe(tail)
    }

    if (head) {
      // 下滑接近下一章：提前 200px 触发
      this.bottomObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) this.requestAutoPromote(1)
          }
        },
        { root: this.viewport, rootMargin: '0px 0px 200px 0px', threshold: 0 },
      )
      this.bottomObserver.observe(head)
    }
  }

  // ────────────────────────────── 换章与锚定 ──────────────────────────────

  requestAutoPromote(dir) {
    if (this.destroyed || this.noPromote || this.promoting) return
    if (dir > 0 && this.chapterIndex >= this.meta.chapters.length - 1) return
    if (dir < 0 && this.chapterIndex <= 0) return
    this.targetDir = dir
    this.ensureIdleLoop()
  }

  /**
   * iOS 惯性滚动的 momentum 阶段仍有 scroll 事件；此时改写 scrollTop 会"把手拽回"。
   * 所以 promote 只在"连续 2 帧 scrollTop 变化 < 1px"（滚动已静止）后执行。
   */
  ensureIdleLoop() {
    if (this.idleLoopRunning) return
    this.idleLoopRunning = true
    const tick = () => {
      if (this.destroyed) {
        this.idleLoopRunning = false
        return
      }
      const top = this.viewport.scrollTop
      if (Math.abs(top - this.lastFrameTop) < 1) this.stableFrames += 1
      else this.stableFrames = 0
      this.lastFrameTop = top

      if (this.stableFrames >= IDLE_FRAMES) {
        this.idleLoopRunning = false
        this.stableFrames = 0
        const dir = this.targetDir
        this.targetDir = 0
        if (dir !== 0 && this.canPromote(dir)) void this.promote(dir)
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  canPromote(dir) {
    if (this.destroyed || this.noPromote || this.promoting) return false
    if (performance.now() < this.cooldownUntil) return false
    if (dir > 0 && this.chapterIndex >= this.meta.chapters.length - 1) return false
    if (dir < 0 && this.chapterIndex <= 0) return false
    // 换章后滚动静止但用户没动过：不再连环 promote（短章保护）
    return Math.abs(this.viewport.scrollTop - this.scrollAtRender) > PROMOTE_MIN_SCROLL
  }

  /**
   * 换章：先记录可见区顶部锚点，重建 DOM 后把同一段落放回同一屏幕位置。
   * @param {-1|1} dir
   */
  async promote(dir) {
    if (this.destroyed || this.promoting) return false
    const next = this.chapterIndex + dir
    if (next < 0 || next >= this.meta.chapters.length) return false

    this.promoting = true
    this.targetDir = 0
    try {
      const anchor = this.captureAnchor(dir)
      this.chapterIndex = next
      await this.renderSegments()
      await raf2()
      const anchored = this.applyAnchor(anchor)
      if (!anchored) this.placeAtEdge(dir)
      await raf2()
      if (anchored) this.refineAnchor(anchor) // 一帧后校验，最多再补一次
      this.scrollAtRender = this.viewport.scrollTop
      this.lastFrameTop = this.scrollAtRender
      this.stableFrames = 0
      this.cooldownUntil = performance.now() + PROMOTE_COOLDOWN_MS
      this.updateBars()
      this.updateDrawerActive()
      this.queueProgress()
    } finally {
      this.promoting = false
    }
    return true
  }

  captureAnchor(dir) {
    const viewportRect = this.viewport.getBoundingClientRect()
    const nodes = this.viewport.querySelectorAll('.para')
    let topKey = null
    let topDelta = 0
    for (const node of nodes) {
      const rect = node.getBoundingClientRect()
      if (rect.height === 0) continue
      if (rect.bottom > viewportRect.top + 1) {
        topKey = node.dataset.p ?? null
        topDelta = rect.top - viewportRect.top
        break
      }
    }

    const main = this.viewport.querySelector('.seg-main')
    let boundary = null
    if (main) {
      const mainRect = main.getBoundingClientRect()
      boundary = dir > 0 ? mainRect.bottom - viewportRect.top : mainRect.top - viewportRect.top
      // 离边界太远（按钮/快捷键触发的换章）就不具备边界可比性
      if (Math.abs(boundary) > this.viewport.clientHeight * 1.5) boundary = null
    }
    return { dir, topKey, topDelta, boundary }
  }

  applyAnchor(anchor) {
    if (!anchor) return false
    if (anchor.topKey) {
      const node = this.viewport.querySelector(`[data-p="${anchor.topKey}"]`)
      if (node) {
        const viewportRect = this.viewport.getBoundingClientRect()
        const delta = node.getBoundingClientRect().top - viewportRect.top
        const diff = delta - anchor.topDelta
        if (Math.abs(diff) > 0.5) this.viewport.scrollTop += diff
        return true
      }
    }
    if (anchor.boundary !== null && Number.isFinite(anchor.boundary)) {
      const reference =
        anchor.dir > 0 ? this.viewport.querySelector('.seg-main') : this.viewport.querySelector('.seg-head')
      if (reference) {
        this.viewport.scrollTop = Math.max(0, reference.offsetTop - anchor.boundary)
        return true
      }
    }
    return false
  }

  refineAnchor(anchor) {
    if (!anchor?.topKey) return
    const node = this.viewport.querySelector(`[data-p="${anchor.topKey}"]`)
    if (!node) return
    const viewportRect = this.viewport.getBoundingClientRect()
    const delta = node.getBoundingClientRect().top - viewportRect.top
    const diff = delta - anchor.topDelta
    if (Math.abs(diff) > 0.5) this.viewport.scrollTop += diff
  }

  placeAtEdge(dir) {
    const main = this.viewport.querySelector('.seg-main')
    if (!main) return
    if (dir > 0) this.viewport.scrollTop = main.offsetTop
    else this.viewport.scrollTop = Math.max(0, main.offsetTop + main.offsetHeight - this.viewport.clientHeight)
  }

  // ────────────────────────────── 位置与进度 ──────────────────────────────

  mainMetrics() {
    const main = this.viewport?.querySelector('.seg-main')
    if (!main) return null
    return { main, top: main.offsetTop, height: main.offsetHeight, clientHeight: this.viewport.clientHeight }
  }

  computeProgress() {
    const metrics = this.mainMetrics()
    if (!metrics) return { chapterIndex: this.chapterIndex, chapterPercent: 0 }
    const local = this.viewport.scrollTop - metrics.top
    const percent = local <= 0 ? 0 : toPercent(local, metrics.height, metrics.clientHeight)
    return { chapterIndex: this.chapterIndex, chapterPercent: percent }
  }

  /** 把某个章内百分比滚回屏幕（改字号/转屏后保持位置） */
  setScrollForPercent(percent) {
    const metrics = this.mainMetrics()
    if (!metrics) return
    this.viewport.scrollTop = metrics.top + toScrollTop(percent, metrics.height, metrics.clientHeight)
  }

  /**
   * 冷启动恢复时序（KD-8，顺序错了就会漂）
   * @param {{ chapterIndex:number, chapterPercent:number }|null} saved
   */
  async restorePosition(saved) {
    history.scrollRestoration = 'manual'
    const normalized = normalizeProgress(saved, this.meta.chapters.length)
    await waitForFonts()
    this.applyReaderSettings()
    await raf2()
    this.setScrollForPercent(normalized.chapterPercent)
    await raf2()
    // 防御：content-visibility / 字体晚到可能让高度偏小，按百分比再补一次（幂等）
    this.setScrollForPercent(normalized.chapterPercent)
    this.scrollAtRender = this.viewport.scrollTop
    this.lastFrameTop = this.scrollAtRender
    this.lastSnapshot = { chapterIndex: this.chapterIndex, chapterPercent: normalized.chapterPercent }
  }

  handleScroll() {
    this.stableFrames = 0
    if (this.scrollTick) return
    this.scrollTick = requestAnimationFrame(() => {
      this.scrollTick = 0
      const snapshot = this.computeProgress()
      this.lastSnapshot = snapshot
      this.renderProgressLabel(snapshot)
      this.queueProgress()
    })
  }

  queueProgress() {
    this.saveProgress()
  }

  async flushProgress() {
    const snapshot = this.computeProgress()
    this.lastSnapshot = snapshot
    const progress = {
      bookId: this.bookId,
      chapterIndex: snapshot.chapterIndex,
      chapterPercent: snapshot.chapterPercent,
      updatedAt: Date.now(),
    }
    this.lastSaved = progress
    try {
      await this.repository.putProgress(progress)
    } catch (error) {
      showToast('进度保存失败，请检查存储空间')
      console.warn('[reader] 进度写入失败', error)
    }
  }

  renderProgressLabel(snapshot = this.lastSnapshot) {
    const total = this.meta.chapters.length
    const percent = snapshot?.chapterPercent ?? 0
    const label = total > 0 ? `${this.chapterIndex + 1}/${total} · ${formatPercent(percent)}` : formatPercent(percent)
    if (this.progressLabel) this.progressLabel.textContent = label
    return label
  }

  updateBars() {
    const total = this.meta.chapters.length
    const chapter = this.meta.chapters[this.chapterIndex]
    if (this.chapterLabel) {
      this.chapterLabel.textContent = chapter ? `${chapter.title}（${this.chapterIndex + 1}/${total}）` : ''
    }
    this.renderProgressLabel(this.lastSnapshot ?? this.computeProgress())
  }

  async handleResize() {
    if (this.destroyed) return
    if (performance.now() < this.cooldownUntil) return
    const percent = this.lastSnapshot?.chapterPercent ?? this.computeProgress().chapterPercent
    this.setScrollForPercent(percent)
  }

  handleVisibility() {
    if (this.destroyed) return
    if (document.hidden) {
      this.saveProgress.flush()
      return
    }
    void this.verifyPosition()
  }

  /** 从后台回来：内存态可能已被回收，永远可以从 IndexedDB 冷启动校验（KD-8） */
  async verifyPosition() {
    let saved = this.lastSaved
    if (!saved) {
      try {
        saved = await this.repository.getProgress(this.bookId)
      } catch {
        return
      }
    }
    if (!saved || this.destroyed) return
    const normalized = normalizeProgress(saved, this.meta.chapters.length)
    if (normalized.chapterIndex !== this.chapterIndex) {
      this.chapterIndex = normalized.chapterIndex
      await this.renderSegments()
      await raf2()
    }
    const metrics = this.mainMetrics()
    if (!metrics) return
    const expected = metrics.top + toScrollTop(normalized.chapterPercent, metrics.height, metrics.clientHeight)
    if (Math.abs(this.viewport.scrollTop - expected) > this.viewport.clientHeight) {
      this.viewport.scrollTop = expected
    }
  }

  // ────────────────────────────── 输入 ──────────────────────────────

  handlePointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    this.pointerStart = { x: event.clientX, y: event.clientY, time: performance.now() }
  }

  handlePointerUp(event) {
    const start = this.pointerStart
    this.pointerStart = null
    if (!start) return
    if (this.drawerOpen || this.sheetOpen) return
    // 触摸分区只服务粗指针；桌面走快捷键与工具栏按钮（KD-7）
    if (event.pointerType !== 'touch' && !isCoarsePointer()) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.hypot(dx, dy) > TAP_SLOP) return // 是滑动，不是点击
    if (performance.now() - start.time > 600) return // 长按不算

    const width = window.innerWidth || 1
    const x = event.clientX
    if (x < width * 0.25) void this.promote(-1)
    else if (x > width * 0.75) void this.promote(1)
    else this.toggleBars()
  }

  handleKeyDown(event) {
    if (this.drawerOpen || this.sheetOpen) {
      if (event.key === 'Escape') {
        this.closeDrawer()
        this.closeSheet()
      }
      return
    }
    const target = event.target
    if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        void this.promote(-1)
        break
      case 'ArrowRight':
        event.preventDefault()
        void this.promote(1)
        break
      case 'Escape':
        this.closeDrawer()
        this.closeSheet()
        break
      case '+':
      case '=':
        event.preventDefault()
        this.stepSetting('fontSize', 1)
        break
      case '-':
      case '_':
        event.preventDefault()
        this.stepSetting('fontSize', -1)
        break
      default:
        break
    }
  }

  toggleBars() {
    this.root.classList.toggle('bars-hidden')
  }

  // ────────────────────────────── 目录抽屉 ──────────────────────────────

  /**
   * 目录用**固定行高虚拟列表**：真实小说动辄 4000–8000 章，
   * 一次性建 4000 个按钮要 1.9s（实测），手机上更久。
   * 这里只渲染视口附近约 20 行，滚动时按行高换算窗口。
   */
  ensureDrawer() {
    if (this.drawerSpacer) return
    this.drawerSpacer = el('div', { class: 'drawer-spacer' })
    this.drawerRows = el('div', { class: 'drawer-rows' })
    this.drawerSpacer.appendChild(this.drawerRows)
    this.drawerList.appendChild(this.drawerSpacer)
    this.onDrawerScroll = () => {
      if (this.drawerScrollTick) return
      this.drawerScrollTick = requestAnimationFrame(() => {
        this.drawerScrollTick = 0
        this.updateDrawerWindow()
      })
    }
    this.drawerList.addEventListener('scroll', this.onDrawerScroll, { passive: true })
  }

  updateDrawerWindow(force = false) {
    const total = this.meta.chapters.length
    if (total === 0 || !this.drawerSpacer) return
    this.drawerSpacer.style.height = `${total * DRAWER_ROW_HEIGHT}px`

    const scrollTop = this.drawerList.scrollTop
    const viewHeight = this.drawerList.clientHeight || 480
    const first = Math.max(0, Math.floor(scrollTop / DRAWER_ROW_HEIGHT) - DRAWER_OVERSCAN)
    const visible = Math.ceil(viewHeight / DRAWER_ROW_HEIGHT) + DRAWER_OVERSCAN * 2
    const last = Math.min(total - 1, first + visible)

    if (!force && this.drawerWindow && this.drawerWindow.first === first && this.drawerWindow.last === last) {
      return
    }
    this.drawerWindow = { first, last }

    const fragment = document.createDocumentFragment()
    for (let index = first; index <= last; index += 1) {
      const chapter = this.meta.chapters[index]
      fragment.appendChild(
        el('button', {
          class: `drawer-item${index === this.chapterIndex ? ' is-active' : ''}`,
          type: 'button',
          role: 'listitem',
          'data-index': String(index),
          style: `top:${index * DRAWER_ROW_HEIGHT}px`,
          onClick: () => void this.jumpTo(index),
        }, [
          el('span', { class: 'drawer-item-index', text: String(index + 1) }),
          el('span', { class: 'drawer-item-title', text: chapter.title }),
        ]),
      )
    }
    clear(this.drawerRows)
    this.drawerRows.appendChild(fragment)
  }

  openDrawer() {
    this.ensureDrawer()
    this.drawerOpen = true
    this.drawer.classList.add('is-open')
    this.drawer.setAttribute('aria-hidden', 'false')
    this.drawerBackdrop.classList.add('is-open')
    // 先滚到当前章，再渲染窗口
    this.scrollDrawerToCurrent()
  }

  closeDrawer() {
    this.drawerOpen = false
    this.drawer?.classList.remove('is-open')
    this.drawer?.setAttribute('aria-hidden', 'true')
    this.drawerBackdrop?.classList.remove('is-open')
  }

  scrollDrawerToCurrent() {
    if (!this.drawerSpacer) return
    // 先撑出总高度，否则 scrollTop 会被钳到 0，窗口渲染到列表顶部
    this.drawerSpacer.style.height = `${this.meta.chapters.length * DRAWER_ROW_HEIGHT}px`
    const target = this.chapterIndex * DRAWER_ROW_HEIGHT
    const centered = Math.max(0, target - this.drawerList.clientHeight / 2 + DRAWER_ROW_HEIGHT / 2)
    this.drawerList.scrollTop = centered
    this.updateDrawerWindow(true)
  }

  updateDrawerActive() {
    if (!this.drawerSpacer) return
    if (this.drawerOpen) {
      const window = this.drawerWindow
      if (!window || this.chapterIndex < window.first || this.chapterIndex > window.last) {
        this.scrollDrawerToCurrent()
      }
    }
    const previous = this.drawerRows.querySelector('.drawer-item.is-active')
    previous?.classList.remove('is-active')
    const current = this.drawerRows.querySelector(`[data-index="${this.chapterIndex}"]`)
    current?.classList.add('is-active')
  }

  async jumpTo(index) {
    const total = this.meta.chapters.length
    const next = Math.min(Math.max(0, index), Math.max(0, total - 1))
    this.closeDrawer()
    if (next === this.chapterIndex) return

    this.chapterIndex = next
    this.noPromote = true
    await this.renderSegments()
    await raf2()
    this.viewport.scrollTop = 0
    this.scrollAtRender = 0
    this.lastFrameTop = 0
    this.noPromote = false
    this.cooldownUntil = performance.now() + PROMOTE_COOLDOWN_MS
    this.lastSnapshot = { chapterIndex: next, chapterPercent: 0 }
    this.updateBars()
    this.updateDrawerActive()
    this.queueProgress()
  }

  // ────────────────────────────── 设置面板 ──────────────────────────────

  openSheet() {
    this.buildSheet()
    this.sheetOpen = true
    this.sheet.classList.add('is-open')
    this.sheet.setAttribute('aria-hidden', 'false')
    this.sheetBackdrop.classList.add('is-open')
  }

  closeSheet() {
    this.sheetOpen = false
    this.sheet?.classList.remove('is-open')
    this.sheet?.setAttribute('aria-hidden', 'true')
    this.sheetBackdrop?.classList.remove('is-open')
  }

  buildSheet() {
    clear(this.sheetBody)
    const settings = loadSettings()

    const fontSizeValue = el('span', { class: 'step-value', text: String(settings.fontSize) })
    const lineHeightValue = el('span', { class: 'step-value', text: settings.lineHeight.toFixed(1) })
    this.sheetValues = { fontSize: fontSizeValue, lineHeight: lineHeightValue }

    const themeButtons = THEMES.map((theme) =>
      el('button', {
        class: `theme-btn${settings.theme === theme ? ' is-active' : ''}`,
        type: 'button',
        'data-theme-value': theme,
        onClick: (event) => {
          saveSetting('theme', theme)
          for (const button of this.sheetBody.querySelectorAll('.theme-btn')) {
            button.classList.toggle('is-active', button === event.currentTarget)
          }
          this.applyReaderSettings()
        },
      }, THEME_LABELS[theme]),
    )

    const rows = [
      el('div', { class: 'sheet-row' }, [
        el('span', { class: 'sheet-label', text: '字号' }),
        el('div', { class: 'stepper' }, [
          el('button', { class: 'step-btn', type: 'button', 'aria-label': '减小字号', onClick: () => this.stepSetting('fontSize', -1) }, 'A−'),
          fontSizeValue,
          el('button', { class: 'step-btn', type: 'button', 'aria-label': '增大字号', onClick: () => this.stepSetting('fontSize', 1) }, 'A+'),
        ]),
      ]),
      el('div', { class: 'sheet-row' }, [
        el('span', { class: 'sheet-label', text: '行距' }),
        el('div', { class: 'stepper' }, [
          el('button', { class: 'step-btn', type: 'button', 'aria-label': '减小行距', onClick: () => this.stepSetting('lineHeight', -1) }, '−'),
          lineHeightValue,
          el('button', { class: 'step-btn', type: 'button', 'aria-label': '增大行距', onClick: () => this.stepSetting('lineHeight', 1) }, '+'),
        ]),
      ]),
      el('div', { class: 'sheet-row' }, [el('span', { class: 'sheet-label', text: '主题' }), el('div', { class: 'theme-row' }, themeButtons)]),
      this.buildEncodingRow(),
    ]
    this.sheetBody.append(...rows)
  }

  buildEncodingRow() {
    const current = this.meta.encoding
    const low = this.meta.encodingConfidence === 'low'
    const buttons = MANUAL_ENCODINGS.map((encoding) =>
      el('button', {
        class: `chip${encoding === current ? ' is-active' : ''}`,
        type: 'button',
        onClick: () => void this.switchEncoding(encoding),
      }, encoding),
    )
    return el('div', { class: 'sheet-row sheet-row-wrap' }, [
      el('span', { class: 'sheet-label', text: '编码' }),
      el('div', { class: 'encoding-box' }, [
        el('div', { class: 'chips' }, buttons),
        low ? el('p', { class: 'sheet-warn', text: '编码可能识别有误，文字若有乱码可在此切换' }) : null,
      ]),
    ])
  }

  /**
   * 手动切换编码：重新解码 + 重新切章（坐标系统变了），并尽量保住进度。
   */
  async switchEncoding(encoding) {
    if (encoding === this.meta.encoding) return
    this.closeSheet()
    try {
      const next = await reencodeBook({ repository: this.repository, bookId: this.bookId, encoding })
      this.meta = next
      this.paragraphCache.clear()
      this.chapterIndex = Math.min(this.chapterIndex, Math.max(0, next.chapters.length - 1))
      this.noPromote = true
      await this.renderSegments()
      await raf2()
      this.setScrollForPercent(this.lastSnapshot?.chapterPercent ?? 0)
      this.noPromote = false
      this.updateBars()
      this.updateDrawerActive()
      if (this.drawerSpacer) this.updateDrawerWindow(true)
      showToast(`已切换到 ${next.encoding}${next.encodingConfidence === 'low' ? '（仍可能有误）' : ''}`)
    } catch (error) {
      const reason = error instanceof IngestError ? error.reason : 'storage-error'
      showToast(describeIngestFailure(reason, error?.message))
    }
  }

  stepSetting(key, direction) {
    const range = SETTING_RANGES[key]
    if (!range) return
    const before = this.lastSnapshot?.chapterPercent ?? this.computeProgress().chapterPercent
    const next = clampSetting(key, Number(this.settings[key]) + direction * range.step)
    const applied = saveSetting(key, next)
    this.settings = loadSettings()
    this.applyReaderSettings()
    if (this.sheetValues?.[key]) {
      this.sheetValues[key].textContent = key === 'lineHeight' ? Number(applied).toFixed(1) : String(applied)
    }
    // 字号变化会改变内容高度：按百分比把位置补回来
    void raf2().then(() => {
      this.setScrollForPercent(before)
      this.lastSnapshot = { chapterIndex: this.chapterIndex, chapterPercent: before }
      this.updateBars()
    })
  }
}
