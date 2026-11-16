import { ref } from 'vue';
import { clientFetch } from './client';

/**
 * 实验室监控模块可用性 —— 与服务端 VISION_MODULE 联动
 * ============================================================================
 *  部署口径（用户裁定）：本地保留完整的实验室监控模块；上传部署到线上服务器的
 *  部分不显示该模块。服务端设 VISION_MODULE=off 时 /api/vision/* 一律
 *  404 {error:'vision_disabled'}（server/api/vision-api.ts），前端据此隐藏
 *  全部监控入口（PC VisionPanel / 移动端实验室工具栏按钮与监控视图）。
 *  探针以 404 为唯一「下线」判据；不缓存结果，登录前后重复探测无副作用。
 */
export const visionAvailable = ref(false);

export function probeVisionModule(): Promise<void> {
  return clientFetch('/api/vision/status')
    .then((res) => { visionAvailable.value = res.status !== 404; })
    .catch(() => { visionAvailable.value = true; });
}
