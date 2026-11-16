/**
 * query_vision_status —— 视觉现场事实的只读 Agent 工具
 * ============================================================================
 *  数据源（两路，与监控面板同源，保证「面板看到的 = Agent 说的」）：
 *    · server/vision/monitor.ts 内存环：边缘 HMAC 上报（剥离身份）——房间状态/事件，
 *      上报的是「数量与条目名」：人数（YOLO person 计数）、已录入人脸命中数（**不含
 *      姓名**，姓名永不出边缘机）、物品/场景底库命中（条目名非个人信息）；
 *    · server/vision/live.ts：实时画面识别（画框循环现况）——现场摄像头房间的
 *      当前画面人数与人数变化事件（E315 这类只走实时识别的房间在这里）。
 *
 *  红线（写进了 description，模型每次都会读到）：
 *    · 视觉是**线索不是结论**：AI 计数可能漏检误检，与签到记录不一致时只能建议
 *      核查，不得断言"有人违规"、"某人未签到"——云端根本没有人名可比；
 *    · 画面人数是现场计数，**不等于签到人数**：问"多少人签到"必须走签到台账
 *      工具（query_checkin_*），本工具只作现场对照；
 *    · 与签到口径的交叉验证是 Agent 的推理工作——只做**数量级**对比（签到 N 人
 *      vs 摄像头计数 M 人）；
 *    · 数据过期/未接入时如实说明，不得拿旧计数当现状。
 */

import type { ToolSpec, VisionFieldLab, VisionFieldResult } from '../../shared/types.ts';
import { visionEventFeedback, visionFeedbackStats, visionIngestConfigured, visionEvents, visionStatus } from '../vision/monitor.ts';
import { readLiveStatus, liveEventList } from '../vision/live.ts';

export interface VisionToolExecution { ok: true; resultKind: 'vision_field'; summary: string; result: VisionFieldResult; }

export interface VisionToolDefinition {
  spec: ToolSpec;
  effect: 'read';
  execute: (args: Record<string, unknown>) => VisionToolExecution | Promise<VisionToolExecution>;
}

export function formatLibraryHit(hit: { name: string; score: number | null; kind: string }): string {
  const score = hit.score !== null ? `（相似度 ${Math.round(hit.score * 100)}%）` : '';
  return `${hit.kind === 'scene' ? '场景' : '物品'}「${hit.name}」${score}`;
}

