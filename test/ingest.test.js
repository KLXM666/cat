import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IngestError,
  MAX_BYTES,
  createId,
  describeIngestFailure,
  ingestBuffer,
  reencodeBook,
  titleFromFileName,
} from '../src/ingest.js'
import { MemoryRepository } from '../src/store.js'
import { isContiguous } from '../src/chapters.js'
import { encodeGb18030, encodeUtf16le, encodeUtf8, toArrayBuffer } from './helpers/encodings.js'

const TEXT = [
  '第一章 陨落的天才',
  '',
  '“斗之力，三段！”',
  '',
  '望着测验魔石碑上面闪亮得甚至有些刺眼的五个大字，少年面无表情。',
  '',
  '第二章 斗气大陆',
  '',
  '这里是属于斗气的世界，没有花俏艳丽的魔法，有的，仅仅是繁衍到巅峰的斗气。',
  '',
  '第三章 客人',
  '',
  '“三年前，你可是家族里最耀眼的天才。”',
].join('\n')

function newRepository() {
  return new MemoryRepository()
}

function ingest(buffer, options = {}) {
  return ingestBuffer({
    buffer,
    fileName: options.fileName ?? '斗破苍穹.txt',
    repository: options.repository ?? newRepository(),
    now: options.now ?? 1761328800000,
    onProgress: options.onProgress,
  })
}

test('端到端：UTF-8 文本 → 元数据 + 章节 + 正文入库', async () => {
  const repository = newRepository()
  const buffer = toArrayBuffer(encodeUtf8(TEXT))
  const meta = await ingestBuffer({
    buffer,
    fileName: '斗破苍穹.txt',
    byteSize: buffer.byteLength,
    repository,
    now: 1761328800000,
  })

  assert.equal(meta.title, '斗破苍穹')
  assert.equal(meta.encoding, 'utf-8')
  assert.equal(meta.encodingConfidence, 'high')
  assert.equal(meta.charCount, TEXT.length)
  assert.equal(meta.byteSize, buffer.byteLength)
  assert.equal(meta.autoSplit, false)
  assert.equal(meta.chapterCount, 3)
  assert.equal(meta.missing, false)
  assert.equal(meta.addedAt, 1761328800000)
  assert.equal(meta.lastReadAt, 1761328800000)
  assert.equal(meta.text, undefined, 'meta 不得包含正文')
  assert.ok(isContiguous(meta.chapters, TEXT.length))

  const stored = await repository.getBookMeta(meta.id)
  assert.equal(stored.title, '斗破苍穹')

  const first = await repository.getChapterText(meta.id, 0)
  assert.ok(first.startsWith('第一章 陨落的天才'))
  const chapter = meta.chapters[1]
  const second = await repository.getChapterText(meta.id, 1)
  assert.equal(second, TEXT.slice(chapter.offset, chapter.offset + chapter.length))
  assert.ok(second.includes('斗气大陆'))
})

test('端到端：GB18030 文本正确解码入库', async () => {
  const repository = newRepository()
  const meta = await ingest(toArrayBuffer(encodeGb18030(TEXT)), { repository })
  assert.equal(meta.encoding, 'gb18030')
  assert.equal(meta.encodingConfidence, 'high')
  assert.equal(meta.chapterCount, 3)
  const text = await repository.getChapterText(meta.id, 2)
  assert.ok(text.includes('三年前'))
})

test('空文件被拒绝，reason=empty', async () => {
  await assert.rejects(
    () => ingest(new Uint8Array(0)),
    (error) => error instanceof IngestError && error.reason === 'empty',
  )
})

test('只有空白字符也视为空文件', async () => {
  await assert.rejects(
    () => ingest(encodeUtf8('\n\n\u3000\u3000\n')),
    (error) => error.reason === 'empty',
  )
})

test('超过 50MB 上限被拒绝（读之前就看 byteSize）', async () => {
  // 直接给 byteSize 模拟大文件，避免测试里真的分配 50MB
  await assert.rejects(
    () =>
      ingestBuffer({
        buffer: encodeUtf8('正文'),
        fileName: 'big.txt',
        byteSize: MAX_BYTES + 1,
        repository: newRepository(),
      }),
    (error) => error instanceof IngestError && error.reason === 'too-large',
  )
})

test('存储配额耗尽 → reason=quota-exceeded', async () => {
  const repository = newRepository()
  const quotaError = Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
  repository.failWith = quotaError
  await assert.rejects(
    () => ingest(encodeUtf8(TEXT), { repository }),
    (error) => error instanceof IngestError && error.reason === 'quota-exceeded',
  )
})

