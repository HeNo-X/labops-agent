/**
 * ops.v1 REST API —— 任务 / 提案决策 / 回执 / 能力
 * ============================================================================
 *  · POST /api/tasks/:id/decisions：受权 UI 触发，模型无权调用；幂等（clientRequestId）
 *  · GET  /api/tasks / /api/tasks/:id：任务中心与恢复（待人工跨重启可查）
 *  · GET  /api/proposals/:id：历史消息里的提案卡刷新状态（已执行→显示回执，过期→不可确认）
 *  · GET  /api/operations/:id：回执查询（业务已提交、HTTP 中断时按此找回）
 *  · GET  /api/capabilities：当前身份、能力清单与环境标识（环境由服务端说了算）
 *
 *  身份：全部取服务端解析的沙盒身份（X-LabOps-Sandbox-Role 仅沙盒内可切换视角）。
 *  决策请求体只允许 proposalId / proposalVersion / decision / clientRequestId
 *  ——业务参数从服务端持久化提案读取，前端不可能夹带。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DecisionOutcome, DecisionRequest, OperationReceipt } from '../../shared/operations-contract.ts';
import { decideOnProposal } from '../operations/executor.ts';
import { capabilitiesOf, resolveActor } from '../operations/identity.ts';
import { pushNotificationToMainSystem } from '../operations/production.ts';
import { isBusinessConnected } from '../business/bridge.ts';
import {
  expireStaleProposals,
  getLatestProposalForTask,
  getOpsOperation,
  getOpsOperationByProposal,
  getOpsProposal,
  getOpsTask,
  listOpsTasks,
  updateOpsOperationReceipt
} from '../persistence/db.ts';
import { readJsonBody } from './agent-chat.ts';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const HTTP_STATUS: Record<string, number> = {
  bad_request: 400,
  forbidden: 403,
  proposal_not_found: 404,
  version_mismatch: 409,
  proposal_expired: 409,
  proposal_already_decided: 409,
  execution_failed: 500
};

export async function handleTasksApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  const actor = resolveActor(req.headers['x-labops-sandbox-role']);

  try {
    // ---- 能力协商：环境/身份/能力一次说清 ----
    if (pathname === '/api/capabilities' && method === 'GET') {
      json(res, 200, {
        operationsContractVersion: 'ops.v1',
        executionEnvironment: 'sandbox',
        productionConnected: isBusinessConnected(),
        productionWriteActions: ['notification.publish'],
        proposalTtlMinutes: 30,
        actor,
        capabilities: capabilitiesOf(actor)
      });
      return true;
    }

    // ---- 任务列表（任务中心）----
    if (pathname === '/api/tasks' && method === 'GET') {
      expireStaleProposals();
      json(res, 200, { tasks: listOpsTasks() });
      return true;
    }

    // ---- 决策（唯一的执行通道；幂等：同 clientRequestId 返回既有结果）----
    const decMatch = /^\/api\/tasks\/([^/]+)\/decisions$/.exec(pathname);
    if (decMatch && method === 'POST') {
      const taskId = decodeURIComponent(decMatch[1]!);
      const body = await readJsonBody(req);
      if (!body.ok) {
        json(res, body.status, { ok: false, code: 'bad_request', message: body.message });
        return true;
      }
      const b = (body.value ?? {}) as Record<string, unknown>;
      const rawDecision = b['decision'];
      if (rawDecision !== 'confirm' && rawDecision !== 'reject') {
        json(res, 400, { ok: false, code: 'bad_request', message: 'decision 必须是 confirm / reject' });
        return true;
      }
      const input: DecisionRequest = {
        proposalId: String(b['proposalId'] ?? ''),
        proposalVersion: Number(b['proposalVersion'] ?? 0),
        decision: rawDecision,
        clientRequestId: String(b['clientRequestId'] ?? '')
      };
      const outcome: DecisionOutcome = decideOnProposal({ ...input, actor, taskId });
      if (!outcome.ok) {
        json(res, HTTP_STATUS[outcome.code] ?? 400, outcome);
        return true;
      }
      if (outcome.task.taskId !== taskId) {
        json(res, 400, { ok: false, code: 'bad_request', message: `提案 ${input.proposalId} 不属于任务 ${taskId}` });
        return true;
      }
      // 生产写回：本地台账提交成功后，已接通的动作类型真实写入主系统，
      // 回执按事实改写环境/送达/说明；幂等重放（executedNow 缺省）不再推送。
      if (outcome.ok && outcome.decision === 'confirm' && outcome.executedNow && outcome.receipt) {
        const stored = getOpsProposal(input.proposalId);
        if (stored?.proposal.actionType === 'notification.publish') {
          const push = await pushNotificationToMainSystem(stored.payload as Record<string, unknown>, outcome.receipt.operationId);
          const nextReceipt: OperationReceipt = { ...outcome.receipt, executionEnvironment: push.environment, deliveryStatus: push.deliveryStatus, deliveryNote: push.note };
          updateOpsOperationReceipt(outcome.receipt.operationId, nextReceipt);
          outcome.receipt = nextReceipt;
        }
      }
      json(res, 200, outcome);
      return true;
    }

    // ---- 任务详情（含最新提案与回执）----
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
    if (taskMatch && method === 'GET') {
      const task = getOpsTask(decodeURIComponent(taskMatch[1]!));
      if (!task || task.actor.id !== actor.id) {
        json(res, 404, { error: 'task_not_found' });
        return true;
      }
      const stored = getLatestProposalForTask(task.taskId);
      const receipt: OperationReceipt | null = stored ? getOpsOperationByProposal(stored.proposal.proposalId) : null;
      json(res, 200, { task, proposal: stored?.proposal ?? null, receipt });
      return true;
    }

    // ---- 提案状态（历史卡刷新：已执行显示回执，过期不可确认）----
    const propMatch = /^\/api\/proposals\/([^/]+)$/.exec(pathname);
    if (propMatch && method === 'GET') {
      expireStaleProposals();
      const stored = getOpsProposal(decodeURIComponent(propMatch[1]!));
      if (!stored || getOpsTask(stored.proposal.taskId)?.actor.id !== actor.id) {
        json(res, 404, { error: 'proposal_not_found' });
        return true;
      }
      json(res, 200, { proposal: stored.proposal, receipt: getOpsOperationByProposal(stored.proposal.proposalId) });
      return true;
    }

    // ---- 回执查询（恢复用）----
    const opMatch = /^\/api\/operations\/([^/]+)$/.exec(pathname);
    if (opMatch && method === 'GET') {
      const receipt = getOpsOperation(decodeURIComponent(opMatch[1]!));
      if (!receipt || receipt.actor.id !== actor.id) {
        json(res, 404, { error: 'operation_not_found' });
        return true;
      }
      json(res, 200, receipt);
      return true;
    }

    return false;
  } catch (err) {
    json(res, 500, {
      ok: false,
      code: 'internal_error',
      message: `业务接口内部错误：${err instanceof Error ? err.message : String(err)}`
    });
    return true;
  }
}
