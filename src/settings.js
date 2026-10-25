/**
 * 阅读设置（KD-9）
 *
 * 为什么不用 IndexedDB：主题必须在**首帧之前**决定，否则暗色用户每次冷启动
 * 都会看到一次白屏闪烁。localStorage 是同步 API，早于首帧；indexedDB 是异步的。
 *
 * 这里只放三个小设置（< 100 字节），书籍与进度一律 IndexedDB。
 */

export const SETTINGS_DEFAULTS = Object.freeze({
  fontSize: 18,
  lineHeight: 1.8,
  theme: 'light',
})

export const SETTING_RANGES = Object.freeze({
  fontSize: { min: 14, max: 28, step: 1 },
  lineHeight: { min: 1.4, max: 2.2, step: 0.1 },
})

export const THEMES = Object.freeze(['light', 'dark', 'sepia'])

export const THEME_LABELS = Object.freeze({ light: '亮色', dark: '暗色', sepia: '护眼' })

const THEME_COLORS = Object.freeze({ light: '#ffffff', dark: '#14120f', sepia: '#f5f1e8' })

const STORAGE_KEYS = Object.freeze({
  fontSize: 'txt-reader:fontSize',
  lineHeight: 'txt-reader:lineHeight',
  theme: 'txt-reader:theme',
})

export const HINT_KEY = 'txt-reader:hintShown'

const listeners = new Set()

function readStored(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    // Safari 无痕模式下可能直接抛错
    return null
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** 收敛设置值到合法区间/枚举 */
export function clampSetting(key, value) {
  if (key === 'theme') {
    return THEMES.includes(value) ? value : SETTINGS_DEFAULTS.theme
  }
  const range = SETTING_RANGES[key]
  if (!range) return SETTINGS_DEFAULTS[key] ?? value
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return SETTINGS_DEFAULTS[key]
  const clamped = Math.min(range.max, Math.max(range.min, numeric))
  // 行距是 0.1 步进，避免 1.7999999
  return Math.round(clamped * 10) / 10
}

/** 从 localStorage 读全部设置（容错脏数据） */
export function loadSettings() {
  return {
    fontSize: clampSetting('fontSize', readStored(STORAGE_KEYS.fontSize)),
    lineHeight: clampSetting('lineHeight', readStored(STORAGE_KEYS.lineHeight)),
    theme: clampSetting('theme', readStored(STORAGE_KEYS.theme)),
  }
}

/**
 * 写一个设置并广播。
 * @returns {any} 收敛后的值
 */
export function saveSetting(key, value) {
  const normalized = clampSetting(key, value)
  if (!STORAGE_KEYS[key]) return normalized
  writeStored(STORAGE_KEYS[key], String(normalized))
  notify()
  return normalized
}

/** 批量写（备份恢复用） */
export function applyImportedSettings(settings) {
  if (!settings || typeof settings !== 'object') return loadSettings()
  if (settings.fontSize !== undefined) saveSetting('fontSize', settings.fontSize)
  if (settings.lineHeight !== undefined) saveSetting('lineHeight', settings.lineHeight)
  if (settings.theme !== undefined) saveSetting('theme', settings.theme)
  return loadSettings()
}

/**
 * 把设置落到 CSS 变量与 data-theme 上（只改变量，不重排结构）。
 * @param {{ fontSize:number, lineHeight:number, theme:string }} settings
 */
export function applySettings(settings, root = typeof document !== 'undefined' ? document.documentElement : null) {
  if (!root) return
  const value = { ...SETTINGS_DEFAULTS, ...(settings ?? {}) }
  root.dataset.theme = clampSetting('theme', value.theme)
  root.style.setProperty('--reader-font-size', `${clampSetting('fontSize', value.fontSize)}px`)
  root.style.setProperty('--reader-line-height', String(clampSetting('lineHeight', value.lineHeight)))
  // 手机浏览器地址栏/状态栏跟随主题
  const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="theme-color"]') : null
  if (meta) meta.setAttribute('content', THEME_COLORS[root.dataset.theme] ?? THEME_COLORS.light)
}

/** 订阅设置变化（主题需要同步到已挂载的视图） */
export function subscribeSettings(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify() {
  const settings = loadSettings()
  for (const listener of listeners) {
    try {
      listener(settings)
    } catch (error) {
      console.error('[settings] 监听器出错', error)
    }
  }
}

/** 安装引导是否已经展示过 */
export function isHintShown() {
  return readStored(HINT_KEY) === '1'
}

export function markHintShown() {
  writeStored(HINT_KEY, '1')
}
