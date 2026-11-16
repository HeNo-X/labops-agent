/**
 * 命令面板注册表 —— 纯数据 + 纯函数（可单测，无 Vue 依赖）
 * ============================================================================
 *  只挂**真实存在**的动作，不设占位命令：每条 run 都由调用方传入的 ctx 实现，
 *  因此注册表本身可以被单测遍历（id 唯一、分组合法、run 可调用）。
 *
 *  范围 tabs 是**筛选而非前缀快捷**：空搜索切 tab 也要展示该范围的默认内容；
 *  `>` 前缀限命令、`#` 前缀限会话，两者都与 tab 取交集。
 */

export type CommandGroup = 'suggested' | 'navigate' | 'configure' | 'session';
export type CommandScope = 'all' | 'actions' | 'sessions';

export interface Command {
  id: string;
  group: CommandGroup;
  /** 展示名（中文，走 tr()） */
  title: string;
  /** 额外匹配词：英文别名 / 同义词，让中英关键词都能命中 */
  keywords: string;
  run: () => void | Promise<void>;
}

export interface CommandContext {
  busy: boolean;
  /** 聚焦侧栏会话搜索（命令面板中的对应动作） */
  focusSidebarSearch: () => void;
  newChat: (mode?: 'chat' | 'task') => void;
  openOperations: () => void;
  openVision: () => void;
  openAutomation: () => void;
  openSettings: () => void;
  stopRun: () => void;
  actorRole: string;
  actorOptions: Array<{ role: string; label: string }>;
  switchActor: (role: string) => void;
  /** 最近会话（≤3），来自 session store 的现有列表 */
  recentSessions: Array<{ id: string; title: string }>;
  openSession: (id: string) => void;
}

export const MAX_RECENT = 3;

export function buildCommands(ctx: CommandContext): Command[] {
  const list: Command[] = [
    {
      id: 'focus-sidebar-search',
      group: 'suggested',
      title: '聚焦会话搜索',
      keywords: 'focus sidebar search conversation 搜索 chat',
      run: ctx.focusSidebarSearch
    },
    {
      id: 'new-chat',
      group: 'suggested',
      title: '新建会话',
      keywords: 'new chat conversation 新会话',
      run: () => ctx.newChat()
    },
    {
      id: 'open-settings',
      group: 'suggested',
      title: '打开设置',
      keywords: 'settings preferences 设置 偏好',
      run: ctx.openSettings
    },
    {
      id: 'open-operations',
      group: 'navigate',
      title: '打开运维台',
      keywords: 'operations console 运维 工作台',
      run: ctx.openOperations
    },
    {
      id: 'open-vision',
      group: 'navigate',
      title: '打开视觉面板',
      keywords: 'vision camera monitoring 视觉 监控 摄像头',
      run: ctx.openVision
    },
    {
      id: 'open-automation',
      group: 'navigate',
      title: '打开自动化面板',
      keywords: 'automation scheduled jobs 自动化 定时',
      run: ctx.openAutomation
    },
    {
      id: 'stop-run',
      group: 'navigate',
      title: '停止当前任务',
      keywords: 'stop cancel abort 停止 取消',
      run: ctx.stopRun
    }
  ];
  // 身份切换：仅在存在可切换身份时挂出（原生登录下没有该概念）
  for (const opt of ctx.actorOptions) {
    if (opt.role === ctx.actorRole) continue;
    list.push({
      id: `switch-actor-${opt.role}`,
      group: 'configure',
      title: `切换演示身份为${opt.label}`,
      keywords: `actor role demo ${opt.role} 身份 切换`,
      run: () => ctx.switchActor(opt.role)
    });
  }
  // 最近会话（≤3）：没有就说没有，不挂空标题
  for (const s of ctx.recentSessions.slice(0, MAX_RECENT)) {
    list.push({
      id: `session-${s.id}`,
      group: 'session',
      title: s.title,
      keywords: `session conversation 会话 ${s.title}`,
      run: () => ctx.openSession(s.id)
    });
  }
  return list;
}

/** busy 时才可用的命令（停止）在空闲时应当隐藏，而不是给一个点了没反应的项 */
export function commandsForState(commands: Command[], ctx: { busy: boolean }): Command[] {
  return commands.filter((c) => c.id !== 'stop-run' || ctx.busy);
}

export interface ParsedQuery {
  text: string;
  /** '>' 前缀：只看命令 */
  commandOnly: boolean;
  /** '#' 前缀：只看会话 */
  sessionOnly: boolean;
}

export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('>')) return { text: trimmed.slice(1).trim(), commandOnly: true, sessionOnly: false };
  if (trimmed.startsWith('#')) return { text: trimmed.slice(1).trim(), commandOnly: false, sessionOnly: true };
  return { text: trimmed.trim(), commandOnly: false, sessionOnly: false };
}

function matches(c: Command, text: string): boolean {
  if (!text) return true;
  const q = text.toLowerCase();
  return c.title.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q);
}

/**
 * 筛选：先按范围（tab）与前缀收窄，再按文本模糊匹配（子串，中英一并小写化）。
 * 空搜索时**保留该范围的默认内容**（不是清空）。
 */
export function filterCommands(commands: Command[], rawQuery: string, scope: CommandScope): Command[] {
  const parsed = parseQuery(rawQuery);
  const inScope = (c: Command): boolean => {
    if (parsed.sessionOnly) return c.group === 'session';
    if (parsed.commandOnly) return c.group !== 'session';
    if (scope === 'sessions') return c.group === 'session';
    if (scope === 'actions') return c.group !== 'session';
    return true;
  };
  return commands.filter((c) => inScope(c) && matches(c, parsed.text));
}

/** 分组标题（空分组不渲染标题；但注册表与顺序不因此删减） */
export const GROUP_ORDER: CommandGroup[] = ['suggested', 'navigate', 'configure', 'session'];

export const GROUP_TITLES: Record<CommandGroup, string> = {
  suggested: '建议',
  navigate: '前往',
  configure: '设置项',
  session: '最近会话'
};

export function groupCommands(commands: Command[]): Array<{ group: CommandGroup; title: string; items: Command[] }> {
  return GROUP_ORDER.map((group) => ({
    group,
    title: GROUP_TITLES[group],
    items: commands.filter((c) => c.group === group)
  })).filter((g) => g.items.length > 0);
}
