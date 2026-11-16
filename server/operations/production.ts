/**
 * 生产写回适配器
 * ============================================================================
 *  沙盒网关的隔离设计保留（防双写；biz_* 仍是本地台账与审计），
 *  这里在**本地提交成功之后**为已接通主系统端点的动作补一次真实写回：
 *   · 未连接主系统时不出网，回执如实标"仅沙盒记录"。
 *   · requestId 用 operationId（确定性）；主系统按 requestId+发布人去重，
 *     网络重试或重复提交不会把同一条通知发两次。
 *   · 失败绝不记为成功：回执保持 sandbox 并在 deliveryNote 写明原因。
 *  目前只接 notification.publish；其余动作需逐个验证主系统端点后再接入。
 */
import { businessRequest, isBusinessConnected } from '../business/bridge.ts';
import { normalizeNoticeAudience } from '../tools/business.ts';

export interface ProductionPushOutcome {
  environment: 'production' | 'sandbox';
  deliveryStatus: 'sent' | 'pending';
  note: string;
}

export async function pushNotificationToMainSystem(
  payload: Record<string, unknown>,
  operationId: string,
  signal?: AbortSignal
): Promise<ProductionPushOutcome> {
  if (!isBusinessConnected()) {
    return { environment: 'sandbox', deliveryStatus: 'pending', note: '未连接主系统：本条通知仅记录在沙盒台账，未发送给任何人。' };
  }
  const audited = normalizeNoticeAudience(payload['audience']);
  if (!audited.ok) {
    return { environment: 'sandbox', deliveryStatus: 'pending', note: `受众无法映射到主系统口径（${audited.message}）——本条通知仅记录在沙盒台账，未发送；如需真实发送，请按可选受众重新发起。` };
  }
  try {
    const r = await businessRequest('/notifications', 'POST', {
      title: String(payload['title'] ?? ''),
      content: String(payload['content'] ?? ''),
      audience: audited.audience,
      requestId: operationId
    }, signal) as Record<string, unknown>;
    const notice = r['notification'] as { id?: string } | undefined;
    const id = notice?.id ? String(notice.id) : '';
    return { environment: 'production', deliveryStatus: 'sent', note: `已写入主系统通知收件箱${id ? `（编号 ${id}）` : ''}；送达状态为主系统口径"已入收件箱"，已读回执未接入，实际接收人数以主系统名册为准。` };
  } catch (err) {
    const e = err as { code?: string; message?: string; status?: number };
    return { environment: 'sandbox', deliveryStatus: 'pending', note: `主系统写入失败：${e.message ?? String(err)}${e.code ? `（错误码 ${e.code}）` : ''}。本条通知仅记录在沙盒台账、未发送；请确认主系统连接后重新发起办理。` };
  }
}
