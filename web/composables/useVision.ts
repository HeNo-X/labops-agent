/**
 * 实验室监控（vision）共享数据层
 * ============================================================================
 *  为什么要有它：移动端 MobileVision.vue 把「取数 + 轮询 + 探活 + 快照 URL」写在组件里，
 *  PC 若再写一遍，就会出现本次审计里点名的第 3 份分叉实现。
 *  这里把数据面抽出来，PC 现在用它；移动端后续可以迁过来（本次不改他人在制品）。
 *
 *  数据全部来自本服务 /api/vision/*，未接入时 configured=false ——
 *  **界面必须给配置指引，不能拿 0 冒充"没人"**（视觉是线索不是结论）。
 */

import { computed, ref } from 'vue';
import { clientFetch, clientUrl } from '../client';

export interface VisionLab {
  labId: string;
  online: boolean;
  lastSeenAt: string;
  lastSeenEpochMs: number;
  ageSeconds: number;
  count: number;
  sceneState: string | null;
  sceneReason: string | null;
  ppeState: string | null;
  ppeMissing: number | null;
  alert: boolean;
  snapshotAvailable: boolean;
}

export interface VisionEvent {
  labId: string;
  ts: number;
  receivedAt: number;
  alert: boolean;
  count: number;
  sceneState: string | null;
  sceneReason: string | null;
  ppeState: string | null;
  cameraOnline: boolean;
}

export interface VisionStatus {
  ok: boolean;
  configured: boolean;
  labs: VisionLab[];
  eventCount: number;
  generatedAt: string;
  retentionNote: string;
}

/** 状态判新鲜的阈值：与 monitor.ts 的 120s 口径保持一致，别各说各话 */
const STALE_SECONDS = 120;

export function useVision(pollMs = 15_000) {
  const status = ref<VisionStatus | null>(null);
  const events = ref<VisionEvent[]>([]);
  const loading = ref(false);
  const error = ref('');
  /** null = 还没探过；true = 内网 MJPEG 可达；false = 不可达（云端部署的常态） */
  const liveAvailable = ref<boolean | null>(null);
  const lastRefreshedAt = ref(0);

  let timer: number | null = null;
  let busy = false;

  const configured = computed(() => status.value?.configured === true);
  const labs = computed<VisionLab[]>(() => status.value?.labs ?? []);
  const alertLabs = computed(() => labs.value.filter((lab) => lab.alert));
  const onlineCount = computed(() => labs.value.filter((lab) => lab.online).length);
  /**
   * 只合计**在线**房间。离线房间的 count 是最后那次上报的旧值，
   * 加进"合计"会让用户以为"现在一共有这么多人" —— 视觉是线索不是结论。
   */
  const totalCount = computed(() =>
    labs.value.filter((lab) => lab.online).reduce((sum, lab) => sum + lab.count, 0)
  );

  /** 通道级状态，供顶栏用一个徽标表达 */
  const channel = computed<'unconfigured' | 'alert' | 'live' | 'idle' | 'error'>(() => {
    if (error.value) return 'error';
    if (status.value && !configured.value) return 'unconfigured';
    if (alertLabs.value.length) return 'alert';
    if (labs.value.some((lab) => lab.online)) return 'live';
    return 'idle';
  });

  function staleLabel(lab: VisionLab): string {
    if (!lab.online) return '离线';
    if (lab.ageSeconds <= STALE_SECONDS) return `${lab.ageSeconds} 秒前`;
    return `数据已过期（${Math.round(lab.ageSeconds / 60)} 分钟前）`;
  }

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    if (!status.value) loading.value = true;
    try {
      const [statusRes, eventsRes] = await Promise.all([
        clientFetch('/api/vision/status'),
        clientFetch('/api/vision/events?limit=30')
      ]);
      if (statusRes.status === 401) throw new Error('请先登录主系统账号');
      if (!statusRes.ok) throw new Error(`status 接口返回 ${statusRes.status}`);
      const statusJson = (await statusRes.json()) as VisionStatus;
      const eventsJson = eventsRes.ok ? ((await eventsRes.json()) as { events?: VisionEvent[] }) : {};
      status.value = statusJson;
      events.value = eventsJson.events ?? [];
      lastRefreshedAt.value = Date.now();
      error.value = '';
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      busy = false;
      loading.value = false;
    }
  }

  /** 拓扑感知：只有本服务与 vision 同机/同内网时才返回可达，云端不造假画面 */
  async function probeLive(): Promise<void> {
    try {
      const res = await clientFetch('/api/vision/live-probe');
      if (!res.ok) {
        liveAvailable.value = false;
        return;
      }
      const json = (await res.json()) as { available?: boolean; ok?: boolean };
      // ⚠️ live-probe 恒返回 {ok:true, available:<bool>}：ok 只表示"探测请求本身成功"，
      // 不代表画面可用。只信 available —— 否则云端部署会误渲染 /feed 而拿到 502。
      liveAvailable.value = json.available === true;
    } catch {
      liveAvailable.value = false;
    }
  }

  function snapshotUrl(lab: VisionLab): string {
    // t 用 lastSeenEpochMs 做缓存击穿键：同一帧不会反复重下
    return clientUrl(`/api/vision/snapshot?lab=${encodeURIComponent(lab.labId)}&t=${lab.lastSeenEpochMs}`);
  }

  function feedUrl(): string {
    return clientUrl('/api/vision/feed');
  }

  function start(): void {
    stop();
    void refresh();
    void probeLive();
    timer = window.setInterval(() => void refresh(), pollMs);
  }

  function stop(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  return {
    status,
    events,
    loading,
    error,
    liveAvailable,
    lastRefreshedAt,
    configured,
    labs,
    alertLabs,
    onlineCount,
    totalCount,
    channel,
    staleLabel,
    refresh,
    probeLive,
    snapshotUrl,
    feedUrl,
    start,
    stop
  };
}
