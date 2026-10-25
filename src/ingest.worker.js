/**
 * 导入管线 Worker —— 只做消息转发，逻辑全在 ingest.js（KD-6）
 *
 * worker 内自己开 IndexedDB 并且**只写不读**；主线程只读不写，避免 versionchange 竞争。
 * 回报协议见 KD-6：progress / done / failed
 */

import { IngestError, ingestBuffer } from './ingest.js'
import { IndexedDbRepository } from './store.js'

let repositoryPromise = null
const cancelled = new Set()

function getRepository() {
  if (!repositoryPromise) {
    repositoryPromise = new IndexedDbRepository().ready().catch((error) => {
      repositoryPromise = null // 允许下一次重试
      throw error
    })
  }
  return repositoryPromise
}

self.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'ingest') {
    void handleIngest(message)
  } else if (message.type === 'cancel') {
    cancelled.add(message.id)
  }
})

async function handleIngest(message) {
  const { id } = message
  const post = (payload) => self.postMessage({ id, ...payload })
  const signal = { get aborted() { return cancelled.has(id) } }

  try {
    const repository = await getRepository()
    const meta = await ingestBuffer({
      buffer: message.buffer,
      fileName: message.fileName,
      byteSize: message.byteSize,
      repository,
      now: Date.now(),
      onProgress: (progress) => post({ type: 'ingest:progress', phase: progress.phase, ratio: progress.ratio }),
      signal,
    })
    // 只回小对象：正文永不跨越线程边界
    post({ type: 'ingest:done', meta })
  } catch (error) {
    const reason = error instanceof IngestError ? error.reason : 'storage-error'
    post({
      type: 'ingest:failed',
      reason,
      detail: error?.message ? String(error.message) : String(error),
    })
  } finally {
    cancelled.delete(id)
  }
}
