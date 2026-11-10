/**
 * 原系统业务网关替身 —— 只服务于测试，不参与生产。
 * ============================================================================
 *  用途：断言 server/tools/business.ts 在**发起请求之前**把参数整理成了什么样子
 *  （例如通知的 audience 词表归一），而不需要真的起一个主系统。
 *  接线方式见 tests/notice-audience.test.ts 的 registerHooks。
 */

export interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
}

export const calls: RecordedCall[] = [];
/** 下一次 businessRequest 的返回；测试按需替换 */
export let nextResponse: Record<string, unknown> = {};
export function setNextResponse(v: Record<string, unknown>): void {
  nextResponse = v;
}
/** 让下一次 businessRequest 抛错（验服务端错误如何如实上抛） */
export let nextError: Error | null = null;
export function setNextError(e: Error | null): void {
  nextError = e;
}
export function resetCalls(): void {
  calls.length = 0;
  nextResponse = {};
  nextError = null;
}

export function businessScope(): { scopeKey: string; generation: number; principal: null } {
  return { scopeKey: 'stub-scope', generation: 0, principal: null };
}
export function isBusinessConnected(): boolean {
  return true;
}
export async function businessRequest(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  calls.push({ path, method, body });
  if (nextError) throw nextError;
  return nextResponse;
}
export function rememberBusinessTask(): void {
  /* 替身不落库 */
}
export function readBusinessTask(): null {
  return null;
}
export function listBusinessTasks(): Array<Record<string, unknown>> {
  return [];
}
export function effectiveRole(): string {
  return 'admin';
}
export function baseUrl(): string {
  return 'http://stub.invalid';
}
