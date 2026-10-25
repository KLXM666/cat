/**
 * 启动与 hash 路由（GitHub Pages 没有服务端重写，路由必须走 hash，见 KD-14）
 *
 *   #/shelf           书架
 *   #/read/:id        阅读
 */

import { createRepository, requestPersistence } from './store.js'
import { Bookshelf } from './bookshelf.js'
import { Reader } from './reader.js'
import { applySettings, loadSettings, subscribeSettings } from './settings.js'
import { clear, showToast } from './ui.js'

// 模块能执行到这里，说明 ES module 正常（不是 file:// 被拦、也不是 404）。
// index.html 里的启动兜底靠这个标记决定要不要报错。
document.documentElement.dataset.booted = '1'

const app = document.getElementById('app')

const state = {
  repository: null,
  view: null,
  settings: loadSettings(),
  hadController: Boolean(navigator.serviceWorker?.controller),
}

function navigate(hash) {
  if (location.hash === hash) {
    void route()
    return
  }
  location.hash = hash
}

function destroyView() {
  const view = state.view
  state.view = null
  if (view && typeof view.destroy === 'function') view.destroy()
  clear(app)
}

async function showShelf() {
  destroyView()
  const shelf = new Bookshelf({
    mount: app,
    repository: state.repository,
    openBook: (id) => navigate(`#/read/${encodeURIComponent(id)}`),
  })
  state.view = shelf
  await shelf.open()
}

async function showReader(bookId) {
  let meta = null
  try {
    meta = await state.repository.getBookMeta(bookId)
  } catch (error) {
    console.error('[main] 读取书籍失败', error)
    showToast('读取这本书失败')
    navigate('#/shelf')
    return
  }
  if (!meta) {
    showToast('这本书不存在了')
    navigate('#/shelf')
    return
  }
  if (meta.missing) {
    showToast('这本书只剩进度记录，请重新导入原 txt')
    navigate('#/shelf')
    return
  }

  destroyView()
  const reader = new Reader({
    mount: app,
    repository: state.repository,
    meta,
    onExit: () => navigate('#/shelf'),
  })
  state.view = reader
  await reader.open()
}

async function route() {
  if (!state.repository) return
  const raw = location.hash || '#/shelf'
  const match = /^#\/read\/(.+)$/.exec(raw)
  if (match) {
    let id = match[1]
    try {
      id = decodeURIComponent(id)
    } catch {
      // 保持原样
    }
    await showReader(id)
    return
  }
  await showShelf()
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker
    .register('./sw.js', { updateViaCache: 'none' })
    .then((registration) => registration.update?.())
    .catch((error) => console.warn('[main] Service Worker 注册失败', error))

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 首次安装也会触发；只有"本来就有 controller"才是更新
    if (!state.hadController) {
      state.hadController = true
      return
    }
    // 不自动 reload：会打断阅读，还要重走一次位置恢复
    showToast('已更新，重新打开后生效', { duration: 4000 })
  })
}

async function boot() {
  // 阻止 Safari 自己的滚动恢复与我们的 scrollTop 赋值对冲（KD-8 第 1 步）
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

  applySettings(state.settings)
  subscribeSettings((settings) => {
    state.settings = settings
    applySettings(settings)
  })

  const { repository, degraded } = await createRepository()
  state.repository = repository
  if (degraded) {
    showToast('浏览器本地存储不可用，已降级为内存模式：刷新后数据会丢失', { duration: 6000 })
  }

  // 静默申请持久化，失败不打扰用户（KD-11 第 1 道防线）
  void requestPersistence()

  window.addEventListener('hashchange', () => void route())
  if (!location.hash) location.hash = '#/shelf'
  await route()
  registerServiceWorker()
}

boot().catch((error) => {
  console.error('[main] 启动失败', error)
  showToast('启动失败，请刷新页面重试')
  // 静态占位可能还在（首屏还没渲染出来），把原因直接写进去，别留一片空白
  const bootText = document.getElementById('boot-text')
  const bootHint = document.getElementById('boot-hint')
  if (bootText && bootHint && !document.querySelector('.shelf, .reader')) {
    bootText.textContent = '启动失败'
    bootHint.textContent = `错误：${error?.message ?? error}。请刷新重试，或用开发者工具查看控制台。`
  }
})
