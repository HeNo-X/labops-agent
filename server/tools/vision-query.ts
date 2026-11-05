/**
 * query_vision_status —— 视觉现场事实的只读 Agent 工具（已接线 registry）
 * ============================================================================
 *  数据源：server/vision/monitor.ts 的内存环（边缘 HMAC 上报，剥离身份）。
 *  上报的是「数量与条目名」：人数（YOLO person 计数）、已录入人脸命中数（**不含
 *  姓名**，姓名永不出边缘机）、物品/场景底库命中（条目名非个人信息）。
 *
 *  红线（写进了 description，模型每次都会读到）：
 *    · 视觉是**线索不是结论**：AI 计数可能漏检误检，与签到记录不一致时只能建议
 *      核查，不得断言"有人违规"、"某人未签到"——云端根本没有人名可比；
 *    · 与签到口径的交叉验证是 Agent 的推理工作——只做**数量级**对比（签到 N 人
 *      vs 摄像头计数 M 人）；
 *    · 数据过期/未接入时如实说明，不得拿旧计数当现状。
 */

import type { ToolSpec, VisionFieldLab, VisionFieldResult } from '../../shared/types.ts';
import { visionIngestConfigured, visionEvents, visionStatus } from '../vision/monitor.ts';

export interface VisionToolExecution { ok: true; resultKind: 'vision_field'; summary: string; result: VisionFieldResult; }

export interface VisionToolDefinition {
  spec: ToolSpec;
  effect: 'read';
  execute: (args: Record<string, unknown>) => VisionToolExecution;
}

export function formatLibraryHit(hit: { name: string; score: number | null; kind: string }): string {
  const score = hit.score !== null ? `（相似度 ${Math.round(hit.score * 100)}%）` : '';
  return `${hit.kind === 'scene' ? '场景' : '物品'}「${hit.name}」${score}`;
}

export const VISION_STATUS_TOOL: VisionToolDefinition = {
  spec: {
    name: 'query_vision_status',
    description:
      '查询视觉边缘服务上报的实验室现场事实（剥离身份，只有数量与条目名，**没有任何人脸、姓名或画面**）。' +
      '返回各房间摄像头在线状态、AI 计数在室人数与容量、已录入人脸命中数、物品/场景底库命中、最近事件流水。' +
      '**视觉是线索不是结论**：AI 计数可能漏检误检，与签到记录不一致时只能建议人工核查，不得断言有人违规或某人未签到（云端没有人名可比，只能做数量级对比）。' +
      '未接入或数据明显过期（超过2分钟未更新）时必须如实说明，不得把旧计数当作现状。' +
      '用户问"实验室现在有没有人""现场情况如何""有没有异常""摄像头识别到什么"时用本工具。',
    parameters: {
      type: 'object',
      properties: {
        labId: { type: 'string', description: '可选：只看某个房间（如 E310）' },
        scope: { type: 'string', enum: ['labs', 'events'], description: 'labs=各房间当前状态（默认）；events=最近事件流水' }
      },
      additionalProperties: false
    },
    danger: false
  },
  effect: 'read',
  execute: (args) => {
    const labId = typeof args['labId'] === 'string' ? args['labId'].trim().slice(0, 64) : undefined;
    const scope = args['scope'] === 'events' ? 'events' : 'labs';

    if (!visionIngestConfigured()) {
      return {
        ok: true,
        resultKind: 'vision_field',
        summary: '视觉边缘服务未接入（服务端未配置 VISION_INGEST_SECRET），无法提供摄像头现场事实',
        result: { configured: false, labs: [], detailLines: [], note: '接入方法见 docs/vision-agent-integration-20261029.md' }
      };
    }

    if (scope === 'events') {
      const events = visionEvents({ labId, limit: 30 });
      const alertCount = events.filter((event) => event.alert).length;
      const hitCount = events.reduce((sum, event) => sum + event.library.length, 0);
      const eventLines = events.map((event) => {
        const hits = event.library.map(formatLibraryHit).join('、');
        const faces = event.faces ? `，人脸命中 ${event.faces.recognized}` : '';
        return `${new Date(event.receivedAt).toISOString()} ${event.lab_id}：${event.camera_online ? `计数 ${event.count} 人${faces}` : '摄像头离线'}${hits ? '，' + hits : ''}${event.alert ? '（异常线索）' : ''}`;
      });
      return {
        ok: true,
        resultKind: 'vision_field',
        summary: labId
          ? `${labId} 最近事件 ${events.length} 条，其中异常线索 ${alertCount} 条、底库命中 ${hitCount} 次`
          : `视觉事件流水最近 ${events.length} 条，其中异常线索 ${alertCount} 条、底库命中 ${hitCount} 次`,
        result: {
          configured: true,
          note: '事件流水只含数量与条目名，没有任何人脸/姓名',
          labs: [],
          detailLines: eventLines
        }
      };
    }

    const status = visionStatus();
    const matched = labId ? status.labs.filter((lab) => lab.labId === labId) : status.labs;
    if (labId && !matched.length) {
      return {
        ok: true,
        resultKind: 'vision_field',
        summary: `视觉边缘服务未上报过 ${labId} 的数据（已接入房间：${status.labs.map((lab) => lab.labId).join('、') || '无'}）`,
        result: { configured: true, labs: [], detailLines: [], knownLabs: status.labs.map((lab) => lab.labId) }
      };
    }

    const alerts = matched.filter((lab) => lab.alert);
    const detailLines = matched.map((lab) => {
      const capacity = lab.capacity !== null ? `/${lab.capacity} 容量` : '';
      const stale = lab.ageSeconds > 120 ? `（数据 ${lab.ageSeconds} 秒前，可能过期）` : '';
      const flag = lab.online ? (lab.alert ? '⚠' : '●') : '○摄像头离线';
      const faces = lab.recognized !== null ? `，已录入人脸命中 ${lab.recognized} 人` : '';
      const hits = lab.library.length ? `，识别到 ${lab.library.map(formatLibraryHit).join('、')}` : '';
      return `${flag} ${lab.labId}：AI 计数 ${lab.count}${capacity} 人${faces}${hits}${stale}`;
    });
    const summary = matched.length
      ? `视觉接入 ${matched.length} 个房间${alerts.length ? `，异常线索 ${alerts.length} 处：${alerts.map((lab) => `${lab.labId}（${lab.capacity !== null && lab.count > lab.capacity ? `超容量 ${lab.count}/${lab.capacity}` : '摄像头离线'}）`).join('、')}` : '，暂无异常线索'}`
      : '已开启视觉接入，但尚未收到任何边缘上报';

    return {
      ok: true,
      resultKind: 'vision_field',
      summary,
      result: {
        configured: true,
        generatedAt: status.generatedAt,
        note: 'AI 计数与底库命中是线索不是结论；与签到口径不一致时应建议人工核查（只能数量级对比，没有人名）',
        labs: matched.map((lab): VisionFieldLab => ({
          labId: lab.labId,
          online: lab.online,
          count: lab.count,
          capacity: lab.capacity,
          recognized: lab.recognized,
          unknownFaces: lab.unknownFaces,
          library: lab.library.map((hit) => ({ kind: hit.kind, name: hit.name, score: hit.score })),
          alert: lab.alert,
          ageSeconds: lab.ageSeconds
        })),
        detailLines
      }
    };
  }
};
