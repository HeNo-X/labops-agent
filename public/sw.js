/* eslint-env serviceworker */
/**
 * LabOps Agent 离线壳 Service Worker
 * ============================================================================
 *  边界（比能力更重要）：
 *   · **绝不缓存 /api/**。业务事实一旦离线可读，就等于让用户把过期数据当现状，
 *     这比打不开更危险。API 一律直连网络，失败即失败。
 *   · 只缓存两类：应用外壳（HTML 入口）与不可变静态资源（哈希名 chunk、图标、
 *     manifest 等）。
 *   · 离线打开时页面仍会显示"网络未连接，输入保留"横幅 —— SW 只保证"打得开"，
 *     不保证"看得到新数据"，这两件事在界面上必须分开说。
 *
 *  ⚠ 本文件放在 public/ 下、由 Vite **原样拷贝**，不经打包，因此必须自包含：
 *     不能 import 项目模块（dist 里没有对应文件）。判据与 shared/offline-scope.ts
 *     保持一致，由 tests/offline-shell.test.ts 同时校验两边，防止漂移。
 *  策略：外壳与静态资源网络优先、失败回落缓存；哈希 chunk 缓存优先（同名必同内容）。
 */

const VERSION = 'labops-shell-v2';
const SHELL = ['/', '/index.html', '/mobile.html', '/mobile.webmanifest'];
const SHELL_PATHS = new Set(['/', '/index.html', '/mobile.html', '/mobile.webmanifest', '/operations.html']);
const STATIC_RE = /\.(?:js|css|svg|png|jpe?g|webp|woff2?|ico|webmanifest)$/i;
const ASSET_RE = /^\/assets\/[\w.-]+$/;

/** 与 shared/offline-scope.ts 的 offlineAction 逐条对应 */
function offlineAction(pathname) {
  // 顺序即优先级：API 与 SSE 必须最先被排除，任何后续新增规则都不得越过它
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'passthrough';
  if (pathname.startsWith('/src/') || pathname.startsWith('/@')) return 'passthrough';
  if (ASSET_RE.test(pathname)) return 'immutable';
  if (SHELL_PATHS.has(pathname)) return 'shell';
  if (STATIC_RE.test(pathname)) return 'static';
  return 'passthrough';
}

function isShellPath(pathname) {
  // 与 shared/offline-scope.ts 同步：API 前缀一律不认作外壳
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  return pathname === '/' || /\/(?:index|mobile|operations)\.html$/.test(pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((p) => c.add(new Request(p, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const action = offlineAction(url.pathname);
  if (action === 'passthrough') return; // 含 /api/ 与 SSE：永不接管

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      if (action === 'immutable') {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req).catch(() => null);
        if (res && res.ok) cache.put(req, res.clone());
        return res ?? Response.error();
      }
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch (e) {
        const hit = await cache.match(req);
        if (hit) return hit;
        if (isShellPath(url.pathname)) {
          const shell = (await cache.match('/mobile.html')) ?? (await cache.match('/index.html'));
          if (shell) return shell;
        }
        return Response.error();
      }
    })()
  );
});
