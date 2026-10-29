/**
 * 设备内置摄像头（本机相机）
 * ============================================================================
 *  与「实验室场内摄像头」完全两回事：
 *    · 场内摄像头 = 边缘机上报的剥离身份 JSON（走 /api/vision/*）
 *    · 内置摄像头 = **本机** getUserMedia 预览，画面只在本机渲染
 *
 *  三条硬约束：
 *  1) **不上传**：只把 MediaStream 绑给 <video>，不做任何 POST、不写证据、不落盘。
 *  2) **不请求麦克风**：`audio: false`。这是监控预览，不是录音。
 *  3) **必须给可执行的失败原因**：浏览器要 HTTPS/localhost 才能开摄像头，
 *     手机用 http://内网IP 打开时 API 直接不存在 —— 这种"看起来是 bug"的情况必须说清楚。
 *
 *  前后置切换：`facingMode: 'user' | 'environment'`；桌面端多数只有一个摄像头，
 *  切换会以 OverconstrainedError 失败，此时回退到 `{ video: true }` 而不是报错。
 */

import { onUnmounted, ref, shallowRef } from 'vue';

export type Facing = 'user' | 'environment';

export interface CameraFailure {
  code: 'unsupported' | 'insecure' | 'denied' | 'notfound' | 'busy' | 'unknown';
  message: string;
}

const FALLBACK: Record<string, CameraFailure> = {
  denied: {
    code: 'denied',
    message: '浏览器拒绝了摄像头权限。请在地址栏的权限图标里允许摄像头后重试。'
  },
  notfound: { code: 'notfound', message: '这台设备上没有可用的摄像头。' },
  busy: { code: 'busy', message: '摄像头被其它程序占用（如会议软件）。关掉占用它的程序后重试。' },
  unknown: { code: 'unknown', message: '开启摄像头失败，请重试。' }
};

export function useCamera() {
  const active = ref(false);
  const starting = ref(false);
  const failure = ref<CameraFailure | null>(null);
  const facing = ref<Facing>('user');
  const deviceLabel = ref('');
  const resolution = ref<{ width: number; height: number } | null>(null);
  /** 枚举到的摄像头数量：>1 才显示"切换前/后置" */
  const cameraCount = ref(0);
  /** 当前是否真的切到了后置（有些设备 facingMode 无法确认，以实际设置回读为准） */
  const actualFacing = ref<Facing | null>(null);

  const stream = shallowRef<MediaStream | null>(null);
  let videoEl: HTMLVideoElement | null = null;

  function supported(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
  }

  /** HTTPS / localhost 之外，浏览器不提供 mediaDevices —— 先把这条讲清楚 */
  function insecureContext(): boolean {
    return typeof window !== 'undefined' && window.isSecureContext === false;
  }

  async function countCameras(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      cameraCount.value = devices.filter((d) => d.kind === 'videoinput').length;
    } catch {
      cameraCount.value = 0;
    }
  }

  function teardown(): void {
    stream.value?.getTracks().forEach((track) => track.stop());
    stream.value = null;
    if (videoEl) videoEl.srcObject = null;
    active.value = false;
    resolution.value = null;
    actualFacing.value = null;
  }

  function mapError(error: unknown): CameraFailure {
    const name = (error as { name?: string })?.name ?? '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return FALLBACK['denied']!;
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return FALLBACK['notfound']!;
    if (name === 'NotReadableError' || name === 'TrackStartError') return FALLBACK['busy']!;
    return FALLBACK['unknown']!;
  }

  /**
   * 打开摄像头并绑定到 <video>。
   * @param el 目标 video 元素（必须 muted + playsinline，否则 iOS 不会自动播放）
   */
  async function start(el: HTMLVideoElement | null, preferred?: Facing): Promise<void> {
    videoEl = el;
    if (preferred) facing.value = preferred;
    failure.value = null;

    if (!supported()) {
      failure.value = insecureContext()
        ? {
            code: 'insecure',
            message:
              '当前页面不是 HTTPS（或 localhost），浏览器不允许调用摄像头。请用 https:// 或在本机 http://127.0.0.1 打开。'
          }
        : { code: 'unsupported', message: '当前浏览器不支持摄像头调用。' };
      return;
    }

    starting.value = true;
    teardown();
    try {
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing.value } },
          audio: false
        });
      } catch (error) {
        // 桌面端或单摄像头设备对 facingMode 会抛 OverconstrainedError → 回退到任意摄像头
        if ((error as { name?: string })?.name !== 'OverconstrainedError') throw error;
        media = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      stream.value = media;
      const track = media.getVideoTracks()[0] ?? null;
      const settings = track?.getSettings?.() ?? {};
      resolution.value =
        settings.width && settings.height ? { width: settings.width, height: settings.height } : null;
      deviceLabel.value = track?.label ?? '';
      actualFacing.value =
        settings.facingMode === 'user' || settings.facingMode === 'environment' ? settings.facingMode : null;

      if (track) {
        // 设备被拔出 / 用户收回权限时，及时把界面切回"未开启"，不要留一张冻结的画面
        track.addEventListener('ended', () => teardown());
      }

      if (videoEl) {
        videoEl.srcObject = media;
        await videoEl.play().catch(() => undefined);
      }
      active.value = true;
      await countCameras();
    } catch (error) {
      teardown();
      failure.value = mapError(error);
    } finally {
      starting.value = false;
    }
  }

  /** 前/后置切换：必须停掉旧轨再重开，否则部分安卓机报 NotReadableError */
  async function flip(): Promise<void> {
    if (!active.value) return;
    const next: Facing = facing.value === 'user' ? 'environment' : 'user';
    await start(videoEl, next);
  }

  function stop(): void {
    teardown();
    failure.value = null;
  }

  onUnmounted(() => teardown());

  return {
    active,
    starting,
    failure,
    facing,
    actualFacing,
    deviceLabel,
    resolution,
    cameraCount,
    stream,
    supported,
    insecureContext,
    start,
    flip,
    stop
  };
}
