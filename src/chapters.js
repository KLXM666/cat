/**
 * 章节切分（KD-5）
 *
 * 禁止使用 `text.split('\n')`（800 万字产生数十万字符串对象）与
 * 全局多分支正则（回溯不可控）。这里做的是**单遍、按索引、可回报进度**的扫描。
 *
 * 关键约束：标题必须**行首锚定**。否则正文里"他在第三章里写道"会被识别成章节，
 * 产生假章并让进度错乱——这是最容易漏的 bug。
 */

export const DEFAULT_CHUNK_SIZE = 8000
export const DEFAULT_MAX_TITLE_LENGTH = 60
/** 命中数少于这个值即视为"没识别到章节"，走固定字数兜底 */
export const MIN_TITLE_HITS = 2
/** 每扫描这么多字符回报一次进度（可中断/让出主线程的粒度） */
const PROGRESS_STEP = 1 << 20

const CN_NUM = '0-9０-９零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟'
const UNIT = '章节回卷集篇部幕话'
const SEPARATOR = '\\s:：.、\\-—－_·|'

/** 全部正则都是"整行 + 行首锚定"语义，在单行字符串上 test() */
const TITLE_PATTERNS = Object.freeze([
  // 第一章 / 第1章 / 第001章 / 第一回 / 第1节 / 第十卷
  new RegExp(`^第\\s*[${CN_NUM}]+\\s*[${UNIT}](?:[${SEPARATOR}]|$)`),
  // 卷一 / 卷1
  new RegExp(`^卷\\s*[${CN_NUM}]+(?:[${SEPARATOR}]|$)`),
  // 番外 / 番外一 / 番外 3
  new RegExp(`^番外(?:\\s*[${CN_NUM}]+|[${SEPARATOR}]|$)`),
  // 序章 / 楔子 / 引子 / 前言 / 终章 / 尾声 / 后记 / 大结局
  new RegExp(`^(?:序章|序言|楔子|引子|前言|终章|尾声|后记|大结局|完本感言)(?:[${SEPARATOR}]|$)`),
])

const LEADING_SPACE = /^[\s\u3000\u00a0]+/
const TRAILING_SPACE = /[\s\u3000\u00a0]+$/
/** 以句读符号结尾几乎必然是正文，用来进一步压掉"假标题" */
const SENTENCE_TAIL = /[。，；、]$/
const BODY_PREFIX = /^正文[\s:：]+/

/**
 * 判断一行（已去换行）是否章节标题，返回标题文本或 null。
 * @param {string} line
 * @param {{ maxTitleLength?: number }} [options]
 * @returns {string|null}
 */
export function matchChapterTitle(line, options = {}) {
  if (typeof line !== 'string' || line.length === 0) return null
  const maxTitleLength = options.maxTitleLength ?? DEFAULT_MAX_TITLE_LENGTH

  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1)
  let text = line.replace(LEADING_SPACE, '').replace(TRAILING_SPACE, '')
  if (!text) return null
  // 部分资源站会在标题前加"正文 "前缀
  text = text.replace(BODY_PREFIX, '')
  text = text.replace(TRAILING_SPACE, '')
  if (!text || text.length > maxTitleLength) return null
  if (SENTENCE_TAIL.test(text)) return null

  for (const pattern of TITLE_PATTERNS) {
    if (pattern.test(text)) return text
  }
  return null
}

/**
 * 固定字数兜底切块（KD-5 兜底策略）。
 * @param {string} text
 * @param {number} [chunkSize]
 */
export function buildFallbackChapters(text, chunkSize = DEFAULT_CHUNK_SIZE) {
  const chapters = []
  if (typeof text !== 'string' || text.length === 0) return chapters
  const size = Math.max(1, Math.floor(chunkSize) || DEFAULT_CHUNK_SIZE)
  for (let offset = 0, index = 0; offset < text.length; offset += size, index += 1) {
    chapters.push({
      index,
      title: `第 ${index + 1} 节`,
      offset,
      length: Math.min(size, text.length - offset),
    })
  }
  return chapters
}

/**
 * 单遍扫描章节。
 *
 * @param {string} text 原始解码文本（offsets 永远基于它，见 KD-4）
 * @param {{ fallbackChunkSize?: number, maxTitleLength?: number, onProgress?: (ratio:number)=>void }} [options]
 * @returns {{ chapters: Array<{index:number,title:string,offset:number,length:number}>, autoSplit: boolean }}
 */
export function scanChapters(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { chapters: [], autoSplit: false }
  }
  const maxTitleLength = options.maxTitleLength ?? DEFAULT_MAX_TITLE_LENGTH
  const fallbackChunkSize = options.fallbackChunkSize ?? DEFAULT_CHUNK_SIZE
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null

  const starts = []
  const length = text.length
  const rawGate = maxTitleLength + 16 // 行首缩进可能让原始行长超过标题长度
  let cursor = 0
  let lastReport = 0

  for (;;) {
    const newline = text.indexOf('\n', cursor)
    const lineEnd = newline === -1 ? length : newline
    const rawLength = lineEnd - cursor

    if (rawLength > 0 && rawLength <= rawGate) {
      const title = matchChapterTitle(text.slice(cursor, lineEnd), { maxTitleLength })
      if (title) starts.push({ offset: cursor, title })
    }

    if (onProgress && cursor - lastReport >= PROGRESS_STEP) {
      lastReport = cursor
      onProgress(cursor / length)
    }

    if (lineEnd >= length) break
    cursor = lineEnd + 1
  }

  if (starts.length < MIN_TITLE_HITS) {
    return { chapters: buildFallbackChapters(text, fallbackChunkSize), autoSplit: true }
  }
  return { chapters: buildChapters(text, starts), autoSplit: false }
}

/**
 * 由标题起点数组构造连续覆盖全文的章节列表。
 * @param {string} text
 * @param {Array<{offset:number,title:string}>} starts
 */
function buildChapters(text, starts) {
  const chapters = []
  const first = starts[0]

  if (first.offset > 0) {
    const preamble = text.slice(0, first.offset)
    if (preamble.trim().length > 0) {
      // 书名页/简介等前置内容单独成章
      chapters.push({ index: 0, title: '开篇', offset: 0, length: first.offset })
    } else {
      // 前置只有空行：并入第一章，保持 offset 从 0 起连续
      starts[0] = { ...first, offset: 0 }
    }
  }

  for (let k = 0; k < starts.length; k += 1) {
    const offset = starts[k].offset
    const end = k + 1 < starts.length ? starts[k + 1].offset : text.length
    chapters.push({
      index: chapters.length,
      title: starts[k].title,
      offset,
      length: end - offset,
    })
  }
  return chapters
}

/** 测试辅助：章节覆盖是否连续无缝（0 → text.length） */
export function isContiguous(chapters, textLength) {
  let expected = 0
  for (const chapter of chapters) {
    if (chapter.offset !== expected) return false
    expected += chapter.length
  }
  return expected === textLength
}
