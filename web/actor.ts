/**
 * 沙盒身份（仅沙盒）—— 前端只保存"当前视角"，服务端校验后才生效。
 * production 环境未接入；接入真实登录态后本模块整体停用。
 */

export type ActorRole = 'admin' | 'volunteer' | 'student';

const KEY = 'labops.actorRole';

export const ACTOR_ROLE_LABELS: Record<ActorRole, string> = {
  admin: '演示管理员',
  volunteer: '演示志愿者',
  student: '演示学生'
};

export function actorRole(): ActorRole {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'admin' || v === 'volunteer' || v === 'student') return v;
  } catch {
    /* 忽略 */
  }
  return 'admin';
}

export function setActorRole(role: ActorRole): void {
  try {
    localStorage.setItem(KEY, role);
  } catch {
    /* 忽略 */
  }
}

/** 给本应用的 fetch 附带身份头（仅沙盒内被服务端采信） */
export function actorHeaders(): Record<string, string> {
  return { 'X-LabOps-Sandbox-Role': actorRole() };
}
