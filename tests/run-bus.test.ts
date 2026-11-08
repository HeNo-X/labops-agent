import test from 'node:test';
import assert from 'node:assert/strict';
import { RunBus } from '../server/agent/run-bus.ts';
import type { RunEvent } from '../shared/types.ts';

const event = (seq: number, text = '文字'): RunEvent => ({ seq, v: 1, runId: 'r', type: 'answer_delta', ts: '2026-11-08T00:00:00Z', payload: { text } });
function setup(options: ConstructorParameters<typeof RunBus>[0] = {}) {
  const bus = new RunBus(options);
  bus.create('r', 'c', 'owner');
  return bus;
}

test('RunBus preserves original events and uses an exclusive last-seen cursor', () => {
  const bus = setup();
  const seen: RunEvent[] = [];
  bus.subscribe('r', 'owner', e => seen.push(e));
  for (const seq of [-1, 0, 2]) bus.publish(event(seq));
  assert.deepEqual(seen, [-1, 0, 2].map(seq => event(seq)));
  assert.deepEqual(bus.read('r', 'owner', 0)?.events, [event(2)]);
  assert.deepEqual(bus.read('r', 'owner')?.events, []);
  assert.equal(bus.read('r', 'owner', -2)?.gap, false);
});

test('RunBus count eviction detects only genuinely missing retained history', () => {
  const bus = setup({ maxEvents: 2 });
  for (const seq of [0, 2, 4]) bus.publish(event(seq));
  assert.equal(bus.read('r', 'owner', -1)?.gap, true);
  assert.equal(bus.read('r', 'owner', 0)?.gap, false);
  assert.equal(bus.read('r', 'owner', 0)?.truncated, true);
  assert.deepEqual(bus.read('r', 'owner', 0)?.events.map(e => e.seq), [2, 4]);
});

test('RunBus UTF-8 byte cap drops oversize events but live subscribers receive them intact', () => {
  const e = event(0, '汉字'.repeat(100));
  const size = Buffer.byteLength(JSON.stringify(e));
  const bus = setup({ maxBytes: size - 1 });
  let live: RunEvent | undefined;
  bus.subscribe('r', 'owner', e => { live = e; });
  bus.publish(e);
  assert.deepEqual(live, e);
  assert.equal(bus.read('r', 'owner', -1)?.bytes, 0);
  assert.equal(bus.read('r', 'owner', -1)?.gap, true);
  bus.publish(event(1));
  assert.deepEqual(bus.read('r', 'owner', 0)?.events, [event(1)]);
});

test('RunBus subscriptions are isolated by owner and subscriber failure does not stop production', () => {
  const bus = setup();
  assert.equal(bus.read('r', 'other'), null);
  assert.equal(bus.subscribe('r', 'other', () => {}), null);
  assert.equal(bus.read('missing', 'owner'), null);
  bus.subscribe('r', 'owner', () => { throw new Error('disconnected'); });
  const seen: number[] = [];
  const unsubscribe = bus.subscribe('r', 'owner', e => seen.push(e.seq))!;
  bus.publish(event(0));
  unsubscribe();
  unsubscribe();
  bus.publish(event(1));
  assert.deepEqual(seen, [0]);
  assert.equal(bus.read('r', 'owner')?.status, 'running');
});

test('RunBus stored history and other listeners cannot be mutated by callers', () => {
  const bus = setup();
  bus.subscribe('r', 'owner', e => { (e.payload as { text: string }).text = 'changed'; });
  const seen: RunEvent[] = [];
  bus.subscribe('r', 'owner', e => seen.push(e));
  const original = event(0);
  bus.publish(original);
  (original.payload as { text: string }).text = 'later';
  const read = bus.read('r', 'owner', -1)!;
  (read.events[0]!.payload as { text: string }).text = 'read mutation';
  assert.deepEqual(bus.read('r', 'owner', -1)?.events, [event(0)]);
  assert.deepEqual(seen, [event(0)]);
});

test('RunBus finalization is explicit and idempotent, terminal TTL does not evict active runs', () => {
  let now = 0;
  const bus = setup({ clock: () => now, ttlMs: 100 });
  bus.publish({ ...event(0), type: 'run_completed' });
  assert.equal(bus.read('r', 'owner')?.status, 'running');
  bus.finish('r', 'interrupted');
  now = 50;
  bus.finish('r', 'completed');
  assert.equal(bus.read('r', 'owner')?.status, 'interrupted');
  assert.equal(bus.read('r', 'owner')?.endedAt, 0);
  assert.equal(bus.subscribe('r', 'owner', () => {}), null);
  assert.throws(() => bus.publish(event(1)));
  bus.create('active', 'c', 'owner');
  now = 99;
  assert.ok(bus.read('r', 'owner'));
  now = 100;
  bus.sweep();
  assert.equal(bus.read('r', 'owner'), null);
  assert.ok(bus.read('active', 'owner'));
});

test('RunBus rejects duplicate channels, invalid limits and nonmonotonic sequences', () => {
  const bus = setup();
  assert.throws(() => bus.create('r', 'other', 'other'));
  bus.publish(event(1));
  for (const seq of [1, 0, NaN, 1.5]) assert.throws(() => bus.publish(event(seq)));
  assert.throws(() => bus.read('r', 'owner', NaN));
  assert.throws(() => new RunBus({ maxEvents: 0 }));
  assert.throws(() => new RunBus({ ttlMs: -1 }));
  assert.deepEqual(bus.read('r', 'owner', -1)?.events, [event(1)]);
});
