/*
 * Service Worker（KD-1 / KD-15）
 *
 * 策略写死，防止以后乱改：
 *  - app shell（html/css/js/manifest/图标）→ cache-first，版本号变更时整批替换
 *  - texts / books / progress → 不进 SW 缓存，数据只在 IndexedDB
 *  - 刻意不做"网络回填缓存"：否则缓存里会混进下一代文件，出现半新半旧
 *
 * 两个必须记住的事实：
 *
 * 1. 浏览器只在 **sw.js 字节变化** 时才重新跑 install。只递增
 *    assets.manifest.json 的 version（本项目的发布纪律）不会触发更新，
 *    用户会永远用旧缓存。所以导航时要主动探测清单版本。
 *
 * 2. SW 随时可能被浏览器杀掉（空闲约 30s），**模块级变量不保证存活**。
 *    因此缓存维护不能依赖内存状态：一切以 CacheStorage 里的实际情况为准，
 *    每次导航都幂等地"装最新、留最新两个、删更旧的"。
 *    保留两个而不是一个，是为了让"本文档用旧版、下次导航用新版"不打架
 *    （同一份文档的 HTML 与 JS 必须来自同一个缓存版本）。
 */

const MANIFEST_URL = './assets.manifest.json';
const CACHE_PREFIX = 'txt-reader-';
/** 保留的缓存份数：当前文档 + 已装好的下一版 */
const KEEP_CACHES = 2;

/** 本次 SW 生命周期内确认过的缓存名（仅作加速，不参与正确性） */
let activeCacheName = null;
/** 同一时刻只跑一个版本探测 */
let probePromise = null;

/** 读取清单：必须 no-store，否则会拿到 Pages CDN 上的旧清单（max-age=600） */
async function readManifest() {
  const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`manifest ${response.status}`);
  return response.json();
}

function isValidManifest(data) {
  return (
    Boolean(data) &&
    typeof data.version === 'string' &&
    data.version.length > 0 &&
    Array.isArray(data.files) &&
    data.files.length > 0
  );
}

/** 现有缓存名（按版本号升序：版本号是"日期.当日序号"，字符串排序即时间排序） */
async function cachedNames() {
  try {
    const names = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX));
    names.sort();
    return names;
  } catch {
    return [];
  }
}

async function currentCacheName() {
  if (activeCacheName) return activeCacheName;
  const names = await cachedNames();
  activeCacheName = names.length > 0 ? names[names.length - 1] : null;
  return activeCacheName;
}

/**
 * 整批装入一个版本。addAll 是原子的：任一文件失败则整体失败，
 * 宁可保留旧版本可用，也不要装出缺文件的半套缓存。
 */
async function installVersion(version, files) {
  const name = `${CACHE_PREFIX}${version}`;
  const cache = await caches.open(name);
  await cache.addAll(files);
  return name;
}

/** 探测并装好清单上的版本；离线/失败返回 null，调用方继续用旧缓存 */
function ensureCurrentVersion() {
  if (!probePromise) {
    probePromise = doEnsureCurrentVersion().finally(() => {
      probePromise = null;
    });
  }
  return probePromise;
}

async function doEnsureCurrentVersion() {
  try {
    const data = await readManifest();
    if (!isValidManifest(data)) return null;
    const name = `${CACHE_PREFIX}${data.version}`;
    if (await caches.has(name)) return name;
    return await installVersion(data.version, data.files);
  } catch {
    return null;
  }
}

/** 幂等维护：装最新、保留最新 KEEP_CACHES 个、删更旧的 */
async function maintainCaches() {
  await ensureCurrentVersion();
  const names = await cachedNames();
  if (names.length <= KEEP_CACHES) return;
  const keep = new Set(names.slice(-KEEP_CACHES));
  await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const data = await readManifest();
      if (!isValidManifest(data)) throw new Error('assets.manifest.json 无效');
      activeCacheName = await installVersion(data.version, data.files);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const data = await readManifest();
        if (isValidManifest(data)) activeCacheName = `${CACHE_PREFIX}${data.version}`;
      } catch {
        // 离线：无法判定版本，保留全部缓存
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 只有导航才维护缓存（"重新打开后生效"）；静态资源一律不触发，
  // 否则一次页面加载会并发几十个探测请求。
  if (request.mode === 'navigate') {
    const maintenance = maintainCaches();
    // waitUntil 必须在 dispatch 期间同步调用
    event.waitUntil(maintenance.catch(() => null));
    event.respondWith(respondNavigation(request, maintenance));
    return;
  }
  event.respondWith(respondAsset(request));
});

async function respondNavigation(request, maintenance) {
  let name = await currentCacheName();
  if (!name) {
    // 首次访问：没有任何缓存可服务，只能等安装完成
    await maintenance;
    name = await currentCacheName();
  }
  if (name) {
    const cache = await caches.open(name);
    const shell =
      (await cache.match('./', { ignoreSearch: true })) ??
      (await cache.match('./index.html', { ignoreSearch: true }));
    if (shell) return shell;
  }
  return fetch(request);
}

/** 静态资源：cache-first，且刻意不回填 */
async function respondAsset(request) {
  const name = await currentCacheName();
  if (name) {
    const cache = await caches.open(name);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
  }
  return fetch(request);
}
