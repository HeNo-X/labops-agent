/**
 * 离线壳作用域判据 —— 被 public/sw.js 与测试共用。
 * ============================================================================
 *  抽出来的唯一理由：**"绝不缓存 /api/" 是安全声明，不是实现细节**。
 *  它一旦写死在 SW 内部就无法被测试覆盖，而这条规则破掉的后果是
 *  "用户把昨天的业务数据当成当前事实" —— 正是本项目全程在防的那类错误。
 */

export type OfflineAction = 'passthrough' | 'shell' | 'immutable' | 'static';

const SHELL_PATHS = new Set(['/', '/index.html', '/mobile.html', '/mobile.webmanifest', '/operations.html']);
const STATIC_RE = /\.(?:js|css|svg|png|jpe?g|webp|woff2?|ico|webmanifest)$/i;
const ASSET_RE = /^\/assets\/[\w.-]+$/;

export function offlineAction(pathname: string): OfflineAction {
  // 顺序即优先级：API 与 SSE 必须最先被排除，任何后续新增规则都不得越过它
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'passthrough';
  if (pathname.startsWith('/src/') || pathname.startsWith('/@')) return 'passthrough'; // Vite 开发期模块
  if (ASSET_RE.test(pathname)) return 'immutable';
  if (SHELL_PATHS.has(pathname)) return 'shell';
  if (STATIC_RE.test(pathname)) return 'static';
  return 'passthrough';
}

export function isShellPath(pathname: string): boolean {
  // 必须先排除 API：否则 `/api/mobile.html` 这类路径会被后缀正则误判为外壳，
  // 从而在离线时把业务 URL 渲染成应用壳 —— 那正是本模块要防的事。
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  return pathname === '/' || /\/(?:index|mobile|operations)\.html$/.test(pathname);
}
