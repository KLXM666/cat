/**
 * 备份序列化 / 反序列化 / 合并计划（KD-11 第 3 道防线）
 *
 * 为什么备份不含正文：20MB × N 本塞不进一个 JSON，且正文可以重新导入。
 * 备份要保住的是"读到哪儿"——那才是用户感知的损失。
 *
 * 纯函数：不碰 DOM、不碰存储。
 */

export const BACKUP_VERSION = 1

/** 备份里保留的书籍字段（不含 chapters / text） */
const BOOK_FIELDS = Object.freeze(['id', 'title', 'charCount', 'chapterCount', 'addedAt', 'lastReadAt'])

export class BackupError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BackupError'
    this.code = code
  }
}

function pickBookFields(book) {
  const out = {}
  for (const field of BOOK_FIELDS) out[field] = book?.[field]
  return {
    id: String(out.id ?? ''),
    title: String(out.title ?? '未命名'),
    charCount: Number.isFinite(Number(out.charCount)) ? Number(out.charCount) : 0,
    chapterCount: Number.isFinite(Number(out.chapterCount)) ? Number(out.chapterCount) : 0,
    addedAt: Number.isFinite(Number(out.addedAt)) ? Number(out.addedAt) : 0,
    lastReadAt: Number.isFinite(Number(out.lastReadAt)) ? Number(out.lastReadAt) : 0,
  }
}

function pickProgressFields(progress) {
  const percent = Number(progress?.chapterPercent)
  const index = Number(progress?.chapterIndex)
  return {
    bookId: String(progress?.bookId ?? ''),
    chapterIndex: Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0,
    chapterPercent: Number.isFinite(percent) ? Math.min(1, Math.max(0, percent)) : 0,
    updatedAt: Number.isFinite(Number(progress?.updatedAt)) ? Number(progress.updatedAt) : 0,
  }
}

/**
 * 导出备份：只序列化元数据、进度与设置。
 * @param {{ books?: object[], progress?: object[], settings?: object|null, now?: number }} input
 * @returns {string} JSON 文本
 */
export function serializeBackup(input = {}) {
  const books = Array.isArray(input.books) ? input.books : []
  const progress = Array.isArray(input.progress) ? input.progress : []
  const payload = {
    version: BACKUP_VERSION,
    exportedAt: Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now(),
    books: books.map(pickBookFields),
    progress: progress.map(pickProgressFields),
    settings: input.settings && typeof input.settings === 'object' ? { ...input.settings } : null,
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * 解析并校验备份。
 * 容忍缺失的 books/progress/settings 字段，但不容忍版本不匹配。
 * @param {string|object} input
 * @returns {{ version:number, exportedAt:number, books:object[], progress:object[], settings:object|null, dropped:number }}
 */
export function parseBackup(input) {
  if (input === null || input === undefined) {
    throw new BackupError('invalid', '备份内容为空')
  }
  let data = input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) throw new BackupError('invalid', '备份内容为空')
    try {
      data = JSON.parse(trimmed)
    } catch {
      throw new BackupError('invalid-json', '备份文件不是合法 JSON')
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BackupError('invalid', '备份格式不正确')
  }

  const version = Number(data.version)
  if (!Number.isFinite(version)) {
    throw new BackupError('invalid', '备份缺少版本号')
  }
  if (version !== BACKUP_VERSION) {
    throw new BackupError('version-mismatch', `备份版本 ${version} 与当前版本 ${BACKUP_VERSION} 不兼容`)
  }

  const rawBooks = data.books === undefined || data.books === null ? [] : data.books
  const rawProgress = data.progress === undefined || data.progress === null ? [] : data.progress
  if (!Array.isArray(rawBooks)) throw new BackupError('invalid', '备份的 books 字段不是数组')
  if (!Array.isArray(rawProgress)) throw new BackupError('invalid', '备份的 progress 字段不是数组')

  let dropped = 0
  const books = []
  for (const book of rawBooks) {
    const picked = pickBookFields(book)
    if (!picked.id) {
      dropped += 1
      continue
    }
    books.push(picked)
  }
  const progress = []
  for (const item of rawProgress) {
    const picked = pickProgressFields(item)
    if (!picked.bookId) {
      dropped += 1
      continue
    }
    progress.push(picked)
  }

  return {
    version,
    exportedAt: Number.isFinite(Number(data.exportedAt)) ? Number(data.exportedAt) : 0,
    books,
    progress,
    settings: data.settings && typeof data.settings === 'object' ? { ...data.settings } : null,
    dropped,
  }
}

/**
 * 生成导入计划：按 id 合并。
 * - 本地没有这本书 → 写一条 `missing: true` 的占位记录（换手机后能恢复进度）
 * - 本地已有 → 只恢复进度，且取 `updatedAt` 较新者
 *
 * @param {{ localBooks?: object[], localProgress?: object[], backup: object }} input
 * @returns {{ bookOps: object[], progressOps: object[], placeholders: string[] }}
 */
export function planImport(input) {
  const localBooks = Array.isArray(input.localBooks) ? input.localBooks : []
  const localProgress = Array.isArray(input.localProgress) ? input.localProgress : []
  const backup = input.backup ?? {}

  const localById = new Map()
  for (const book of localBooks) {
    if (book?.id) localById.set(book.id, book)
  }
  const progressById = new Map()
  for (const item of localProgress) {
    if (item?.bookId) progressById.set(item.bookId, item)
  }

  const bookOps = []
  const placeholders = []
  for (const book of Array.isArray(backup.books) ? backup.books : []) {
    if (!book?.id) continue
    if (localById.has(book.id)) continue // 本地已有正文，不覆盖
    const placeholder = {
      id: book.id,
      title: book.title || '未命名',
      charCount: Number(book.charCount) || 0,
      byteSize: 0,
      encoding: 'utf-8',
      encodingConfidence: 'low',
      autoSplit: false,
      chapterCount: Number(book.chapterCount) || 0,
      addedAt: Number(book.addedAt) || 0,
      lastReadAt: Number(book.lastReadAt) || 0,
      missing: true,
      chapters: [],
    }
    bookOps.push({ type: 'placeholder', book: placeholder })
    placeholders.push(placeholder.title)
  }

  const progressOps = []
  for (const item of Array.isArray(backup.progress) ? backup.progress : []) {
    if (!item?.bookId) continue
    const existing = progressById.get(item.bookId)
    const incomingAt = Number(item.updatedAt) || 0
    const existingAt = Number(existing?.updatedAt) || 0
    if (existing && incomingAt <= existingAt) continue
    progressOps.push({ type: 'put', progress: pickProgressFields(item) })
  }

  return { bookOps, progressOps, placeholders }
}

/** 给人看的一句话摘要 */
export function summarizeImport(plan) {
  const books = plan?.bookOps?.length ?? 0
  const progress = plan?.progressOps?.length ?? 0
  if (books === 0 && progress === 0) return '备份里没有需要恢复的内容'
  const parts = []
  if (books > 0) parts.push(`${books} 本书的进度待重新导入原文件`)
  if (progress > 0) parts.push(`恢复了 ${progress} 条阅读进度`)
  return parts.join('，')
}

/**
 * 备份文件名：txt-reader-backup-2026-10-25.json
 * @param {number} [now]
 */
export function backupFileName(now = Date.now()) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `txt-reader-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`
}
