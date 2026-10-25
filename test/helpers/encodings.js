/**
 * 测试专用编码工具。
 *
 * 浏览器与 Node 都没有内置的 GB18030 编码器（只有解码器），
 * 而测试需要"真的 GB18030 字节"。这里用解码器反向建表：
 * 遍历全部双字节组合（0x81–0xFE 引导 + 0x40–0xFE 尾随），
 * 把"解码结果 → 原始字节"记录下来，得到一个够用的编码器。
 *
 * 只用于构造 fixture，不参与运行时代码。
 */

let reverseTable = null

function buildReverseTable() {
  const table = new Map()
  const decoder = new TextDecoder('gb18030', { fatal: true })
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue
      let ch
      try {
        ch = decoder.decode(new Uint8Array([lead, trail]))
      } catch {
        continue
      }
      if (ch.length === 1 && !table.has(ch)) table.set(ch, [lead, trail])
    }
  }
  return table
}

/**
 * 把字符串编码成 GB18030 字节。
 * @param {string} text
 * @returns {Uint8Array}
 */
export function encodeGb18030(text) {
  if (!reverseTable) reverseTable = buildReverseTable()
  const out = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp < 0x80) {
      out.push(cp)
      continue
    }
    const pair = reverseTable.get(ch)
    if (!pair) throw new Error(`encodeGb18030: 无法编码字符 ${ch} (U+${cp.toString(16)})`)
    out.push(pair[0], pair[1])
  }
  return new Uint8Array(out)
}

/** UTF-16LE 字节（不含 BOM） */
export function encodeUtf16le(text) {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    out[i * 2] = code & 0xff
    out[i * 2 + 1] = (code >> 8) & 0xff
  }
  return out
}

/** UTF-16BE 字节（不含 BOM） */
export function encodeUtf16be(text) {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    out[i * 2] = (code >> 8) & 0xff
    out[i * 2 + 1] = code & 0xff
  }
  return out
}

/** UTF-8 字节 */
export function encodeUtf8(text) {
  return new TextEncoder().encode(text)
}

/** 拼接多段字节 */
export function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** 字节的 ArrayBuffer 副本（模拟 FileReader 结果） */
export function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}
