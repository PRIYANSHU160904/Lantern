import test from 'node:test';
import assert from 'node:assert/strict';
import { Choker } from '../src/peer/choker.js';

const P = (id, interested, downRate = 0, upRate = 0, uploaded = 0, downloaded = 0) => ({ id, interested, downRate, upRate, uploaded, downloaded });

test('leecher: unchokes the peers that upload to us fastest (tit-for-tat)', () => {
  const c = new Choker({ slots: 2, optimisticEvery: 99 });
  const peers = [P('slow', true, 10), P('fast', true, 900), P('mid', true, 300), P('free', true, 0)];
  const out = c.select(peers);
  assert.ok(out.has('fast') && out.has('mid'));
  assert.ok(!out.has('slow') || !out.has('free') || out.size > 2);
  assert.equal([...out].filter((id) => id === 'fast' || id === 'mid').length, 2);
});

test('peers that are not interested are never unchoked', () => {
  const c = new Choker({ slots: 3 });
  const out = c.select([P('a', false, 999), P('b', true, 1)]);
  assert.ok(!out.has('a') && out.has('b'));
});

test('optimistic slot gives one extra peer a chance (free-rider bootstrap)', () => {
  const c = new Choker({ slots: 1, optimisticEvery: 3, random: () => 0 });
  const out = c.select([P('best', true, 500), P('newbie', true, 0), P('other', true, 0)]);
  assert.equal(out.size, 2);
  assert.ok(out.has('best'));
});

test('free-rider never earns a regular slot; contributors do', () => {
  const c = new Choker({ slots: 2, optimisticEvery: 3 });
  const peers = [P('g1', true, 400), P('g2', true, 300), P('g3', true, 200), P('leech', true, 0)];
  for (let r = 0; r < 30; r++) {
    const out = c.select(peers);
    const regular = [...out].filter((id) => id !== c.optimisticId);
    assert.deepEqual(regular.sort(), ['g1', 'g2'], `round ${r}`);
    assert.ok(out.size <= 3, 'at most slots + 1 optimistic');
  }
});

test('optimistic peer is kept for N rounds, then rotated', () => {
  const c = new Choker({ slots: 0, optimisticEvery: 2 });
  const peers = [P('a', true), P('b', true), P('c', true), P('d', true)];
  const picks = [];
  for (let r = 0; r < 40; r++) picks.push([...c.select(peers)][0]);
  for (let r = 0; r < 40; r += 2) assert.equal(picks[r], picks[r + 1], `rounds ${r},${r + 1} share one optimistic peer`);
  assert.ok(new Set(picks).size > 1, 'the optimistic slot must rotate over time');
});

test('seed serves the LEAST-served peers first, so a fast puller cannot hog it', () => {
  const c = new Choker({ slots: 1, optimisticEvery: 99 });
  const out = c.select([P('hog', true, 0, 999, 5_000_000), P('fresh', true, 0, 0, 0)], { isSeed: true });
  assert.ok(out.has('fresh'));
});

test('ties in recent rate are broken by how much a peer has given us in total (memory)', () => {
  const c = new Choker({ slots: 1, optimisticEvery: 99, random: () => 0.99 });
  const peers = [P('stranger', true, 0, 0, 0, 0), P('old-friend', true, 0, 0, 0, 900_000), P('stranger2', true, 0, 0, 0, 0)];
  assert.ok(c.select(peers).has('old-friend'));
});

test('deadbeats (we gave a lot, got ~nothing) never take a slot from a contributor', () => {
  const c = new Choker({ slots: 1, optimisticEvery: 3, graceBytes: 100 });
  const peers = [P('good', true, 50, 0, 1000, 800), P('leech', true, 0, 0, 5000, 0), P('good2', true, 40, 0, 1000, 700)];
  for (let r = 0; r < 30; r++) {
    const out = c.select(peers);
    assert.ok(!out.has('leech'), `round ${r}: deadbeat must not be unchoked while contributors want slots`);
    assert.equal(out.size, 2);
  }
});

test('deadbeats still get FREE slots (no capacity is wasted), and newcomers inside the grace allowance are not judged', () => {
  const c = new Choker({ slots: 2, optimisticEvery: 3, graceBytes: 100 });
  assert.ok(c.select([P('good', true, 50, 0, 1000, 900), P('leech', true, 0, 0, 5000, 0)]).has('leech'));
  const c2 = new Choker({ slots: 1, optimisticEvery: 99, graceBytes: 10_000, random: () => 0 });
  const out = c2.select([P('a', true, 9, 0, 200, 200), P('newbie', true, 0, 0, 500, 0)]);
  assert.ok(out.has('newbie'), 'under the grace allowance a peer is not a deadbeat');
});

test('fewer interested peers than slots: everyone interested is unchoked', () => {
  const c = new Choker({ slots: 4 });
  assert.deepEqual([...c.select([P('a', true), P('b', true)])].sort(), ['a', 'b']);
});
