/**
 * 导入管线（KD-6 / §2 数据流）
 *
 * 这个模块被两处共用：`ingest.worker.js`（主路径）与主线程降级路径 + 单测。
 * 它不碰 DOM、不碰 `self`、不自己开数据库——仓储由调用方注入，所以能在 Node 里跑。
 *
 * 进度阶段：decode 0→0.35，scan 0.35→0.6，store 0.6→1
 */

import { decode } from './decode.js'
import { scanChapters } from './chapters.js'
import { isQuotaError } from './store.js'

/** 硬性上限（产品文档 §6 失败路径 / KD-12） */
export const MAX_BYTES = 50 * 1024 * 1024

export const INGEST_PHASES = Object.freeze({
  decodeEnd: 0.35,
  scanEnd: 0.6,
  storeEnd: 1,
})

/**
 * 导入失败。`reason` 与 KD-6 的回报协议一致。
 * 注意：'decode-low-confidence' 不在失败集合里——低置信度仍然导入（§5.3），
 * 只在 meta 上标记 + 提供手动切换编码入口。
 */
export class IngestError extends Error {
  constructor(reason, message, detail = null) {
    super(message || reason)
    this.name = 'IngestError'
    this.reason = reason
    this.detail = detail
  }
}

/** 文件名 → 书名：取最后一段路径、去扩展名、空则"未命名" */
export function titleFromFileName(name) {
  const raw = typeof name === 'string' ? name : ''
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1)
  const withoutExt = base.replace(/\.[^.\\/]+$/, '')
  const title = withoutExt.trim()
  return title || '未命名'
}

