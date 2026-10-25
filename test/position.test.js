import test from 'node:test'
import assert from 'node:assert/strict'

import { clamp01, normalizeProgress, toPercent, toScrollTop } from '../src/position.js'

test('toPercent 基本换算', () => {
  assert.equal(toPercent(0, 1000, 500), 0)
  assert.equal(toPercent(500, 1000, 500), 1)
  assert.equal(toPercent(250, 1000, 500), 0.5)
})

test('toScrollTop 是 toPercent 的逆运算', () => {
  for (const percent of [0, 0.13, 0.5, 0.987, 1]) {
    const scrollTop = toScrollTop(percent, 3200, 700)
    assert.ok(Math.abs(toPercent(scrollTop, 3200, 700) - percent) < 1e-9)
  }
})

test('内容不满一屏（max === 0）时恒为 0', () => {
  assert.equal(toPercent(0, 400, 700), 0)
  assert.equal(toPercent(123, 400, 700), 0)
  assert.equal(toScrollTop(0.7, 400, 700), 0)
})

test('越界值被收敛', () => {
  assert.equal(toPercent(-100, 1000, 500), 0)
  assert.equal(toPercent(99999, 1000, 500), 1)
  assert.equal(toScrollTop(-1, 1000, 500), 0)
  assert.equal(toScrollTop(2, 1000, 500), 500)
})

test('0 与 1 边界', () => {
  assert.equal(toScrollTop(0, 1000, 500), 0)
  assert.equal(toScrollTop(1, 1000, 500), 500)
})

test('clamp01 处理非有限数', () => {
  assert.equal(clamp01(Number.NaN), 0)
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 0)
  assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0)
  assert.equal(clamp01(undefined), 0)
  assert.equal(clamp01(0.42), 0.42)
})

test('normalizeProgress：收敛脏数据', () => {
  assert.deepEqual(normalizeProgress(null, 10), { chapterIndex: 0, chapterPercent: 0, updatedAt: 0 })
  assert.deepEqual(normalizeProgress({ chapterIndex: 3.7, chapterPercent: 0.5, updatedAt: 123 }, 10), {
    chapterIndex: 3,
    chapterPercent: 0.5,
    updatedAt: 123,
  })
  assert.deepEqual(normalizeProgress({ chapterIndex: 999, chapterPercent: 2 }, 10), {
    chapterIndex: 9,
    chapterPercent: 1,
    updatedAt: 0,
  })
  assert.deepEqual(normalizeProgress({ chapterIndex: -5, chapterPercent: -1 }, 10), {
    chapterIndex: 0,
    chapterPercent: 0,
    updatedAt: 0,
  })
  assert.deepEqual(normalizeProgress({ chapterIndex: 'x', chapterPercent: 'y', updatedAt: 'z' }, 3), {
    chapterIndex: 0,
    chapterPercent: 0,
    updatedAt: 0,
  })
})
