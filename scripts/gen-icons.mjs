#!/usr/bin/env node
/**
 * 生成 PWA 位图图标（开发期一次性工具，不是构建步骤）
 *
 * 为什么需要它：iOS 只认 PNG 的 apple-touch-icon，SVG 无效；
 * 而项目零依赖，不能引入 canvas/sharp。所以这里手写一个最小 PNG 编码器
 * （只用到 node:zlib 的 deflateSync + 自己算 CRC32），把和 icon.svg 同款的
 * 图形按不同尺寸渲染成位图。
 *
 * 用法：node scripts/gen-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'icons')

// ───────────────────────────── PNG 编码 ─────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(size, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ───────────────────────────── 绘图 ─────────────────────────────

function createCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4) }
}

function hexToRgb(hex) {
  const value = hex.replace('#', '')
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
}

/** 把颜色以 alpha 叠加到某个像素上（超出画布就忽略） */
function blendPixel(canvas, x, y, rgb, alpha = 1) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return
  const index = (y * canvas.size + x) * 4
  const src = alpha
  const dst = canvas.data[index + 3] / 255
  const outAlpha = src + dst * (1 - src)
  for (let c = 0; c < 3; c += 1) {
    const srcColor = rgb[c]
    const dstColor = canvas.data[index + c]
    canvas.data[index + c] = outAlpha === 0 ? 0 : Math.round((srcColor * src + dstColor * dst * (1 - src)) / outAlpha)
  }
  canvas.data[index + 3] = Math.round(outAlpha * 255)
}

/**
 * 圆角矩形。superSample × superSample 超采样，边缘更顺滑。
 * @param {{minX:number, minY:number, maxX:number, maxY:number}} box 用 512 设计坐标
 */
function roundRect(canvas, box, radius, color, alpha = 1) {
  const scale = canvas.size / 512
  const rgb = hexToRgb(color)
  const x0 = box.minX * scale
  const y0 = box.minY * scale
  const x1 = box.maxX * scale
  const y1 = box.maxY * scale
  const r = radius * scale

  const superSample = 3
  const step = 1 / superSample
  const startX = Math.floor(x0)
  const endX = Math.ceil(x1)
  const startY = Math.floor(y0)
  const endY = Math.ceil(y1)

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      let hits = 0
      for (let sy = 0; sy < superSample; sy += 1) {
        for (let sx = 0; sx < superSample; sx += 1) {
          const px = x + (sx + 0.5) * step
          const py = y + (sy + 0.5) * step
          if (px < x0 || px > x1 || py < y0 || py > y1) continue
          // 圆角判定
          const dx = px < x0 + r ? x0 + r - px : px > x1 - r ? px - (x1 - r) : 0
          const dy = py < y0 + r ? y0 + r - py : py > y1 - r ? py - (y1 - r) : 0
          if (dx > 0 && dy > 0 && dx * dx + dy * dy > r * r) continue
          hits += 1
        }
      }
      if (hits > 0) blendPixel(canvas, x, y, rgb, (alpha * hits) / (superSample * superSample))
    }
  }
}

function drawIcon(size) {
  const canvas = createCanvas(size)
  const box = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY })

  roundRect(canvas, box(0, 0, 512, 512), 96, '#f5f1e8') // 背景
  roundRect(canvas, box(112, 92, 400, 420), 28, '#3a332c') // 书框（描边外沿）
  roundRect(canvas, box(128, 108, 384, 404), 12, '#fffdf8') // 书框内芯
  roundRect(canvas, box(164, 108, 180, 404), 0, '#8a5b34') // 书脊
  roundRect(canvas, box(212, 176, 348, 192), 8, '#8f8577') // 文字行 1
  roundRect(canvas, box(212, 236, 348, 252), 8, '#8f8577') // 文字行 2
  roundRect(canvas, box(212, 296, 308, 312), 8, '#8f8577') // 文字行 3

  return canvas
}

// ───────────────────────────── 输出 ─────────────────────────────

mkdirSync(OUT_DIR, { recursive: true })

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
]

for (const target of targets) {
  const canvas = drawIcon(target.size)
  const png = encodePng(target.size, canvas.data)
  writeFileSync(join(OUT_DIR, target.name), png)
  console.log(`写出 icons/${target.name}（${target.size}×${target.size}，${png.length} 字节）`)
}
