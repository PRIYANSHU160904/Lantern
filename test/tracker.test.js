import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTracker } from '../src/tracker/server.js';

const hex = (n) => crypto.randomBytes(n).toString('hex');

async function startTracker(opts = {}) {
  const t = createTracker({ port: 0, host: '127.0.0.1', ...opts });
  const port = await t.listen();
  const announce = async (p) => {
    const q = new URLSearchParams(p);
    const res = await fetch(`http://127.0.0.1:${port}/announce?${q}`);
    return { status: res.status, body: await res.json() };
  };
  return { t, announce };
}

test('peers in the same swarm discover each other (asker excluded)', async () => {
  const { t, announce } = await startTracker();
  const ih = hex(32), a = hex(20), b = hex(20);
  const ra = await announce({ infoHash: ih, peerId: a, port: 7001 });
  assert.deepEqual(ra.body.peers, []);
  const rb = await announce({ infoHash: ih, peerId: b, port: 7002 });
  assert.equal(rb.body.peers.length, 1);
  assert.equal(rb.body.peers[0].port, 7001);
  assert.equal(rb.body.peers[0].ip, '127.0.0.1');
  const ra2 = await announce({ infoHash: ih, peerId: a, port: 7001 });
  assert.deepEqual(ra2.body.peers.map((p) => p.port), [7002]);
  await t.close();
});

test('different infoHashes are separate swarms', async () => {
  const { t, announce } = await startTracker();
  await announce({ infoHash: hex(32), peerId: hex(20), port: 7001 });
  const r = await announce({ infoHash: hex(32), peerId: hex(20), port: 7002 });
  assert.deepEqual(r.body.peers, []);
  await t.close();
});

test('event=stopped removes the peer immediately', async () => {
  const { t, announce } = await startTracker();
  const ih = hex(32), a = hex(20), b = hex(20);
  await announce({ infoHash: ih, peerId: a, port: 7001 });
  await announce({ infoHash: ih, peerId: a, port: 7001, event: 'stopped' });
  const r = await announce({ infoHash: ih, peerId: b, port: 7002 });
  assert.deepEqual(r.body.peers, []);
  await t.close();
});

test('silent peers expire after the ttl (crash without goodbye)', async () => {
  const { t, announce } = await startTracker({ peerTtlMs: 150 });
  const ih = hex(32);
  await announce({ infoHash: ih, peerId: hex(20), port: 7001 });
  await new Promise((r) => setTimeout(r, 500));
  const r = await announce({ infoHash: ih, peerId: hex(20), port: 7002 });
  assert.deepEqual(r.body.peers, []);
  await t.close();
});

test('malformed announces get HTTP 400', async () => {
  const { t, announce } = await startTracker();
  const good = { infoHash: hex(32), peerId: hex(20), port: 7001 };
  for (const bad of [
    { ...good, infoHash: 'abc' }, { ...good, peerId: 'zz' }, { ...good, port: '0' },
    { ...good, port: 'x' }, { ...good, port: '70000' },
  ]) assert.equal((await announce(bad)).status, 400);
  await t.close();
});
