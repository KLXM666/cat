/**
 * 章级归一化（KD-4 / §5.4）
 *
 * 只在渲染单章时对**该章文本**执行，绝不生成归一化后的全文副本。
 * 所有会改变字符数的处理（去缩进、删广告行、压缩空行）都只允许发生在这里，
 * 因为 chapters[].offset/length 永远指向原始解码文本的坐标。
 *
 * 纯函数：不碰 DOM、不碰存储。
 */

/** 广告行特征（§5.4 第 4 条） */
export const AD_PATTERNS = Object.freeze([
  /本章未完/,
  /请收藏/,
  /www\./i,
  /https?:\/\//i,
  /最新网址/,
  /手机阅读/,
  /最新章节/,
  /全文阅读/,
  /请记住本站/,
  /百度搜索/,
  /笔趣阁/,
  /无弹窗/,
])

/** 广告行长度上限：超过这个长度不做过滤，避免误杀长正文 */
export const AD_MAX_LENGTH = 80

/** 空行密度阈值：高于它就认为"空行分段"，否则"每行一段" */
export const BLANK_RATIO_THRESHOLD = 0.3

/** 章首标题相似度阈值：高于它就把重复的标题行从正文剔除 */
export const TITLE_SIMILARITY_THRESHOLD = 0.8

const LEADING_INDENT = /^[\s\u3000\u00a0\u200b]+/
const TRAILING_SPACE = /[\s\u3000\u00a0\u200b]+$/
const COMPARE_STRIP = /[\s\u3000\u00a0\u200b:：,，.。;；!！?？、·\-—－_~～"'“”‘’()（）[\]【】《》<>…]/g
const CJK_RE = /[\u3400-\u9fff]/

/**
 * 把段落拆成"行内已清理"的单行文本。
 * @param {string} block
 */
function cleanParagraph(block) {
  if (typeof block !== 'string') return ''
  let text = block
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.replace(LEADING_INDENT, '').replace(TRAILING_SPACE, '')
  return text
}

/** 判断是否广告行：命中特征**且**行长 < 80，避免误杀正文 */
export function isAdLine(line) {
  if (typeof line !== 'string') return false
  const text = line.trim()
  if (!text || text.length >= AD_MAX_LENGTH) return false
  return AD_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * 文本相似度（0..1）：先归一化（去空白与标点），
 * 再做"前缀包含"快速判定，否则用二元组 Dice 系数。
 * @param {string} a
 * @param {string} b
 */
export function similarity(a, b) {
  const x = normalizeForCompare(a)
  const y = normalizeForCompare(b)
  if (!x || !y) return 0
  if (x === y) return 1

  const short = x.length <= y.length ? x : y
  const long = short === x ? y : x
  if (short.length >= 2 && long.startsWith(short) && short.length / long.length >= 0.5) return 1

  const bigrams = new Map()
  for (let i = 0; i < short.length - 1; i += 1) {
    const gram = short.slice(i, i + 2)
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1)
  }
  let hits = 0
  for (let i = 0; i < long.length - 1; i += 1) {
    const gram = long.slice(i, i + 2)
    const left = bigrams.get(gram) ?? 0
    if (left > 0) {
      hits += 1
      bigrams.set(gram, left - 1)
    }
  }
  const denominator = Math.max(0, short.length - 1) + Math.max(0, long.length - 1)
  if (denominator === 0) return 0
  return Math.min(1, (2 * hits) / denominator)
}

function normalizeForCompare(text) {
  return String(text ?? '').replace(COMPARE_STRIP, '').toLowerCase()
}

/**
 * 空行分段模式：按空行切块；块内的单换行视为排版折行，合并回一段。
 * @param {string} text
 */
function splitByBlankLine(text) {
  return text.split(/\n[ \t\u3000\u00a0]*\n+/).map((block) => {
    const lines = block
      .split('\n')
      .map((line) => line.replace(LEADING_INDENT, '').replace(TRAILING_SPACE, ''))
      .filter((line) => line.length > 0)
    if (lines.length <= 1) return lines[0] ?? ''
    const merged = lines.join('')
    // 中文合并无需空格；西文需要
    return CJK_RE.test(merged) ? merged : lines.join(' ')
  })
}

/**
 * 章级归一化。
 *
 * @param {string} rawText 该章的原始文本（含标题行）
 * @param {{ title?: string }} [options] 传入章节标题以剔除正文里重复的标题行
 * @returns {{ paragraphs: string[], isBlank: boolean }}
 */
export function normalizeChapter(rawText, options = {}) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return { paragraphs: [], isBlank: true }
  }
  const title = typeof options.title === 'string' ? options.title : ''

  // 1) 换行符统一
  const unified = rawText.replace(/\r\n?/g, '\n')

  // 2) 空行密度自适应分段
  const lines = unified.split('\n')
  let blankLines = 0
  for (const line of lines) {
    if (line.trim().length === 0) blankLines += 1
  }
  const blankRatio = lines.length > 0 ? blankLines / lines.length : 0
  const blocks = blankRatio > BLANK_RATIO_THRESHOLD ? splitByBlankLine(unified) : lines

  const paragraphs = []
  for (const block of blocks) {
    const cleaned = cleanParagraph(block)
    if (!cleaned) continue // 3) 压缩连续空行：空段直接成为段分隔
    if (isAdLine(cleaned)) continue // 4) 过滤广告行
    paragraphs.push(cleaned) // 5) 缩进已剥离，交给 CSS text-indent
  }

  // 6) 章首标题去重（offset 通常从标题行开始，直接渲染会让正文第一行重复标题）
  if (title && paragraphs.length > 0 && similarity(paragraphs[0], title) > TITLE_SIMILARITY_THRESHOLD) {
    paragraphs.shift()
  }

  return { paragraphs, isBlank: paragraphs.length === 0 }
}
