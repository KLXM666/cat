import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CHUNK_SIZE,
  buildFallbackChapters,
  isContiguous,
  matchChapterTitle,
  scanChapters,
} from '../src/chapters.js'

const TEXT = [
  '书名：测试之书',
  '作者：某人',
  '',
  '第一章 起点',
  '正文一。',
  '他在第三章里写道，事情并不简单。',
  '',
  '第二章 转折',
  '正文二。',
  '',
  '第三章 归途',
  '正文三。',
].join('\n')

test('常见标题格式都能识别', () => {
  const titles = [
    '第一章 陨落的天才',
    '第1章 陨落的天才',
    '第001章 陨落的天才',
    '第 12 章 空格分隔',
    '第一章：冒号分隔',
    '第一章、顿号',
    '第一回 楔子',
    '第1节 小节',
    '第十卷 风起',
    '卷一 风起',
    '番外一 后日谈',
    '番外 后日谈',
    '序章',
    '楔子',
    '引子',
    '前言',
    '终章',
    '尾声',
    '后记',
    '大结局',
  ]
  for (const title of titles) {
    assert.equal(matchChapterTitle(title), title, `应识别：${title}`)
  }
})

test('全半角缩进与空格不影响识别', () => {
  assert.equal(matchChapterTitle('\u3000\u3000第一章 陨落的天才'), '第一章 陨落的天才')
  assert.equal(matchChapterTitle('    第一章 陨落的天才'), '第一章 陨落的天才')
  assert.equal(matchChapterTitle('\u3000第一章\u3000陨落的天才'), '第一章\u3000陨落的天才')
  assert.equal(matchChapterTitle('正文 第一章 陨落的天才'), '第一章 陨落的天才')
})

test('正文引用"第三章"不得误匹配', () => {
  const cases = [
    '他在第三章里写道，事情并不简单。',
    '第三章的内容很精彩。',
    '第三章 他写道，事情并不简单。',
    '这一章我们要讲的是叙事结构。',
    '读第三章有感',
  ]
  for (const line of cases) {
    assert.equal(matchChapterTitle(line), null, `不应识别：${line}`)
  }
})

test('超长行不当作标题', () => {
  const long = `第一章 ${'很长的标题'.repeat(30)}`
  assert.equal(matchChapterTitle(long), null)
})

test('空行 / 空串返回 null', () => {
  assert.equal(matchChapterTitle(''), null)
  assert.equal(matchChapterTitle('   '), null)
  assert.equal(matchChapterTitle(null), null)
})

test('扫描：前置内容单独成章，正文里的引用不产生假章', () => {
  const { chapters, autoSplit } = scanChapters(TEXT)
  assert.equal(autoSplit, false)
  assert.deepEqual(
    chapters.map((chapter) => chapter.title),
    ['开篇', '第一章 起点', '第二章 转折', '第三章 归途'],
  )
  assert.ok(isContiguous(chapters, TEXT.length), '章节必须连续覆盖全文')
  assert.equal(chapters[0].offset, 0)
  assert.equal(chapters[0].length, TEXT.indexOf('第一章'))
})

test('正文引用"第三章"不会多出章节', () => {
  const text = '第一章 起点\n他在第三章里写道。\n第二章 转折\n正文。'
  const { chapters } = scanChapters(text)
  assert.equal(chapters.length, 2)
  assert.deepEqual(chapters.map((chapter) => chapter.title), ['第一章 起点', '第二章 转折'])
})

test('前置只有空行时并入第一章（offset 仍从 0 起）', () => {
  const text = '\n\n\u3000\n第一章 起点\n正文。\n第二章 转折\n正文。'
  const { chapters } = scanChapters(text)
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].title, '第一章 起点')
  assert.equal(chapters[0].offset, 0)
  assert.ok(isContiguous(chapters, text.length))
})

test('相邻标题产生零正文的短章也不丢字符', () => {
  const text = '第一章\n第二章\n正文。'
  const { chapters } = scanChapters(text)
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].length, '第一章\n'.length)
  assert.ok(isContiguous(chapters, text.length))
})

test('无章节标题时按 8000 字兜底并置 autoSplit', () => {
  const text = '无标题的正文内容。'.repeat(3000) // 24000 字
  const { chapters, autoSplit } = scanChapters(text)
  assert.equal(autoSplit, true)
  assert.equal(chapters.length, Math.ceil(text.length / DEFAULT_CHUNK_SIZE))
  assert.equal(chapters[0].title, '第 1 节')
  assert.equal(chapters[0].offset, 0)
  assert.ok(isContiguous(chapters, text.length))
})

test('命中数只有 1 个也走兜底（避免把书名当唯一章节）', () => {
  const text = '第一章 唯一\n正文。'
  const { chapters, autoSplit } = scanChapters(text)
  assert.equal(autoSplit, true)
  assert.equal(chapters.length, 1)
})

test('超长单行（无换行）也能兜底切块', () => {
  const text = '一'.repeat(20000)
  const { chapters, autoSplit } = scanChapters(text)
  assert.equal(autoSplit, true)
  assert.equal(chapters.length, 3)
  assert.ok(isContiguous(chapters, text.length))
})

test('空文本：没有章节也不报错', () => {
  assert.deepEqual(scanChapters(''), { chapters: [], autoSplit: false })
  assert.deepEqual(scanChapters(null), { chapters: [], autoSplit: false })
})

test('扫描进度回调：单调不减且收尾为 1 左右', () => {
  // 超过 2MB 才会触发进度回报（每 1MB 一次），这里造 400 万字
  const text = '第一章 起点\n' + '正文内容。'.repeat(400000) + '\n第二章 转折\n尾。'
  const ratios = []
  scanChapters(text, { onProgress: (ratio) => ratios.push(ratio) })
  assert.ok(ratios.length > 0, '大文件必须回报进度')
  for (let i = 1; i < ratios.length; i += 1) {
    assert.ok(ratios[i] >= ratios[i - 1], '进度必须单调不减')
  }
  assert.ok(ratios.at(-1) <= 1)
})

test('buildFallbackChapters：可以自定义块大小', () => {
  const chapters = buildFallbackChapters('abcdefghij', 4)
  assert.deepEqual(chapters, [
    { index: 0, title: '第 1 节', offset: 0, length: 4 },
    { index: 1, title: '第 2 节', offset: 4, length: 4 },
    { index: 2, title: '第 3 节', offset: 8, length: 2 },
  ])
  assert.deepEqual(buildFallbackChapters(''), [])
})
