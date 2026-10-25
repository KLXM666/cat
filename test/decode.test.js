import test from 'node:test'
import assert from 'node:assert/strict'

import { COMMON_HANZI_SIZE, MANUAL_ENCODINGS, assessText, decode } from '../src/decode.js'
import { concatBytes, encodeGb18030, encodeUtf16be, encodeUtf16le, encodeUtf8, toArrayBuffer } from './helpers/encodings.js'

const NOVEL = [
  '第一章 陨落的天才',
  '',
  '“斗之力，三段！”',
  '',
  '望着测验魔石碑上面闪亮得甚至有些刺眼的五个大字，少年面无表情，唇角有着一抹自嘲，紧握的手掌因为大力，而导致略微尖锐的指甲深深的刺进了掌心之中。',
  '',
  '“萧炎，斗之力，三段！级别：低级！”测验魔石碑之旁，一位中年男子，看了一眼碑上所显示出来的信息，语气漠然的将之公布了出来。',
  '',
  '少年缓缓抬起头来，露出一张有些清秀的稚嫩脸庞，漆黑的眸子木然的在周围那些嘲讽的同龄人身上扫过。',
].join('\n')

// §7.1 要求显式写一条环境断言：small-ICU 的 Node 会直接抛 RangeError，
// 那样所有中文用例都会莫名失败，不如在这里立刻给出准确报错。
test('runtime supports gb18030 decoder', () => {
  assert.doesNotThrow(() => new TextDecoder('gb18030'))
  assert.equal(new TextDecoder('gb18030').decode(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])), '中文')
})

test('runtime supports utf-16be decoder', () => {
  assert.doesNotThrow(() => new TextDecoder('utf-16be'))
})

test('常用字表足够大（打分依赖它）', () => {
  assert.ok(COMMON_HANZI_SIZE >= 400, `常用字表只有 ${COMMON_HANZI_SIZE} 字`)
})

test('手动切换入口只暴露三种编码', () => {
  assert.deepEqual([...MANUAL_ENCODINGS], ['utf-8', 'gb18030', 'utf-16le'])
})

test('UTF-8 BOM：识别为 utf-8，剥离 BOM，高置信度', () => {
  const bytes = concatBytes(new Uint8Array([0xef, 0xbb, 0xbf]), encodeUtf8(NOVEL))
  const result = decode(bytes)
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.confidence, 'high')
  assert.equal(result.text, NOVEL)
  assert.ok(result.reasons.includes('bom-utf8'))
  assert.equal(result.text.charCodeAt(0), 0x7b2c) // 第一章 的"第"，不是 U+FEFF
})

test('无 BOM 的 UTF-8：严格解码成功即高置信度', () => {
  const result = decode(encodeUtf8(NOVEL))
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.confidence, 'high')
  assert.equal(result.text, NOVEL)
  assert.ok(result.reasons.includes('utf8-strict'))
})

test('GB18030：回退解码正确且高置信度', () => {
  const result = decode(encodeGb18030(NOVEL))
  assert.equal(result.encoding, 'gb18030')
  assert.equal(result.confidence, 'high')
  assert.equal(result.text, NOVEL)
  assert.ok(result.reasons.includes('gb18030-fallback'))
})

test('UTF-16LE（带 BOM）：正确剥离 BOM', () => {
  const bytes = concatBytes(new Uint8Array([0xff, 0xfe]), encodeUtf16le(NOVEL))
  const result = decode(bytes)
  assert.equal(result.encoding, 'utf-16le')
  assert.equal(result.confidence, 'high')
  assert.equal(result.text, NOVEL)
})

test('UTF-16BE（带 BOM）：正确剥离 BOM', () => {
  const bytes = concatBytes(new Uint8Array([0xfe, 0xff]), encodeUtf16be(NOVEL))
  const result = decode(bytes)
  assert.equal(result.encoding, 'utf-16be')
  assert.equal(result.confidence, 'high')
  assert.equal(result.text, NOVEL)
})

test('纯 ASCII：走高置信度 utf-8 路径', () => {
  const text = 'hello world, plain english text without any chinese.'
  const result = decode(encodeUtf8(text))
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.confidence, 'high')
  assert.equal(result.text, text)
})

test('非法 UTF-8 触发 gb18030 回退', () => {
  // 0x81 0x30 是 GB18030 四字节序列的引导，不是合法 UTF-8
  const result = decode(encodeGb18030('中文小说'))
  assert.equal(result.encoding, 'gb18030')

  const invalidUtf8 = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2])
  const fallback = decode(invalidUtf8)
  assert.equal(fallback.encoding, 'gb18030')
  assert.equal(fallback.text, '第一章')
})

test('空文件：返回空文本，不抛错', () => {
  const result = decode(new Uint8Array(0))
  assert.equal(result.text, '')
  assert.equal(result.encoding, 'utf-8')
})

test('只有 BOM：返回空文本', () => {
  const result = decode(new Uint8Array([0xef, 0xbb, 0xbf]))
  assert.equal(result.text, '')
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.confidence, 'high')
})

test('低置信度样本：无 BOM 的 UTF-16LE 被误判为 GB18030 时必须报警', () => {
  const result = decode(encodeUtf16le(NOVEL))
  assert.equal(result.encoding, 'gb18030')
  assert.equal(result.confidence, 'low')
  assert.notEqual(result.text, NOVEL)
  // 至少命中一条"不对劲"的理由
  assert.ok(
    result.reasons.some((reason) =>
      ['replacement-characters', 'control-characters', 'low-common-hanzi-ratio', 'low-cjk-ratio'].includes(reason),
    ),
    `reasons=${result.reasons.join(',')}`,
  )
})

test('乱码字节：低置信度', () => {
  const bytes = new Uint8Array(Array.from({ length: 256 }, (_, index) => (index * 37 + 11) & 0xff))
  const result = decode(bytes)
  assert.equal(result.confidence, 'low')
})

test('强制编码：按 utf-16le 重新解码 UTF-16LE 正文', () => {
  const bytes = encodeUtf16le(NOVEL)
  const result = decode(bytes, { encoding: 'utf-16le' })
  assert.equal(result.encoding, 'utf-16le')
  assert.equal(result.text, NOVEL)
  assert.equal(result.confidence, 'high')
  assert.ok(result.reasons.includes('forced:utf-16le'))
})

test('强制编码用错：utf-8 强解 GB18030 字节 → 低置信度', () => {
  const result = decode(encodeGb18030(NOVEL), { encoding: 'utf-8' })
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.confidence, 'low')
  assert.ok(result.reasons.includes('replacement-characters'))
})

test('接受 ArrayBuffer 与 Uint8Array 两种入参', () => {
  const bytes = encodeUtf8('中文测试')
  const fromUint8 = decode(bytes)
  const fromBuffer = decode(toArrayBuffer(bytes))
  assert.equal(fromUint8.text, '中文测试')
  assert.equal(fromBuffer.text, '中文测试')
})

test('非法入参抛 TypeError', () => {
  assert.throws(() => decode('not a buffer'), TypeError)
  assert.throws(() => decode(null), TypeError)
})

test('assessText：可解释的统计量', () => {
  const assessment = assessText('这是一段中文正文，用于评估解码质量。')
  assert.equal(assessment.confidence, 'high')
  assert.ok(assessment.stats.cjkRatio > 0.4)
  assert.ok(assessment.stats.commonRatio > 0.6)
  assert.ok(assessment.stats.score >= 3)
})
