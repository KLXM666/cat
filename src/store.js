/**
 * BookRepository 的 IndexedDB 实现 + 内存降级实现（KD-2 / KD-6 / KD-11 / §5.1）
 *
 * 存储四分开，`listBooks()` 绝不读正文：
 *   books(id)       元数据 + chapters 数组，不含 text
 *   texts(bookId)   全文
 *   progress(bookId) 阅读位置
 *   raws(bookId)    仅在"编码置信度低"时保留的原始字节（供手动切换编码重新解码）
 *
 * 为什么多一个 raws：手动切换编码必须有原始字节才能重新解码；正文经解码后
 * 无法反推字节。只在置信度低（极少见）时才存，代价可控。
 *
 * 读接口是**章级**的（KD-3），调用方不假设实现是整本还是分片。
 */

export const DB_NAME = 'txt-reader'
export const DB_VERSION = 1
export const STORE_BOOKS = 'books'
export const STORE_TEXTS = 'texts'
export const STORE_PROGRESS = 'progress'
export const STORE_RAWS = 'raws'

export class StorageError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'StorageError'
    this.cause = cause
  }
}

/** QuotaExceededError 在不同浏览器里名字不同 */
export function isQuotaError(error) {
  if (!error) return false
  const name = String(error.name ?? '')
  const message = String(error.message ?? '')
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    /quota/i.test(message)
  )
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new StorageError('IndexedDB 请求失败'))
  })
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new StorageError('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new StorageError('IndexedDB 事务被中止'))
  })
}

/**
 * 打开数据库（幂等）。四个 store 都在 version 1 里建好。
 * @param {IDBFactory} factory
 */
export function openDatabase(factory = globalThis.indexedDB) {
  if (!factory) return Promise.reject(new StorageError('当前环境没有 indexedDB'))
  const request = factory.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(STORE_BOOKS)) db.createObjectStore(STORE_BOOKS, { keyPath: 'id' })
    if (!db.objectStoreNames.contains(STORE_TEXTS)) db.createObjectStore(STORE_TEXTS, { keyPath: 'bookId' })
    if (!db.objectStoreNames.contains(STORE_PROGRESS)) db.createObjectStore(STORE_PROGRESS, { keyPath: 'bookId' })
    if (!db.objectStoreNames.contains(STORE_RAWS)) db.createObjectStore(STORE_RAWS, { keyPath: 'bookId' })
  }
  return requestToPromise(request)
}

