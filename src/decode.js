/**
 * 编码探测（§5.3 / KD-12）
 *
 * 纯函数：不碰 DOM、不碰 indexedDB、不碰 self，可直接在 Node 里 import 测试。
 *
 * 探测顺序不可调：
 *   1. EF BB BF → utf-8（剥离 BOM）
 *   2. FF FE    → utf-16le（剥离 BOM）
 *   3. FE FF    → utf-16be（剥离 BOM）
 *   4. utf-8 + fatal:true 成功 → utf-8
 *   5. 回退 gb18030 并做置信度打分
 *
 * 为什么第 5 步不是"两种都失败"：gb18030 是全覆盖编码，几乎任何字节序列都能解码
 * 成功，真正的风险是**静默解错**（拿 GB18030 去解 UTF-16LE 会得到满屏无意义汉字，
 * 且不报错）。所以失败路径改成了打分 + 手动切换（见 §5.3）。
 */

/** 抽样长度：首/中/尾各取这么多字符做打分（规范写 4KB，按字符取等效量级） */
const SAMPLE_CHARS = 4096

/** 常用汉字高频集（约 500 字），用于评估解码结果"像不像中文" */
const COMMON_HANZI =
  '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要' +
  '她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当' +
  '没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手' +
  '又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被' +
  '高已亲其进此话常与活正感见明问力理点文几定本公特做外孩相西果走将' +
  '月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等' +
  '体却加电主界门利海受听表德少克代员许先口由死安写性马光白或住难望' +
  '教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入笑内' +
  '英军候民岁往何度山觉路带万男边风解叫任金快原吃妈变通师立象数四失' +
  '满战远格士音轻目条呢病始达深完今提求清王化空业思切怎非找片罗钱吗' +
  '语元喜曾离飞科言干流欢约各即指合反题必该论交终林请医晚制球决传画' +
  '保读运及则房早院量苦火布品近坐产答星精视五连司巴奇管类未朋且婚台' +
  '夜青北队久乎越观落尽形影红爸百令周吧识步希亚术留市半热送兴造谈容' +
  '极随演收首根讲整式取照办强石古华拿计您装算义修群称按值座客织底需' +
  '推联差族备单段静照附近历低排广切温存批试渐亮巨系社切习交信越'

const COMMON_SET = new Set(COMMON_HANZI)

/** 支持的编码；手动切换入口只暴露这三个（§5.3） */
export const MANUAL_ENCODINGS = Object.freeze(['utf-8', 'gb18030', 'utf-16le'])

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * 把入参统一成 Uint8Array。
 * @param {ArrayBuffer|Uint8Array|ArrayBufferView} input
 * @returns {Uint8Array}
 */
function toBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new TypeError('decode() 需要 ArrayBuffer 或 Uint8Array')
}

function startsWithBytes(bytes, pattern) {
  if (bytes.length < pattern.length) return false
  for (let i = 0; i < pattern.length; i += 1) {
    if (bytes[i] !== pattern[i]) return false
  }
  return true
}

function decodeWith(bytes, encoding) {
  // ignoreBOM: 先自行处理并剥离 BOM，避免解码器再吃掉正文里合法的 U+FEFF
  return new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(bytes)
}

/** 首/中/尾各取 SAMPLE_CHARS 个字符，避免为打分遍历全文 */
function sampleText(text) {
  const len = text.length
  if (len <= SAMPLE_CHARS * 3) return text
  const mid = Math.floor((len - SAMPLE_CHARS) / 2)
  return text.slice(0, SAMPLE_CHARS) + text.slice(mid, mid + SAMPLE_CHARS) + text.slice(len - SAMPLE_CHARS)
}

/**
 * 置信度打分（§5.3 表格）。
 * @param {string} text
 * @returns {{ confidence: 'high'|'low', reasons: string[], stats: object }}
 */
