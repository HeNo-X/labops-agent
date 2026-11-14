/**
 * 跨会话并发第二片 —— run 期间的「身份范围」指纹
 * ============================================================================
 * 为什么不能直接用 `businessScope().scopeKey`：
 *   scopeKey 里含 **owner 级 generation**。任何一次重建连接/账号刷新都会
 *   `generation + 1`（bridge.ts 的 resetAuthority），于是「B 会话的一次正常
 *   连接」会把「A 会话正在跑的 run」判定为 scope_changed 并中止 —— 这是
 *   跨会话串扰，不是安全边界。
 *
 * 本模块只哈希**身份要素**（业务地址、账号、角色、班级），故意不含 generation：
 *   · 真换了账号 / 角色 / 班级 → 指纹变化 → 仍中止在途 run（安全边界保留）；
 *   · 只是别的会话重连 / 首次建连 / 令牌轮换 → 指纹不变 → 在途 run 不受影响。
 *
 * 写操作的保护不依赖本指纹：`scopeKey`（含 generation）仍用于业务代理的
 * `scope_changed` 校验，方案确认前必须重新查询；主系统另有乐观并发令牌。
 */
import crypto from 'node:crypto';
import { businessScope } from './bridge.ts';

export function businessIdentityKey(owner?: string): string {
  const { principal } = businessScope(owner);
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        process.env['LABOPS_BUSINESS_URL'] || '',
        principal?.username || principal?.account || 'demo',
        principal?.identity || '',
        principal?.className || ''
      ])
    )
    .digest('hex');
}
