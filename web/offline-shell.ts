/**
 * 离线壳注册。
 * ============================================================================
 *  三条约束：
 *   1. 只在**构建产物**里注册 —— 开发期 Vite 的模块图与 SW 缓存会互相干扰，
 *      出现"改了代码页面不更新"的经典陷阱；
 *   2. 只在安全上下文注册 —— Service Worker 要求 HTTPS 或回环，
 *      局域网 http 直连（如 http://192.168.x.x:8787）下注册必然失败，
 *      与其抛一条红色报错，不如安静跳过；
 *   3. 注册失败不得影响应用启动 —— 离线壳是增强，不是依赖。
 */
export function registerOfflineShell(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 离线壳不可用时，页面仍按在线路径正常工作 */
    });
  });
}