export function assessText(text) {
  const sample = sampleText(text)
  const stats = {
    sampled: 0,
    cjk: 0,
    common: 0,
    rare: 0,
    privateUse: 0,
    replacement: 0,
    control: 0,
    printableAscii: 0,
  }

  for (const ch of sample) {
    const cp = ch.codePointAt(0)
    stats.sampled += 1
    if (cp === 0xfffd) {
      stats.replacement += 1
      continue
    }
    if (cp < 0x20 || cp === 0x7f) {
      // \t \n \r 是正常换行/缩进，不算控制字符噪声
      if (ch !== '\n' && ch !== '\t' && ch !== '\r') stats.control += 1
      continue
    }
    if (cp >= 0x4e00 && cp <= 0x9fff) {
      stats.cjk += 1
      if (COMMON_SET.has(ch)) stats.common += 1
    } else if ((cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2ffff)) {
      stats.rare += 1
    } else if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0x10ffff)) {
      stats.privateUse += 1
    } else if (cp >= 0x20 && cp < 0x7f) {
      stats.printableAscii += 1
    }
  }

  const total = stats.sampled || 1
  const cjkRatio = stats.cjk / total
  const commonRatio = stats.cjk > 0 ? stats.common / stats.cjk : 0
  const rareRatio = stats.rare / total
  const privateRatio = stats.privateUse / total
  const asciiRatio = stats.printableAscii / total

  const reasons = []
  let score = 0

  if (stats.replacement > 0) reasons.push('replacement-characters')
  if (stats.control > 0) reasons.push('control-characters')

  if (cjkRatio >= 0.4) score += 2
  else if (cjkRatio >= 0.15) {
    score += 1
    reasons.push('low-cjk-ratio')
  } else reasons.push('low-cjk-ratio')

  if (commonRatio >= 0.6) score += 2
  else if (commonRatio >= 0.4) {
    score += 1
    reasons.push('low-common-hanzi-ratio')
  } else reasons.push('low-common-hanzi-ratio')

  if (privateRatio > 0.02) {
    score -= 2
    reasons.push('private-use-characters')
  }
  if (rareRatio > 0.3) {
    score -= 1
    reasons.push('rare-hanzi')
  }

  // 纯 ASCII 正文（英文 txt）：gb18030 与 utf-8 对 ASCII 完全一致，无需恐慌
  const asciiOnly = asciiRatio >= 0.85 && stats.cjk === 0 && stats.replacement === 0 && stats.control === 0
  if (asciiOnly) reasons.push('ascii-only')

  const hardFail = stats.replacement > 0 || stats.control > 0
  const confidence = !hardFail && (score >= 3 || asciiOnly) ? 'high' : 'low'

  return {
    confidence,
    reasons: Object.freeze(reasons),
    stats: Object.freeze({
      ...stats,
      cjkRatio: Number(cjkRatio.toFixed(4)),
      commonRatio: Number(commonRatio.toFixed(4)),
      score,
    }),
  }
}

/**
 * 编码探测 + 解码。
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{ encoding?: string }} [options] 传入 encoding 表示强制按该编码解码（手动切换用）
 * @returns {{ text: string, encoding: string, confidence: 'high'|'low', reasons: string[] }}
 */
export function decode(buffer, options = {}) {
  const bytes = toBytes(buffer)
  const forced = options.encoding

  if (forced) {
    const text = stripLeadingBom(decodeWith(bytes, forced))
    const assessment = assessText(text)
    return {
      text,
      encoding: forced,
      confidence: assessment.confidence,
      reasons: Object.freeze([`forced:${forced}`, ...assessment.reasons]),
    }
  }

  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) {
    return {
      text: decodeWith(bytes.subarray(3), 'utf-8'),
      encoding: 'utf-8',
      confidence: 'high',
      reasons: Object.freeze(['bom-utf8']),
    }
  }

  if (startsWithBytes(bytes, [0xff, 0xfe])) {
    return {
      text: stripLeadingBom(decodeWith(bytes.subarray(2), 'utf-16le')),
      encoding: 'utf-16le',
      confidence: 'high',
      reasons: Object.freeze(['bom-utf16le']),
    }
  }

  if (startsWithBytes(bytes, [0xfe, 0xff])) {
    return {
      text: stripLeadingBom(decodeWith(bytes.subarray(2), 'utf-16be')),
      encoding: 'utf-16be',
      confidence: 'high',
      reasons: Object.freeze(['bom-utf16be']),
    }
  }

  let utf8Text = null
  try {
    utf8Text = UTF8_STRICT.decode(bytes)
  } catch {
    // 非严格合法 UTF-8，走 gb18030 回退打分
  }

  if (utf8Text !== null) {
    return {
      text: stripLeadingBom(utf8Text),
      encoding: 'utf-8',
      confidence: 'high',
      reasons: Object.freeze(['utf8-strict']),
    }
  }

  const text = stripLeadingBom(decodeWith(bytes, 'gb18030'))
  const assessment = assessText(text)
  return {
    text,
    encoding: 'gb18030',
    confidence: assessment.confidence,
    reasons: Object.freeze(['gb18030-fallback', ...assessment.reasons]),
  }
}

function stripLeadingBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 供测试与调试：探测结果的统计量 */
export function inspectBuffer(buffer) {
  const decoded = decode(buffer)
  return { ...decoded, stats: assessText(decoded.text).stats }
}

export const COMMON_HANZI_SIZE = COMMON_SET.size
