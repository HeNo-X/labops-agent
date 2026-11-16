/**
 * 沙盒身份与能力策略（ops.v1）
 * ============================================================================
 *  · 身份由**服务端**解析：默认取 .env 的 LABOPS_SANDBOX_ROLE；
 *    仅沙盒允许前端用 X-LabOps-Sandbox-Role 切换沙盒视角（学生/志愿者/管理员），
 *    且值必须在白名单内。模型参数里的任何身份字段一律不采信（服务端前提）。
 *  · production 环境接入真实身份委托时，本文件的沙盒实现需整体替换。
 */

import type { SandboxActor, SandboxRole } from '../../shared/operations-contract.ts';
import { SANDBOX_ROLE_LABELS } from '../../shared/operations-contract.ts';
import { currentActor } from '../security/context.ts';
import { getConfig } from '../config.ts';

/** 能力清单（取当前使用的子集） */
export type Capability =
  | 'issue:create:self'
  | 'notice:publish'
  | 'availability:write'
  | 'duty:write'
  | 'report:create:self';

const ROLE_CAPABILITIES: Record<SandboxRole, Capability[]> = {
  admin: ['issue:create:self', 'notice:publish', 'availability:write', 'duty:write', 'report:create:self'],
  volunteer: ['issue:create:self', 'duty:write', 'report:create:self'],
  student: ['issue:create:self']
};

export function isSandboxRole(v: unknown): v is SandboxRole {
  return v === 'admin' || v === 'volunteer' || v === 'student';
}

/** 从请求头解析沙盒身份（仅沙盒）；非法/缺省回落到服务端配置的默认角色 */
export function resolveActor(headerRole: string | string[] | undefined | null): SandboxActor {
  const verified = currentActor();
  if (verified) return verified;
  const raw = Array.isArray(headerRole) ? headerRole[0] : headerRole;
  const cfg = getConfig();
  const role: SandboxRole = isSandboxRole(raw) ? raw : cfg.sandbox.defaultRole;
  return { id: `sandbox-${role}`, role, label: SANDBOX_ROLE_LABELS[role] };
}

export function actorHasCapability(actor: SandboxActor, cap: Capability): boolean {
  return ROLE_CAPABILITIES[actor.role].includes(cap);
}

export function capabilitiesOf(actor: SandboxActor): Capability[] {
  return [...ROLE_CAPABILITIES[actor.role]];
}