/** 生成书籍 id（有 crypto.randomUUID 就用它，没有则退回随机串） */
export function createId() {
  const cryptoObj = globalThis.crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  if (cryptoObj?.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new IngestError('cancelled', '已取消导入')
}

function mapStorageError(error) {
  if (error instanceof IngestError) return error
  if (isQuotaError(error)) {
    return new IngestError('quota-exceeded', '存储空间不足，请删除旧书或清理浏览器数据', error?.message ?? null)
  }
  return new IngestError('storage-error', `写入本地存储失败：${error?.message ?? error}`, error?.message ?? null)
}

/**
 * 端到端导入：ArrayBuffer → 解码 → 切章 → 写库 → 返回小元数据（不含 text）。
 *
 * @param {{
 *   buffer: ArrayBuffer|Uint8Array,
 *   fileName?: string,
 *   byteSize?: number,
 *   repository: object,
 *   encoding?: string|null,
 *   now?: number,
 *   onProgress?: (p: { phase: 'decode'|'scan'|'store', ratio: number }) => void,
 *   signal?: { aborted: boolean },
 * }} options
 * @returns {Promise<object>} BookMeta（不含 text）
 */
export async function ingestBuffer(options) {
  const {
    buffer,
    fileName = '',
    repository,
    encoding = null,
    now = Date.now(),
    onProgress = () => {},
    signal = null,
  } = options

  if (!repository) throw new IngestError('storage-error', '缺少存储实现')

  const byteSize = Number(options.byteSize ?? buffer?.byteLength ?? 0) || 0
  if (byteSize === 0) throw new IngestError('empty', '文件为空')
  if (byteSize > MAX_BYTES) {
    throw new IngestError('too-large', `文件超过 ${MAX_BYTES / 1024 / 1024}MB 上限`)
  }

  assertNotCancelled(signal)
  onProgress({ phase: 'decode', ratio: 0 })

  const decoded = decode(buffer, encoding ? { encoding } : undefined)
  onProgress({ phase: 'decode', ratio: INGEST_PHASES.decodeEnd })

  const text = decoded.text
  if (!text || text.trim().length === 0) {
    throw new IngestError('empty', '文件没有有效文本')
  }

  assertNotCancelled(signal)

  const { chapters, autoSplit } = scanChapters(text, {
    onProgress: (ratio) => {
      onProgress({
        phase: 'scan',
        ratio: INGEST_PHASES.decodeEnd + ratio * (INGEST_PHASES.scanEnd - INGEST_PHASES.decodeEnd),
      })
    },
  })
  onProgress({ phase: 'scan', ratio: INGEST_PHASES.scanEnd })

  const meta = {
    id: createId(),
    title: titleFromFileName(fileName),
    charCount: text.length,
    byteSize,
    encoding: decoded.encoding,
    encodingConfidence: decoded.confidence,
    encodingReasons: [...decoded.reasons],
    autoSplit,
    chapterCount: chapters.length,
    addedAt: now,
    lastReadAt: now,
    missing: false,
    chapters,
  }

  assertNotCancelled(signal)
  onProgress({ phase: 'store', ratio: INGEST_PHASES.scanEnd + 0.02 })

  try {
    // 置信度低时保留原始字节，供"手动切换编码"重新解码（§5.3）
    const keepRaw = decoded.confidence === 'low' && (buffer?.byteLength ?? 0) > 0
    await repository.putBook(meta, text, keepRaw ? { raw: buffer } : {})
  } catch (error) {
    throw mapStorageError(error)
  }

  onProgress({ phase: 'store', ratio: INGEST_PHASES.storeEnd })
  return meta
}

/**
 * 手动切换编码：用保留下来的原始字节重新解码 + 重新切章，并迁移进度。
 * 坐标系统一原则（KD-4）：切章变了，进度按比例迁移，不假设 offset 有效。
 *
 * @param {{ repository: object, bookId: string, encoding: string, now?: number }} options
 * @returns {Promise<object>} 更新后的 BookMeta
 */
export async function reencodeBook(options) {
  const { repository, bookId, encoding, now = Date.now() } = options
  const meta = await repository.getBookMeta(bookId)
  if (!meta) throw new IngestError('storage-error', '书不存在')

  const raw = await repository.getRaw(bookId)
  if (!raw) {
    throw new IngestError('raw-unavailable', '原始文件已不可用，请重新导入这个 txt')
  }

  const decoded = decode(raw, { encoding })
  const text = decoded.text
  if (!text || text.trim().length === 0) throw new IngestError('empty', '按该编码解码后没有有效文本')

  const { chapters, autoSplit } = scanChapters(text)
  const next = {
    ...meta,
    encoding: decoded.encoding,
    encodingConfidence: decoded.confidence,
    encodingReasons: [...decoded.reasons],
    charCount: text.length,
    chapterCount: chapters.length,
    autoSplit,
    chapters,
    lastReadAt: now,
  }

  await repository.putBook(next, text, { raw })

  const progress = await repository.getProgress(bookId)
  if (progress) {
    const maxIndex = Math.max(0, chapters.length - 1)
    const chapterIndex = Math.min(Math.max(0, Math.trunc(Number(progress.chapterIndex) || 0)), maxIndex)
    await repository.putProgress({ ...progress, chapterIndex, updatedAt: now })
  }

  return next
}

/**
 * 把 IngestError.reason 翻成给人看的文案（书架/阅读器共用）。
 * @param {string} reason
 * @param {string|null} detail
 */
export function describeIngestFailure(reason, detail = null) {
  switch (reason) {
    case 'empty':
      return '文件为空或没有有效文本'
    case 'too-large':
      return `文件超过 ${MAX_BYTES / 1024 / 1024}MB 上限，无法导入`
    case 'quota-exceeded':
      return detail || '存储空间不足，请删除旧书或清理浏览器数据'
    case 'storage-error':
      return detail || '写入本地存储失败'
    case 'raw-unavailable':
      return detail || '原始文件已不可用，请重新导入这个 txt'
    case 'cancelled':
      return '已取消'
    case 'decode-low-confidence':
      return '编码可能识别有误'
    default:
      return detail || '导入失败'
  }
}
