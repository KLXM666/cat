import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BACKUP_VERSION,
  BackupError,
  backupFileName,
  parseBackup,
  planImport,
  serializeBackup,
  summarizeImport,
} from '../src/backup.js'

const BOOK = {
  id: 'book-1',
  title: '斗破苍穹',
  charCount: 8123456,
  chapterCount: 812,
  addedAt: 1761328800000,
  lastReadAt: 1761415200000,
  // 备份里不该出现的东西
  text: '正文正文正文',
  chapters: [{ index: 0, title: '第一章', offset: 0, length: 10 }],
}

test('导出结构完整且不含正文', () => {
  const json = serializeBackup({
    books: [BOOK],
    progress: [{ bookId: 'book-1', chapterIndex: 29, chapterPercent: 0.47, updatedAt: 1761415200000 }],
    settings: { fontSize: 18, lineHeight: 1.8, theme: 'sepia' },
    now: 1761415200000,
  })
  const data = JSON.parse(json)

  assert.equal(data.version, BACKUP_VERSION)
  assert.equal(data.exportedAt, 1761415200000)
  assert.equal(data.books.length, 1)
  assert.equal(data.books[0].id, 'book-1')
  assert.equal(data.books[0].title, '斗破苍穹')
  assert.equal(data.books[0].chapterCount, 812)
  assert.equal(data.books[0].text, undefined, '备份不得包含正文')
  assert.equal(data.books[0].chapters, undefined, '备份不得包含 chapters')
  assert.equal(data.progress[0].chapterPercent, 0.47)
  assert.equal(data.settings.theme, 'sepia')
  assert.ok(json.length < 4096, `备份应保持在几 KB 量级，实际 ${json.length}`)
})

test('parseBackup 接受字符串与对象', () => {
  const json = serializeBackup({ books: [BOOK], progress: [], settings: null, now: 1 })
  assert.equal(parseBackup(json).books.length, 1)
  assert.equal(parseBackup(JSON.parse(json)).books.length, 1)
})

test('版本不匹配时拒绝', () => {
  assert.throws(
    () => parseBackup(JSON.stringify({ version: 99, books: [], progress: [] })),
    (error) => error instanceof BackupError && error.code === 'version-mismatch',
  )
})

test('非法 JSON / 空内容 / 缺版本号都拒绝', () => {
  assert.throws(() => parseBackup('{oops'), (error) => error.code === 'invalid-json')
  assert.throws(() => parseBackup(''), (error) => error.code === 'invalid')
  assert.throws(() => parseBackup(null), (error) => error.code === 'invalid')
  assert.throws(() => parseBackup(JSON.stringify({ books: [] })), (error) => error.code === 'invalid')
})

test('缺失 progress 字段容错为空数组', () => {
  const parsed = parseBackup(JSON.stringify({ version: BACKUP_VERSION, books: [BOOK] }))
  assert.deepEqual(parsed.progress, [])
  assert.equal(parsed.settings, null)
  assert.equal(parsed.books.length, 1)
})

test('缺失 books 字段容错为空数组', () => {
  const parsed = parseBackup(JSON.stringify({ version: BACKUP_VERSION, progress: [] }))
  assert.deepEqual(parsed.books, [])
})

test('无效条目被丢弃并计数', () => {
  const parsed = parseBackup(
    JSON.stringify({
      version: BACKUP_VERSION,
      books: [{ id: '' }, { id: 'ok', title: '书' }],
      progress: [{ bookId: '' }, { bookId: 'ok', chapterIndex: 2 }],
    }),
  )
  assert.equal(parsed.books.length, 1)
  assert.equal(parsed.progress.length, 1)
  assert.equal(parsed.dropped, 2)
})

test('planImport：本地已有同 id → 不写占位，只补进度', () => {
  const plan = planImport({
    localBooks: [{ id: 'book-1', title: '斗破苍穹' }],
    localProgress: [],
    backup: { books: [BOOK], progress: [{ bookId: 'book-1', chapterIndex: 5, chapterPercent: 0.2, updatedAt: 100 }] },
  })
  assert.deepEqual(plan.bookOps, [])
  assert.equal(plan.progressOps.length, 1)
  assert.equal(plan.progressOps[0].progress.chapterIndex, 5)
  assert.deepEqual(plan.placeholders, [])
})

test('planImport：本地没有这本书 → 写 missing:true 占位', () => {
  const plan = planImport({
    localBooks: [],
    localProgress: [],
    backup: { books: [BOOK], progress: [{ bookId: 'book-1', chapterIndex: 29, chapterPercent: 0.47, updatedAt: 100 }] },
  })
  assert.equal(plan.bookOps.length, 1)
  const placeholder = plan.bookOps[0].book
  assert.equal(placeholder.missing, true)
  assert.equal(placeholder.id, 'book-1')
  assert.equal(placeholder.title, '斗破苍穹')
  assert.deepEqual(placeholder.chapters, [])
  assert.equal(placeholder.byteSize, 0)
  assert.equal(plan.progressOps.length, 1)
  assert.deepEqual(plan.placeholders, ['斗破苍穹'])
})

test('planImport：同 id 取 updatedAt 较新者', () => {
  const newer = planImport({
    localBooks: [],
    localProgress: [{ bookId: 'book-1', chapterIndex: 1, chapterPercent: 0.1, updatedAt: 100 }],
    backup: { books: [], progress: [{ bookId: 'book-1', chapterIndex: 8, chapterPercent: 0.8, updatedAt: 200 }] },
  })
  assert.equal(newer.progressOps.length, 1)
  assert.equal(newer.progressOps[0].progress.chapterIndex, 8)

  const older = planImport({
    localBooks: [],
    localProgress: [{ bookId: 'book-1', chapterIndex: 8, chapterPercent: 0.8, updatedAt: 200 }],
    backup: { books: [], progress: [{ bookId: 'book-1', chapterIndex: 1, chapterPercent: 0.1, updatedAt: 100 }] },
  })
  assert.equal(older.progressOps.length, 0, '更旧的进度不应覆盖本地')
})

test('planImport：进度百分比被收敛', () => {
  const plan = planImport({
    localBooks: [],
    localProgress: [],
    backup: { books: [], progress: [{ bookId: 'x', chapterIndex: -3, chapterPercent: 9, updatedAt: 1 }] },
  })
  assert.equal(plan.progressOps[0].progress.chapterIndex, 0)
  assert.equal(plan.progressOps[0].progress.chapterPercent, 1)
})

test('summarizeImport 给出可读摘要', () => {
  assert.equal(summarizeImport({ bookOps: [], progressOps: [] }), '备份里没有需要恢复的内容')
  assert.match(summarizeImport({ bookOps: [{}], progressOps: [{}, {}] }), /1 本书.*2 条阅读进度/)
})

test('backupFileName 带日期', () => {
  const name = backupFileName(new Date(2026, 9, 25).getTime())
  assert.equal(name, 'txt-reader-backup-2026-10-25.json')
})