test('其他存储错误 → reason=storage-error', async () => {
  const repository = newRepository()
  repository.failWith = new Error('disk on fire')
  await assert.rejects(
    () => ingest(encodeUtf8(TEXT), { repository }),
    (error) => error.reason === 'storage-error',
  )
})

test('进度回调：阶段顺序正确且收尾到 1', async () => {
  const events = []
  await ingest(encodeUtf8(TEXT), { onProgress: (progress) => events.push(progress) })
  assert.ok(events.length >= 3)
  assert.equal(events[0].phase, 'decode')
  assert.equal(events.at(-1).phase, 'store')
  assert.equal(events.at(-1).ratio, 1)
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i].ratio >= events[i - 1].ratio, '进度必须单调不减')
  }
})

test('置信度低时保留原始字节，供手动切换编码', async () => {
  const repository = newRepository()
  const buffer = toArrayBuffer(encodeUtf16le(TEXT))
  const meta = await ingestBuffer({ buffer, fileName: 'utf16.txt', repository })
  assert.equal(meta.encodingConfidence, 'low')
  const raw = await repository.getRaw(meta.id)
  assert.ok(raw, '低置信度必须留存原始字节')
  assert.equal(raw.byteLength, buffer.byteLength)
})

test('高置信度不额外存原始字节', async () => {
  const repository = newRepository()
  const meta = await ingest(encodeUtf8(TEXT), { repository })
  assert.equal(meta.encodingConfidence, 'high')
  assert.equal(await repository.getRaw(meta.id), null)
})

test('reencodeBook：用留存的原始字节重新解码并重切章，进度保留', async () => {
  const repository = newRepository()
  const meta = await ingestBuffer({
    buffer: toArrayBuffer(encodeUtf16le(TEXT)),
    fileName: 'utf16.txt',
    repository,
  })
  await repository.putProgress({ bookId: meta.id, chapterIndex: 1, chapterPercent: 0.5, updatedAt: 1 })

  const next = await reencodeBook({ repository, bookId: meta.id, encoding: 'utf-16le', now: 2 })
  assert.equal(next.encoding, 'utf-16le')
  assert.equal(next.encodingConfidence, 'high')
  assert.equal(next.charCount, TEXT.length)
  // 误判的乱码文本认不出章节（走了兜底），重新解码后应恢复成真实的 3 章
  assert.equal(meta.autoSplit, true)
  assert.equal(next.autoSplit, false)
  assert.equal(next.chapterCount, 3)
  assert.ok(isContiguous(next.chapters, TEXT.length))

  const text = await repository.getChapterText(meta.id, 0)
  assert.ok(text.startsWith('第一章 陨落的天才'), '重新解码后正文应正常')

  const progress = await repository.getProgress(meta.id)
  assert.equal(progress.chapterIndex, 1)
  assert.equal(progress.chapterPercent, 0.5)
})

test('reencodeBook：原始字节已丢失时给出 raw-unavailable', async () => {
  const repository = newRepository()
  const meta = await ingest(encodeUtf8(TEXT), { repository })
  await assert.rejects(
    () => reencodeBook({ repository, bookId: meta.id, encoding: 'gb18030' }),
    (error) => error.reason === 'raw-unavailable',
  )
})

test('reencodeBook：书不存在时报错', async () => {
  await assert.rejects(
    () => reencodeBook({ repository: newRepository(), bookId: 'nope', encoding: 'utf-8' }),
    (error) => error instanceof IngestError,
  )
})

test('书名兜底：去扩展名、去路径、空名用"未命名"', () => {
  assert.equal(titleFromFileName('斗破苍穹.txt'), '斗破苍穹')
  assert.equal(titleFromFileName('C:\\Users\\me\\斗破苍穹.txt'), '斗破苍穹')
  assert.equal(titleFromFileName('/storage/emulated/0/Download/书.TXT'), '书')
  assert.equal(titleFromFileName(''), '未命名')
  assert.equal(titleFromFileName('.txt'), '未命名')
  assert.equal(titleFromFileName(null), '未命名')
  assert.equal(titleFromFileName('  带空格  .txt'), '带空格')
})

test('createId 生成唯一 id', () => {
  const ids = new Set(Array.from({ length: 50 }, () => createId()))
  assert.equal(ids.size, 50)
  assert.ok([...ids].every((id) => typeof id === 'string' && id.length >= 8))
})

test('describeIngestFailure 给出中文文案', () => {
  assert.match(describeIngestFailure('empty'), /没有有效文本/)
  assert.match(describeIngestFailure('too-large'), /50MB/)
  assert.match(describeIngestFailure('quota-exceeded'), /存储空间不足/)
  assert.match(describeIngestFailure('raw-unavailable'), /重新导入/)
  assert.equal(describeIngestFailure('unknown'), '导入失败')
})
