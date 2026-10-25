import test from 'node:test'
import assert from 'node:assert/strict'

import { AD_MAX_LENGTH, isAdLine, normalizeChapter, similarity } from '../src/normalize.js'

test('CRLF 与 CR 都归一化成 LF', () => {
  const crlf = normalizeChapter('第一段\r\n第二段\r\n第三段')
  assert.deepEqual(crlf.paragraphs, ['第一段', '第二段', '第三段'])

  const cr = normalizeChapter('第一段\r第二段\r第三段')
  assert.deepEqual(cr.paragraphs, ['第一段', '第二段', '第三段'])
})

test('每行一段（空行密度低于阈值）', () => {
  const raw = '第一章 开始\n他走进屋子。\n屋里很暗。\n他点亮了灯。'
  const result = normalizeChapter(raw, { title: '第一章 开始' })
  assert.deepEqual(result.paragraphs, ['他走进屋子。', '屋里很暗。', '他点亮了灯。'])
  assert.equal(result.isBlank, false)
})

test('空行分段：块内折行合并回一段', () => {
  const raw = ['第一段第一行', '第一段第二行', '', '第二段第一行', '第二段第二行', '', ''].join('\n')
  const result = normalizeChapter(raw)
  assert.deepEqual(result.paragraphs, ['第一段第一行第一段第二行', '第二段第一行第二段第二行'])
})

test('西文折行用空格连接', () => {
  // 空行率 2/6 > 阈值，走"空行分段"；块内折行按空格合并
  const raw = ['The quick brown', 'fox jumps over', '', 'the lazy dog and', 'then sleeps.', ''].join('\n')
  const result = normalizeChapter(raw)
  assert.deepEqual(result.paragraphs, ['The quick brown fox jumps over', 'the lazy dog and then sleeps.'])
})

test('剥离行首全角/半角缩进（交给 CSS text-indent）', () => {
  const result = normalizeChapter('\u3000\u3000第一段\n    第二段\n\t第三段')
  assert.deepEqual(result.paragraphs, ['第一段', '第二段', '第三段'])
})

test('压缩连续空行为段分隔', () => {
  const result = normalizeChapter('一\n\n\n\n\n二')
  assert.deepEqual(result.paragraphs, ['一', '二'])
})

test('广告行被过滤', () => {
  const raw = ['正文第一段。', '本章未完，请点击下一页继续阅读', '正文第二段。', '最新网址：www.example.com'].join('\n')
  const result = normalizeChapter(raw)
  assert.deepEqual(result.paragraphs, ['正文第一段。', '正文第二段。'])
})

test('广告行过滤不误杀长正文', () => {
  const longBody = `他想起那天看到的 www.example.com 页面，${'很长的一段正文内容。'.repeat(10)}`
  assert.ok(longBody.length >= AD_MAX_LENGTH)
  const result = normalizeChapter(longBody)
  assert.equal(result.paragraphs.length, 1)
  assert.equal(result.paragraphs[0], longBody.replace(/^[\s\u3000]+/, ''))
})

test('isAdLine 的边界：空串/长行/普通正文', () => {
  assert.equal(isAdLine(''), false)
  assert.equal(isAdLine('本章未完'), true)
  assert.equal(isAdLine(`请收藏${'补'.repeat(AD_MAX_LENGTH)}`), false)
  assert.equal(isAdLine('他收藏了一枚邮票'), false)
})

test('章首标题去重：标题行不再重复出现在正文', () => {
  const raw = '第一章 陨落的天才\n望着测验魔石碑上面闪亮得甚至有些刺眼的五个大字。'
  const result = normalizeChapter(raw, { title: '第一章 陨落的天才' })
  assert.deepEqual(result.paragraphs, ['望着测验魔石碑上面闪亮得甚至有些刺眼的五个大字。'])
})

test('章首标题去重：相似但带后缀也能识别', () => {
  const raw = '第一章 陨落的天才（求收藏）\n正文第一段。'
  const result = normalizeChapter(raw, { title: '第一章 陨落的天才' })
  assert.deepEqual(result.paragraphs, ['正文第一段。'])
})

test('章首标题去重：不相似时不误删', () => {
  const raw = '他缓缓抬起头来。\n正文第一段。'
  const result = normalizeChapter(raw, { title: '第一章 陨落的天才' })
  assert.equal(result.paragraphs.length, 2)
})

test('纯空白章：isBlank 为真', () => {
  const result = normalizeChapter('\n\n\u3000\u3000\n  \t\n')
  assert.deepEqual(result.paragraphs, [])
  assert.equal(result.isBlank, true)
})

test('空串与非法入参：isBlank 为真', () => {
  assert.deepEqual(normalizeChapter(''), { paragraphs: [], isBlank: true })
  assert.deepEqual(normalizeChapter(null), { paragraphs: [], isBlank: true })
  assert.deepEqual(normalizeChapter(undefined), { paragraphs: [], isBlank: true })
})

test('相似度：相同 / 前缀包含 / 明显不同', () => {
  assert.equal(similarity('第一章 陨落的天才', '第一章 陨落的天才'), 1)
  assert.ok(similarity('第一章 陨落的天才', '第一章 陨落的天才（求收藏）') > 0.8)
  assert.ok(similarity('第一章 陨落的天才', '他缓缓抬起头来。') < 0.3)
  assert.equal(similarity('', 'abc'), 0)
})