export const VISION_STATUS_TOOL: VisionToolDefinition = {
  spec: {
    name: 'query_vision_status',
    description:
      '查询实验室监控视觉事实（剥离身份，只有数量与条目名，**没有任何人脸、姓名或画面**）。' +
      '含两路数据：边缘上报的各房间状态（AI 计数、容量、人脸命中数、底库命中、事件流水），以及实时画面识别（现场摄像头画框循环的当前人数与人数变化）。' +
      '**视觉是线索不是结论**：AI 计数可能漏检误检，与签到记录不一致时只能建议人工核查，不得断言有人违规或某人未签到（云端没有人名可比，只能做数量级对比）。' +
      '**画面人数是现场计数，不等于签到人数**：用户问"多少人签到""谁签到了"时，签到结论必须来自签到台账工具（query_checkin_*），本工具只作现场对照。' +
      '**画面可能是回放（历史录像）**：结果标注「回放」的内容是过去的、不是此刻现场——回答时必须区分"现在"与"回放时段"，不得把回放画面人数说成"此刻/现在现场有几人"。' +
      '未接入或数据明显过期（超过2分钟未更新）时必须如实说明，不得把旧计数当作现状。' +
      '用户问"实验室现在有没有人""现场情况如何""有没有异常""摄像头识别到什么""监控里多少人"时用本工具。',
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
  execute: async (args) => {
    const labId = typeof args['labId'] === 'string' ? args['labId'].trim().slice(0, 64) : undefined;
    const scope = args['scope'] === 'events' ? 'events' : 'labs';
    const live = await readLiveStatus();
    const liveShot = live.ok && !live.error && live.snapshot ? live.snapshot : null;
    const liveAgeSec = liveShot ? Math.max(0, Math.round((Date.now() - liveShot.at) / 1000)) : 0;
    const liveRoomName = liveShot ? (liveShot.room ?? '当前摄像头') : '';
    const normRoom = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
    // 相关性：未指定房间 / 画面未标注房间（单路现场画面）/ 房间号一致（忽略大小写）都算相关——
    // 不能因为 room 没写或 e315≠E315 就把有数据的房间误判成「查不到」
    const liveRelevant = (room?: string) => Boolean(liveShot) && (!room || !liveShot!.room || normRoom(liveShot!.room) === normRoom(room));
    // 摘要口径：**人数先行**，只讲监控结论。「不在边缘上报
    // 名单 / 未上报 / 已接入房间名单」这类内部通路措辞一律不上摘要——多余，且会被
    // 模型转述成「查不到」在前、人数在后，还让人以为该房间没被监控。
    const countPhrase = (label: string): string =>
      liveShot!.isPlayback
        ? `⚠ 回放画面（${liveShot!.playbackWindow ? `时段 ${liveShot!.playbackWindow}，` : ''}历史录像非此刻）：${label} 画面人数 ${liveShot!.count} 人`
        : `${label} 画面人数 ${liveShot!.count} 人（实时画面识别，${liveAgeSec} 秒前）`;
    // 回放判定：画面是历史录像时必须显著标注——那是「过去」，不是「现在」
    const playbackTag = liveShot?.isPlayback
      ? `⚠ 画面是**回放（历史录像）**${liveShot.playbackWindow ? `，回放时段 ${liveShot.playbackWindow}` : ''}——画面内容是过去的，不代表此刻现场；`
      : '';
    const liveLine = liveShot
      ? `${playbackTag}${liveShot.isPlayback ? '回放画面识别' : '▶ 实时画面识别（监控面板同源'}${
          liveShot.isPlayback ? '' : (live.cached ? '，5 秒缓存' : '，刚刚更新') + '）'
        }：${liveRoomName} 画面人数 ${liveShot.count} 人（${liveAgeSec} 秒前${liveShot.inferFps !== null ? `，推理 ${liveShot.inferFps} fps` : ''}）——画面计数是${liveShot.isPlayback ? '回放时段内的' : '现场'}线索，不等于签到人数`
      : live.error === 'live_not_running'
        ? `▶ 实时画面识别：${live.message ?? '实时识别未开始（请在实验室现场端启动）'}`
        : `▶ 实时画面识别：暂不可用（${live.message ?? '读不到边缘实时识别状态'}）`;
    const liveEventRows = (limit: number, room?: string) =>
      liveEventList(limit)
        .filter((e) => !room || !e.room || normRoom(e.room) === normRoom(room))
        .map((e) => `${new Date(e.at).toISOString()} ${liveShot?.isPlayback ? '回放识别' : '实时识别'} ${e.room ?? '当前摄像头'}：画面人数 ${e.prev ?? '?'} → ${e.count} 人${liveShot?.isPlayback ? '（回放画面中的变化，非此刻）' : ''}`);

    if (!visionIngestConfigured()) {
      if (liveShot) {
        return {
          ok: true,
          resultKind: 'vision_field',
          summary: countPhrase(liveRoomName),
          result: {
            configured: true,
            labs: [],
            detailLines: [liveLine, ...liveEventRows(5)],
            note: '视觉是线索不是结论；画面人数不等于签到人数；边缘上报未接入，房间状态/底库命中不可查'
          }
        };
      }
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
        const feedback = visionEventFeedback(event.lab_id, event.receivedAt);
        const marked = feedback ? `（人工标注：${feedback.verdict === 'false_alarm' ? '误报' : '已确认'}）` : '';
        return `${new Date(event.receivedAt).toISOString()} ${event.lab_id}：${event.camera_online ? `计数 ${event.count} 人${faces}` : '摄像头离线'}${hits ? '，' + hits : ''}${event.alert ? '（异常线索）' : ''}${marked}`;
      });
      const stats = visionFeedbackStats(labId);
      const liveNow = liveShot && liveRelevant(labId) ? `${countPhrase(liveShot.room ?? labId ?? liveRoomName)}；` : '';
      return {
        ok: true,
        resultKind: 'vision_field',
        summary: liveNow + (labId
          ? `${labId} 最近事件 ${events.length} 条，其中异常线索 ${alertCount} 条、底库命中 ${hitCount} 次；人工标注：误报 ${stats.falseAlarm} 次 / 已确认 ${stats.confirmed} 次`
          : `视觉事件流水最近 ${events.length} 条，其中异常线索 ${alertCount} 条、底库命中 ${hitCount} 次；人工标注：误报 ${stats.falseAlarm} 次 / 已确认 ${stats.confirmed} 次`),
        result: {
          configured: true,
          note: '事件流水只含数量与条目名，没有任何人脸/姓名；"人工标注"是现场人员对历史事件的误报/确认回流，可作为判断当前线索可信度的参考；实时识别事件来自画框循环，画面人数不等于签到人数',
          labs: [],
          detailLines: [...(liveRelevant(labId) ? liveEventRows(10, labId) : []), ...eventLines],
          feedbackStats: stats
        }
      };
    }

    const status = visionStatus();
    const matched = labId ? status.labs.filter((lab) => normRoom(lab.labId) === normRoom(labId)) : status.labs;
    if (labId && !matched.length) {
      // 有画面识别数据就是「查到了」——人数放第一句，绝不先说"不在名单/未上报"
      if (liveShot && liveRelevant(labId)) {
        return {
          ok: true,
          resultKind: 'vision_field',
          summary: countPhrase(liveShot.room ?? labId),
          result: {
            configured: true,
            generatedAt: new Date(liveShot.at).toISOString(),
            note: '视觉是线索不是结论；画面人数是现场计数，不等于签到人数，签到结论须查签到台账' + (liveShot.isPlayback ? '；画面是回放（历史录像），内容是过去某时段的，不代表此刻现场' : ''),
            labs: [],
            knownLabs: [labId],
            detailLines: [liveLine, ...liveEventRows(5, labId)]
          }
        };
      }
      return {
        ok: true,
        resultKind: 'vision_field',
        summary: `没有 ${labId} 的监控数据：摄像头画面识别和视觉上报都没有该房间`,
        result: { configured: true, labs: [], detailLines: [liveLine], knownLabs: status.labs.map((lab) => lab.labId) }
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
    const livePart = liveShot && liveRelevant(labId) ? `；${countPhrase(liveShot.room ?? liveRoomName)}` : '';
    const summary = matched.length
      ? `${matched.length} 个房间有视觉上报${alerts.length ? `，异常线索 ${alerts.length} 处：${alerts.map((lab) => `${lab.labId}（${lab.capacity !== null && lab.count > lab.capacity ? `超容量 ${lab.count}/${lab.capacity}` : '摄像头离线'}）`).join('、')}` : '，暂无异常线索'}${livePart}`
      : livePart ? livePart.slice(1) : '当前没有可用的监控数据';

    return {
      ok: true,
      resultKind: 'vision_field',
      summary,
      result: {
        configured: true,
        generatedAt: status.generatedAt,
        note: 'AI 计数与底库命中是线索不是结论；画面人数是现场计数，不等于签到人数；与签到口径不一致时应建议人工核查（只能数量级对比，没有人名）',
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
        detailLines: [...(liveRelevant(labId) ? [liveLine] : []), ...detailLines]
      }
    };
  }
};
