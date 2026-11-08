import type { RunEvent } from '../../shared/types.ts';

export type RunChannelStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
type Listener = (event: RunEvent) => void;
interface Channel {
  conversationId: string;
  ownerId: string;
  events: Array<{ json: string; seq: number; bytes: number }>;
  bytes: number;
  lastSeq: number;
  droppedThrough: number | null;
  status: RunChannelStatus;
  endedAt: number | null;
  listeners: Set<Listener>;
}

export class RunBus {
  private channels = new Map<string, Channel>();
  private clock: () => number;
  private maxEvents: number;
  private maxBytes: number;
  private ttlMs: number;

  constructor(options: { clock?: () => number; maxEvents?: number; maxBytes?: number; ttlMs?: number } = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxEvents = options.maxEvents ?? 2000;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 600_000;
    for (const value of [this.maxEvents, this.maxBytes, this.ttlMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('RunBus limits must be positive integers');
    }
  }

  create(runId: string, conversationId: string, ownerId: string): void {
    this.sweep();
    if (this.channels.has(runId)) throw new Error('Run channel already exists');
    this.channels.set(runId, { conversationId, ownerId, events: [], bytes: 0, lastSeq: -2,
      droppedThrough: null, status: 'running', endedAt: null, listeners: new Set() });
  }

  publish(event: RunEvent): void {
    const channel = this.channels.get(event.runId);
    if (!channel || channel.status !== 'running') throw new Error('Run channel is not running');
    if (!Number.isSafeInteger(event.seq) || event.seq <= channel.lastSeq) throw new Error('Run sequence must increase');
    const json = JSON.stringify(event);
    const bytes = Buffer.byteLength(json, 'utf8');
    channel.lastSeq = event.seq;
    channel.events.push({ json, seq: event.seq, bytes });
    channel.bytes += bytes;
    while (channel.events.length > this.maxEvents || channel.bytes > this.maxBytes) {
      const dropped = channel.events.shift()!;
      channel.bytes -= dropped.bytes;
      channel.droppedThrough = dropped.seq;
    }
    for (const listener of [...channel.listeners]) {
      try { listener(JSON.parse(json) as RunEvent); }
      catch { channel.listeners.delete(listener); }
    }
  }

  read(runId: string, ownerId: string, fromSeq?: number) {
    this.sweep();
    const channel = this.channels.get(runId);
    if (!channel || channel.ownerId !== ownerId) return null;
    const cursor = fromSeq ?? channel.lastSeq;
    if (!Number.isSafeInteger(cursor) || cursor < -2) throw new RangeError('Invalid run cursor');
    return {
      runId, conversationId: channel.conversationId, status: channel.status,
      endedAt: channel.endedAt, nextSeq: channel.lastSeq + 1,
      truncated: channel.droppedThrough !== null,
      gap: channel.droppedThrough !== null && cursor < channel.droppedThrough,
      events: channel.events.filter(event => event.seq > cursor).map(event => JSON.parse(event.json) as RunEvent),
      bytes: channel.bytes
    };
  }

  subscribe(runId: string, ownerId: string, listener: Listener): (() => void) | null {
    this.sweep();
    const channel = this.channels.get(runId);
    if (!channel || channel.ownerId !== ownerId || channel.status !== 'running') return null;
    channel.listeners.add(listener);
    return () => { channel.listeners.delete(listener); };
  }

  finish(runId: string, status: Exclude<RunChannelStatus, 'running'>): void {
    const channel = this.channels.get(runId);
    if (!channel || channel.status !== 'running') return;
    // The transport finalizes only after persistence; a generated terminal event is not a durable terminal state.
    channel.status = status;
    channel.endedAt = this.clock();
    channel.listeners.clear();
  }

  sweep(): void {
    const now = this.clock();
    for (const [id, channel] of this.channels) {
      if (channel.endedAt !== null && now - channel.endedAt >= this.ttlMs) this.channels.delete(id);
    }
  }
}
