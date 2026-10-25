/**
 * 书架（KD-1 / KD-11 / KD-12）
 *
 * 目录只读元数据：`listBooks()` 绝不读 texts，否则 10 本 20MB 的书会一次性
 * 把上百 MB 字符串克隆进内存，低端手机直接触发页面回收（KD-2）。
 */

import {
  MAX_BYTES,
  IngestError,
  describeIngestFailure,
  ingestBuffer,
} from './ingest.js'
import { BackupError, backupFileName, parseBackup, planImport, serializeBackup, summarizeImport } from './backup.js'
import { estimateUsage } from './store.js'
import { applyImportedSettings, applySettings, isHintShown, loadSettings, markHintShown } from './settings.js'
import {
  el,
  clear,
  showToast,
  formatCount,
  formatBytes,
  formatPercent,
  formatRelativeTime,
  pickFile,
  readFileAsBuffer,
  readFileAsText,
  downloadText,
} from './ui.js'

const PHASE_TEXT = {
  decode: '识别编码并解码…',
  scan: '切分章节…',
  store: '写入本地存储…',
}

function coverColor(title) {
  let hash = 0
  for (const char of String(title ?? '')) {
    hash = (hash * 31 + char.codePointAt(0)) % 360
  }
  return `hsl(${hash} 42% 46%)`
}

function firstChar(title) {
  const text = String(title ?? '').trim()
  return text ? Array.from(text)[0] : '书'
}

/** 是否已经以独立窗口运行（PWA 安装后） */
function isStandalone() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  return navigator.standalone === true
}

