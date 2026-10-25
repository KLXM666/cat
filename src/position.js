/**
 * 位置模型（KD-8）
 *
 * 纯函数：不碰 DOM。铁律是一律用**滚动容器自身**的 clientHeight，
 * 绝不用 window.innerHeight —— 手机地址栏收缩会让后者变化 60–100px，
 * 用它算比例会在滚动中出现位置漂移。
 */

/** 把任意数值收敛到 [0, 1]；非有限数按 0 处理 */
export function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/**
 * 滚动位置 → 章内百分比。
 * @param {number} scrollTop
 * @param {number} scrollHeight
 * @param {number} clientHeight
 * @returns {number} 0..1
 */
export function toPercent(scrollTop, scrollHeight, clientHeight) {
  const max = Math.max(0, (Number(scrollHeight) || 0) - (Number(clientHeight) || 0))
  // 内容不满一屏：无处可滚，恒为 0
  if (max === 0) return 0
  return clamp01((Number(scrollTop) || 0) / max)
}

/**
 * 章内百分比 → 滚动位置。
 * @param {number} percent
 * @param {number} scrollHeight
 * @param {number} clientHeight
 * @returns {number}
 */
export function toScrollTop(percent, scrollHeight, clientHeight) {
  const max = Math.max(0, (Number(scrollHeight) || 0) - (Number(clientHeight) || 0))
  return clamp01(percent) * max
}

/**
 * 校验并收敛一条进度记录，容错 IndexedDB 里的脏数据。
 * @param {{ chapterIndex?: unknown, chapterPercent?: unknown, updatedAt?: unknown }|null|undefined} progress
 * @param {number} chapterCount
 */
export function normalizeProgress(progress, chapterCount = Number.MAX_SAFE_INTEGER) {
  const rawIndex = Number(progress?.chapterIndex)
  const maxIndex = Math.max(0, (Number(chapterCount) || 1) - 1)
  const chapterIndex = Number.isFinite(rawIndex) ? Math.min(Math.max(0, Math.trunc(rawIndex)), maxIndex) : 0
  const chapterPercent = clamp01(Number(progress?.chapterPercent))
  const updatedAt = Number.isFinite(Number(progress?.updatedAt)) ? Number(progress.updatedAt) : 0
  return { chapterIndex, chapterPercent, updatedAt }
}
