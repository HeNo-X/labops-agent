import { businessRequest, isBusinessConnected } from '../business/bridge.ts';
import { analyzeImages, isVisionConfigured, VisionError } from '../llm/vision.ts';
import { getConfig } from '../config.ts';
import type { ToolContext, ToolExecution } from './registry.ts';

/**
 * analyze_evidence_image —— 把已上传的证据照片送进视觉模型，取回**结构化初判**。
 *
 * 三条硬纪律（与 README"照片不证明修复完成"一致）：
 *  1. 结果只作"AI 视觉初判"，不作人工验收结论，也不写入任何业务字段；
 *  2. 不推进工单状态——本工具 effect='read'，无草稿、无提案、无提交能力；
 *  3. 未配置视觉 Key / 未连接原系统时**如实说明拿不到**，不伪造观察结果。
 *
 * 图片字节只从原系统的附件接口取（带对象权限校验），不接受前端直传 base64，
 * 否则等于开一个"让模型看任意内容"的入口。
 */

const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;

interface AttachmentRecord {
  id: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  uploadedAt: string;
}

function describe(e: unknown): { code: string; message: string } {
  if (e instanceof VisionError) return { code: e.code, message: e.message };
  const status = (e as { status?: number }).status;
  if (status === 403) return { code: 'attachment_forbidden', message: '当前账号无权查看该附件' };
  if (status === 404) return { code: 'attachment_missing', message: '未找到该附件' };
  return { code: 'attachment_unavailable', message: (e as Error).message || '附件读取失败' };
}

export async function runAnalyzeEvidenceImage(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecution> {
  const ids = args['attachmentIds'];
  if (!Array.isArray(ids) || !ids.length || !ids.every((i) => typeof i === 'string' && /^attachment-[a-f0-9-]{36}$/.test(i))) {
    return { ok: false, code: 'attachment_ids_required', message: '请提供要分析的照片编号（attachment- 开头的对象编号）', suggestions: ['先用 prepare_issue_report 上传证据后拿到编号', '或在消息里指定房间与日期，让我列出该对象的附件'], summary: '缺少可分析的照片编号' };
  }
  if (!isBusinessConnected()) {
    return { ok: false, code: 'business_not_connected', message: '未连接原系统，取不回照片内容，因此无法进行视觉分析', suggestions: ['请先在原系统账号下连接后再试'], summary: '未连接原系统，照片不入模' };
  }
  if (!isVisionConfigured()) {
    return { ok: false, code: 'vision_not_configured', message: '视觉模型未配置，照片只作为人工核对材料存在，系统没有"看过"它', suggestions: ['管理员可在服务端配置 VISION_API_KEY 后启用'], summary: '视觉未启用，照片未进入模型' };
  }

  const limit = getConfig().vision.maxImages;
  const wanted = ids.slice(0, limit) as string[];
  const images: Array<{ mimeType: (typeof IMAGE_MIME)[number]; dataBase64: string }> = [];
  const skipped: string[] = [];
  const seen: AttachmentRecord[] = [];

  for (const id of wanted) {
    let raw: Record<string, unknown>;
    try {
      raw = await businessRequest(`/evidence/attachments/${encodeURIComponent(id)}`, 'GET', undefined, ctx.signal);
    } catch (e) {
      const { code, message } = describe(e);
      if (!images.length) return { ok: false, code, message, suggestions: [], summary: `照片 ${id} 未能读取` };
      skipped.push(`${id}（${message}）`);
      continue;
    }
    const a = raw['attachment'] as AttachmentRecord | undefined;
    const b64 = typeof raw['dataBase64'] === 'string' ? raw['dataBase64'] : '';
    if (!a || !b64) {
      skipped.push(`${id}（无内容）`);
      continue;
    }
    if (!(IMAGE_MIME as readonly string[]).includes(a.mimeType)) {
      skipped.push(`${a.id}（${a.mimeType} 不是视觉模型支持的图片格式）`);
      continue;
    }
    if (a.byteLength > getConfig().vision.maxImageBytes) {
      skipped.push(`${a.id}（超过单图体积上限）`);
      continue;
    }
    images.push({ mimeType: a.mimeType as (typeof IMAGE_MIME)[number], dataBase64: b64 });
    seen.push(a);
  }

  if (!images.length) {
    return { ok: false, code: 'no_analyzable_image', message: '这些附件里没有视觉模型可分析的图片', suggestions: skipped.length ? [skipped.join('；')] : [], summary: '没有可分析的图片' };
  }

  const focus = typeof args['focus'] === 'string' ? args['focus'].slice(0, 200) : '';
  let result: Awaited<ReturnType<typeof analyzeImages>>;
  try {
    result = await analyzeImages(
      images.map((i) => ({ mimeType: i.mimeType, dataBase64: i.dataBase64 })),
      focus
    );
  } catch (e) {
    const { code, message } = describe(e);
    return { ok: false, code, message, suggestions: [], summary: `视觉分析未完成：${message}` };
  }

  const o = result.observation;
  return {
    ok: true,
    resultKind: 'evidence_observation',
    summary: `已对 ${images.length} 张照片完成 AI 视觉初判（${result.model}）；这是初判，不替代人工验收`,
    result: {
      provenance: {
        sourceLabel: `视觉模型 ${result.model} 对原系统授权照片的初判`,
        queryTime: new Date().toISOString(),
        sourceRevision: seen.map((s) => s.sha256.slice(0, 12)).join(','),
        coverage: '仅画面可见内容；不含原因推断与维修结论'
      },
      scope: 'AI 视觉初判，非人工验收结论；照片不能证明设备已修复或验收通过',
      model: result.model,
      ms: result.ms,
      attachments: seen.map((s) => ({ id: s.id, fileName: s.fileName, mimeType: s.mimeType, sha256: s.sha256, uploadedAt: s.uploadedAt })),
      skipped: skipped.length ? skipped : undefined,
      observation: o,
      notHumanVerification: true
    }
  };
}