function isIOS() {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export class Bookshelf {
  /**
   * @param {{ mount: HTMLElement, repository: object, openBook: (id:string)=>void }} options
   */
  constructor(options) {
    this.mount = options.mount
    this.repository = options.repository
    this.openBook = options.openBook
    this.books = []
    this.progressById = new Map()
    this.busy = false
  }

  async open() {
    this.buildDom()
    await this.refresh()
    void this.renderStorageInfo()
  }

  destroy() {
    clear(this.mount)
  }

  async refresh() {
    const [books, progressList] = await Promise.all([
      this.repository.listBooks(),
      this.repository.listProgress(),
    ])
    this.books = books
    this.progressById = new Map(progressList.map((item) => [item.bookId, item]))
    this.render()
  }

  // ────────────────────────────── DOM ──────────────────────────────

  buildDom() {
    clear(this.mount)
    this.importButton = el('button', {
      class: 'primary-btn',
      type: 'button',
      onClick: () => void this.handleImport(),
    }, ['导入 TXT'])

    this.header = el('header', { class: 'shelf-head' }, [
      el('div', { class: 'shelf-head-main' }, [
        el('h1', { class: 'shelf-title', text: '书架' }),
        el('p', { class: 'shelf-sub', text: '本地阅读 · 不上传任何内容' }),
      ]),
      el('div', { class: 'shelf-actions' }, [
        this.importButton,
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': '备份与恢复',
          onClick: () => this.openMoreMenu(),
        }, '⋯'),
      ]),
    ])

    this.hintBar = el('div', { class: 'hint-bar' })
    this.list = el('div', { class: 'book-list' })
    this.storageInfo = el('footer', { class: 'shelf-foot' })

    this.root = el('div', { class: 'shelf' }, [this.header, this.hintBar, this.list, this.storageInfo])
    this.mount.appendChild(this.root)

    this.renderHint()
  }

  renderHint() {
    clear(this.hintBar)
    if (isStandalone() || isHintShown()) return
    const text = isIOS()
      ? 'iPhone / iPad：请用 Safari 打开，点「分享」→「添加到主屏幕」，可离线阅读、数据更稳。'
      : '添加到主屏幕后可从图标启动、离线可用，阅读进度也更不容易被清理。'
    this.hintBar.append(
      el('div', { class: 'hint' }, [
        el('span', { class: 'hint-text', text }),
        el('button', {
          class: 'hint-close',
          type: 'button',
          'aria-label': '不再提示',
          onClick: () => {
            markHintShown()
            clear(this.hintBar)
          },
        }, '×'),
      ]),
    )
  }

  render() {
    clear(this.list)

    if (this.books.length === 0) {
      this.list.append(
        el('div', { class: 'empty' }, [
          el('div', { class: 'empty-mark', text: '文' }),
          el('p', { class: 'empty-title', text: '书架还是空的' }),
          el('p', { class: 'empty-text', text: '选一个本地 .txt 文件开始阅读。手机上的路径：微信/QQ 收到的文件 → 用其他应用打开 → 存到「文件」→ 在这里导入。' }),
          el('button', {
            class: 'primary-btn',
            type: 'button',
            onClick: () => void this.handleImport(),
          }, '选择 .txt 文件'),
        ]),
      )
      return
    }

    const fragment = document.createDocumentFragment()
    for (const book of this.books) {
      fragment.appendChild(this.renderBook(book))
    }
    this.list.appendChild(fragment)
  }

  renderBook(book) {
    const progress = this.progressById.get(book.id)
    const percent = progress ? Math.min(1, Math.max(0, Number(progress.chapterPercent) || 0)) : 0
    const position = progress
      ? `第 ${(Number(progress.chapterIndex) || 0) + 1}/${book.chapterCount || '?'} 章 · ${formatPercent(percent)}`
      : '未开始'

    const metaBits = [formatCount(book.charCount), `${book.chapterCount || 0} 章`, formatRelativeTime(book.lastReadAt)]
    if (book.autoSplit) metaBits.push('自动分节')
    if (book.encoding && book.encoding !== 'utf-8') metaBits.push(book.encoding)

    const badges = []
    if (book.missing) badges.push(el('span', { class: 'badge badge-warn', text: '待重新导入原文' }))
    else if (book.encodingConfidence === 'low') badges.push(el('span', { class: 'badge badge-warn', text: '编码可能识别有误' }))

    const card = el('article', {
      class: `book${book.missing ? ' is-missing' : ''}`,
      role: 'button',
      tabindex: '0',
      onClick: () => this.openBook(book.id),
      onKeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.openBook(book.id)
        }
      },
    }, [
      el('div', { class: 'book-cover', style: `background:${coverColor(book.title)}` }, [
        el('span', { class: 'book-cover-char', text: firstChar(book.title) }),
        el('span', { class: 'book-cover-spine' }),
      ]),
      el('div', { class: 'book-main' }, [
        el('h2', { class: 'book-title', text: book.title || '未命名' }),
        el('p', { class: 'book-meta', text: metaBits.join(' · ') }),
        el('p', { class: 'book-position', text: position }),
        badges.length ? el('div', { class: 'book-badges' }, badges) : null,
        el('div', { class: 'book-bar' }, [el('div', { class: 'book-bar-fill', style: `width:${(percent * 100).toFixed(1)}%` })]),
      ]),
      el('div', { class: 'book-side' }, [
        el('span', { class: 'book-percent', text: formatPercent(percent) }),
        el('button', {
          class: 'book-menu',
          type: 'button',
          'aria-label': '更多操作',
          onClick: (event) => {
            event.stopPropagation()
            this.openRowMenu(book)
          },
        }, '⋯'),
      ]),
    ])
    return card
  }

  async renderStorageInfo() {
    const usage = await estimateUsage()
    if (!usage) return
    const quotaText = usage.quota ? ` / ${formatBytes(usage.quota)}` : ''
    this.storageInfo.textContent = `本地已用 ${formatBytes(usage.usage)}${quotaText}`
  }

  // ────────────────────────────── 导入 ──────────────────────────────

  async handleImport() {
    if (this.busy) return
    const files = await pickFile()
    const file = files[0]
    if (!file) return

    // 先看 size 再读（KD-12：读之前先拒，不要先读后拒）
    if (file.size === 0) {
      showToast('文件为空')
      return
    }
    if (file.size > MAX_BYTES) {
      showToast(`文件超过 ${MAX_BYTES / 1024 / 1024}MB 上限`)
      return
    }

    this.busy = true
    const modal = this.showProgress('正在导入…', file.name)
    try {
      const buffer = await readFileAsBuffer(file)
      const meta = await this.runIngest({
        buffer,
        fileName: file.name,
        byteSize: file.size,
        onProgress: (progress) => modal.setProgress(progress),
        registerCancel: (cancel) => modal.onCancel(cancel),
      })
      modal.close()
      await this.refresh()
      void this.renderStorageInfo()
      showToast(`已导入《${meta.title}》共 ${meta.chapterCount} 章`, { duration: 3200 })
    } catch (error) {
      modal.close()
      const reason = error instanceof IngestError ? error.reason : 'storage-error'
      showToast(describeIngestFailure(reason, error?.message))
    } finally {
      this.busy = false
    }
  }

  /**
   * 优先走 worker（KD-6）；没有 Worker 或 worker 创建失败时降级到主线程。
   * @param {{ buffer: ArrayBuffer, fileName: string, byteSize: number, onProgress: Function, registerCancel: Function }} job
   */
  async runIngest(job) {
    const supportsWorker = typeof Worker === 'function' && typeof URL === 'function'
    if (supportsWorker) {
      try {
        return await this.runWithWorker(job)
      } catch (error) {
        // worker 创建阶段失败（而非导入失败）才降级
        if (error instanceof IngestError) throw error
        console.warn('[bookshelf] worker 不可用，降级到主线程导入', error)
      }
    }
    return ingestBuffer({
      buffer: job.buffer,
      fileName: job.fileName,
      byteSize: job.byteSize,
      repository: this.repository,
      onProgress: job.onProgress,
    })
  }

  runWithWorker(job) {
    return new Promise((resolve, reject) => {
      let worker
      try {
        worker = new Worker(new URL('./ingest.worker.js', import.meta.url), { type: 'module' })
      } catch (error) {
        reject(error)
        return
      }

      const id = `ingest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        worker?.terminate()
        fn(value)
      }

      worker.addEventListener('message', (event) => {
        const message = event.data
        if (!message || message.id !== id) return
        if (message.type === 'ingest:progress') {
          job.onProgress({ phase: message.phase, ratio: message.ratio })
        } else if (message.type === 'ingest:done') {
          finish(resolve, message.meta)
        } else if (message.type === 'ingest:failed') {
          finish(reject, new IngestError(message.reason, message.detail))
        }
      })
      worker.addEventListener('error', (event) => {
        finish(reject, new IngestError('storage-error', event?.message || 'worker 执行失败'))
      })

      job.registerCancel(() => worker?.postMessage({ type: 'cancel', id }))
      // ArrayBuffer 转移：零拷贝，正文永不跨越线程边界
      try {
        worker.postMessage({ type: 'ingest', id, buffer: job.buffer, fileName: job.fileName, byteSize: job.byteSize }, [job.buffer])
      } catch (error) {
        finish(reject, new IngestError('storage-error', error?.message ?? '无法把文件交给后台线程'))
      }
    })
  }

  showProgress(title, subtitle) {
    let cancelHandler = null
    const fill = el('div', { class: 'progress-fill' })
    const phase = el('div', { class: 'progress-phase', text: '准备中…' })
    const percentLabel = el('span', { class: 'progress-percent', text: '0%' })
    const cancelButton = el('button', { class: 'ghost-btn', type: 'button', onClick: () => cancelHandler?.() }, '取消')

    const modal = el('div', { class: 'modal-backdrop is-open', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-title', text: title }),
        subtitle ? el('div', { class: 'modal-sub', text: subtitle }) : null,
        el('div', { class: 'progress-row' }, [el('div', { class: 'progress-bar' }, [fill]), percentLabel]),
        phase,
        el('div', { class: 'modal-actions' }, [cancelButton]),
      ]),
    ])
    document.body.appendChild(modal)

    return {
      setProgress(progress) {
        const ratio = Math.min(1, Math.max(0, Number(progress?.ratio) || 0))
        fill.style.width = `${(ratio * 100).toFixed(1)}%`
        percentLabel.textContent = formatPercent(ratio)
        phase.textContent = PHASE_TEXT[progress?.phase] ?? '处理中…'
      },
      onCancel(handler) {
        cancelHandler = handler
      },
      close() {
        modal.classList.remove('is-open')
        modal.remove()
      },
    }
  }

  // ────────────────────────────── 行操作 / 备份 ──────────────────────────────

  openRowMenu(book) {
    const actions = [
      { label: '重命名', run: () => this.renameBook(book) },
      { label: book.missing ? '删除进度记录' : '删除本书', danger: true, run: () => this.deleteBook(book) },
    ]
    this.showActionSheet(book.title || '未命名', actions)
  }

  openMoreMenu() {
    const actions = [
      { label: '导出备份（进度 + 书单）', run: () => this.exportBackup() },
      { label: '导入备份', run: () => this.importBackup() },
    ]
    this.showActionSheet('备份与恢复', actions)
  }

  showActionSheet(title, actions) {
    const close = () => {
      backdrop.classList.remove('is-open')
      backdrop.remove()
    }
    const buttons = actions.map((action) =>
      el('button', {
        class: `sheet-action${action.danger ? ' is-danger' : ''}`,
        type: 'button',
        onClick: () => {
          close()
          void action.run()
        },
      }, action.label),
    )
    const panel = el('div', { class: 'sheet is-open' }, [
      el('div', { class: 'sheet-handle' }),
      el('div', { class: 'sheet-body' }, [el('div', { class: 'sheet-heading', text: title }), ...buttons]),
    ])
    const backdrop = el('div', { class: 'backdrop is-open', onClick: close }, [panel])
    panel.addEventListener('click', (event) => event.stopPropagation())
    document.body.appendChild(backdrop)
  }

  async renameBook(book) {
    const next = window.prompt('重命名', book.title ?? '')
    if (next === null) return
    const title = next.trim()
    if (!title || title === book.title) return
    await this.repository.updateBookMeta?.({ ...book, title })
    await this.refresh()
  }

  async deleteBook(book) {
    const label = book.missing ? '删除这条进度记录？' : `删除《${book.title}》？\n正文与阅读进度会一起清除，无法恢复。`
    if (!window.confirm(label)) return
    await this.repository.deleteBook(book.id)
    await this.refresh()
    void this.renderStorageInfo()
    showToast('已删除')
  }

  async exportBackup() {
    try {
      const [books, progress] = await Promise.all([this.repository.listBooks(), this.repository.listProgress()])
      const json = serializeBackup({ books, progress, settings: loadSettings() })
      downloadText(backupFileName(), json)
      showToast('备份已导出：进度与书单，不含正文')
    } catch (error) {
      showToast(`导出失败：${error?.message ?? error}`)
    }
  }

  async importBackup() {
    const files = await pickFile()
    const file = files[0]
    if (!file) return
    try {
      const text = await readFileAsText(file)
      const backup = parseBackup(text)
      const [localBooks, localProgress] = await Promise.all([
        this.repository.listBooks(),
        this.repository.listProgress(),
      ])
      const plan = planImport({ localBooks, localProgress, backup })

      for (const op of plan.bookOps) {
        await this.repository.putBook(op.book, '')
      }
      for (const op of plan.progressOps) {
        await this.repository.putProgress(op.progress)
      }
      if (backup.settings) {
        applyImportedSettings(backup.settings)
        applySettings(loadSettings())
      }

      await this.refresh()
      void this.renderStorageInfo()
      showToast(summarizeImport(plan), { duration: 5000 })
    } catch (error) {
      if (error instanceof BackupError) {
        showToast(`备份无法导入：${error.message}`)
      } else {
        showToast(`导入备份失败：${error?.message ?? error}`)
      }
    }
  }
}