function sortBooks(books) {
  return [...books].sort(
    (a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || (b.addedAt || 0) - (a.addedAt || 0),
  )
}

/**
 * 内存实现：Safari 无痕 / IndexedDB 不可用时的降级（KD-11），也是单测里的桩。
 */
export class MemoryRepository {
  constructor(seed = {}) {
    this.kind = 'memory'
    this.books = new Map()
    this.texts = new Map()
    this.progress = new Map()
    this.raws = new Map()
    for (const book of seed.books ?? []) this.books.set(book.id, { ...book })
    for (const [id, text] of seed.texts ?? []) this.texts.set(id, text)
    for (const item of seed.progress ?? []) this.progress.set(item.bookId, { ...item })
    // 用于测试配额失败路径
    this.failWith = null
  }

  async listBooks() {
    this.maybeFail()
    return sortBooks(this.books.values())
  }

  async getBookMeta(id) {
    this.maybeFail()
    const book = this.books.get(id)
    return book ? { ...book } : null
  }

  async listProgress() {
    this.maybeFail()
    return [...this.progress.values()].map((item) => ({ ...item }))
  }

  async getProgress(id) {
    this.maybeFail()
    const item = this.progress.get(id)
    return item ? { ...item } : null
  }

  async getChapterText(id, chapterIndex) {
    this.maybeFail()
    const book = this.books.get(id)
    const chapter = book?.chapters?.[chapterIndex]
    if (!chapter) return ''
    const text = this.texts.get(id) ?? ''
    return text.slice(chapter.offset, chapter.offset + chapter.length)
  }

  async getRaw(id) {
    this.maybeFail()
    return this.raws.get(id) ?? null
  }

  async putBook(meta, text, options = {}) {
    this.maybeFail()
    this.books.set(meta.id, { ...meta })
    this.texts.set(meta.id, text ?? '')
    if (options.raw) this.raws.set(meta.id, options.raw)
    return undefined
  }

  async updateBookMeta(meta) {
    this.maybeFail()
    this.books.set(meta.id, { ...meta })
  }

  async putProgress(progress) {
    this.maybeFail()
    this.progress.set(progress.bookId, { ...progress })
  }

  async deleteBook(id) {
    this.maybeFail()
    this.books.delete(id)
    this.texts.delete(id)
    this.progress.delete(id)
    this.raws.delete(id)
  }

  maybeFail() {
    if (this.failWith) throw this.failWith
  }
}

/**
 * IndexedDB 实现。`ready()` 之后才可用。
 */
export class IndexedDbRepository {
  constructor(options = {}) {
    this.kind = 'indexeddb'
    this.factory = options.indexedDb ?? globalThis.indexedDB
    this.db = null
    this.textCache = null
  }

  async ready() {
    this.db = await openDatabase(this.factory)
    return this
  }

  requireDb() {
    if (!this.db) throw new StorageError('IndexedDbRepository 尚未 ready()')
    return this.db
  }

  async listBooks() {
    const db = this.requireDb()
    const tx = db.transaction(STORE_BOOKS, 'readonly')
    // 只读 books：绝不在书架路径上碰 texts，否则每本书十几 MB 全被结构化克隆进内存
    const books = await requestToPromise(tx.objectStore(STORE_BOOKS).getAll())
    await transactionDone(tx)
    return sortBooks(books)
  }

  async getBookMeta(id) {
    const db = this.requireDb()
    const tx = db.transaction(STORE_BOOKS, 'readonly')
    const book = await requestToPromise(tx.objectStore(STORE_BOOKS).get(id))
    await transactionDone(tx)
    return book ?? null
  }

  async listProgress() {
    const db = this.requireDb()
    const tx = db.transaction(STORE_PROGRESS, 'readonly')
    const items = await requestToPromise(tx.objectStore(STORE_PROGRESS).getAll())
    await transactionDone(tx)
    return items
  }

  async getProgress(id) {
    const db = this.requireDb()
    const tx = db.transaction(STORE_PROGRESS, 'readonly')
    const item = await requestToPromise(tx.objectStore(STORE_PROGRESS).get(id))
    await transactionDone(tx)
    return item ?? null
  }

  /** 整本读一次并缓存（V8 的 sliced string 与原文共享底层存储，切章是 O(1)） */
  async readText(id) {
    if (this.textCache && this.textCache.id === id) return this.textCache.text
    const db = this.requireDb()
    const tx = db.transaction(STORE_TEXTS, 'readonly')
    const record = await requestToPromise(tx.objectStore(STORE_TEXTS).get(id))
    await transactionDone(tx)
    const text = record?.text ?? ''
    this.textCache = { id, text }
    return text
  }

  async getChapterText(id, chapterIndex) {
    const book = await this.getBookMeta(id)
    const chapter = book?.chapters?.[chapterIndex]
    if (!chapter) return ''
    const text = await this.readText(id)
    return text.slice(chapter.offset, chapter.offset + chapter.length)
  }

  async getRaw(id) {
    const db = this.requireDb()
    const tx = db.transaction(STORE_RAWS, 'readonly')
    const record = await requestToPromise(tx.objectStore(STORE_RAWS).get(id))
    await transactionDone(tx)
    return record?.raw ?? null
  }

  /** 批量写入用单个 transaction 包住（KD-6：否则慢一个数量级） */
  async putBook(meta, text, options = {}) {
    const db = this.requireDb()
    const stores = [STORE_BOOKS, STORE_TEXTS]
    if (options.raw) stores.push(STORE_RAWS)
    const tx = db.transaction(stores, 'readwrite')
    tx.objectStore(STORE_BOOKS).put(meta)
    tx.objectStore(STORE_TEXTS).put({ bookId: meta.id, text: text ?? '' })
    if (options.raw) tx.objectStore(STORE_RAWS).put({ bookId: meta.id, raw: options.raw })
    await transactionDone(tx)
    this.textCache = null
  }

  async updateBookMeta(meta) {
    const db = this.requireDb()
    const tx = db.transaction(STORE_BOOKS, 'readwrite')
    tx.objectStore(STORE_BOOKS).put(meta)
    await transactionDone(tx)
  }

  async putProgress(progress) {
    const db = this.requireDb()
    const tx = db.transaction(STORE_PROGRESS, 'readwrite')
    tx.objectStore(STORE_PROGRESS).put(progress)
    await transactionDone(tx)
  }

  /** 级联删除：books / texts / progress / raws 必须在同一个 transaction 内（§5.1） */
  async deleteBook(id) {
    const db = this.requireDb()
    const tx = db.transaction([STORE_BOOKS, STORE_TEXTS, STORE_PROGRESS, STORE_RAWS], 'readwrite')
    tx.objectStore(STORE_BOOKS).delete(id)
    tx.objectStore(STORE_TEXTS).delete(id)
    tx.objectStore(STORE_PROGRESS).delete(id)
    tx.objectStore(STORE_RAWS).delete(id)
    await transactionDone(tx)
    if (this.textCache?.id === id) this.textCache = null
  }
}

/**
 * 创建仓储：优先 IndexedDB，失败则显式降级内存模式（调用方必须提示用户）。
 * @param {{ indexedDb?: IDBFactory }} [options]
 * @returns {Promise<{ repository: object, kind: 'indexeddb'|'memory', degraded: boolean, reason: string|null }>}
 */
export async function createRepository(options = {}) {
  const factory = options.indexedDb ?? globalThis.indexedDB
  if (!factory) {
    return {
      repository: new MemoryRepository(),
      kind: 'memory',
      degraded: true,
      reason: 'indexeddb-unavailable',
    }
  }
  try {
    const repository = await new IndexedDbRepository({ indexedDb: factory }).ready()
    return { repository, kind: 'indexeddb', degraded: false, reason: null }
  } catch (error) {
    return {
      repository: new MemoryRepository(),
      kind: 'memory',
      degraded: true,
      reason: error?.message ?? 'indexeddb-open-failed',
    }
  }
}

/**
 * 静默申请持久化存储（KD-11 第 1 道防线）。失败不打扰用户。
 * @returns {Promise<boolean>}
 */
export async function requestPersistence() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/**
 * 当前占用 / 配额（KD-11 配额提示用）。
 * @returns {Promise<{ usage:number, quota:number }|null>}
 */
export async function estimateUsage() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota }
  } catch {
    return null
  }
}
