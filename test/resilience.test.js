// More end-to-end scenarios: edge-case files, restart/resume, late joiners, simultaneous dials,
// and the signature P2P property: the swarm survives losing its ONLY seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTracker } from '../src/tracker/server.js';
import { Peer } from '../src/peer/peer.js';
import { PieceStore } from '../src/storage/pieceStore.js';
import { createMetadata } from '../src/metadata/torrent.js';
import { makeTempDir, makeRandomFile, sha256hex } from './helpers.js';

const until = async (fn, ms = 20000, label = 'condition') => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function env({ size = 2 * 1024 * 1024 + 999, pieceLength = 64 * 1024, tracker: useTracker = true } = {}) {
  const dir = await makeTempDir();
  const { path: orig, data } = await makeRandomFile(dir, 'orig.bin', size);
  const meta = await createMetadata(orig, pieceLength);
  let tracker = null, trackerUrl = null;
  if (useTracker) {
    tracker = createTracker({ port: 0, host: '127.0.0.1', intervalSec: 1 });
    trackerUrl = `http://127.0.0.1:${await tracker.listen()}`;
  }
  const peers = [];
  async function spawn(name, { seed = false, file, ...opts } = {}) {
    file ??= path.join(dir, `${name}.bin`);
    if (seed) await fs.copyFile(orig, file);
    const store = await PieceStore.open(meta, file);
    const peer = new Peer({
      meta, store, name, host: '127.0.0.1', port: 0, trackerUrl, chokeIntervalMs: 300,
      requestTimeoutMs: 3000, log: () => {}, ...opts,
    });
    await peer.start();
    peer.file = file; peers.push(peer);
    return peer;
  }
  const hash = sha256hex(data);
  return {
    meta, tracker, spawn, dir,
    identical: async (p) => sha256hex(await fs.readFile(p.file)) === hash,
    async cleanup() { for (const p of peers) p.kill(); await tracker?.close(); await fs.rm(dir, { recursive: true, force: true }); },
  };
}

test('edge: file smaller than one piece (single short piece)', async () => {
  const e = await env({ size: 10_000 });
  try {
    await e.spawn('seed', { seed: true });
    const l = await e.spawn('L');
    await until(() => l.complete, 15000, 'L completes');
    assert.equal(e.meta.pieces.length, 1);
    assert.ok(await e.identical(l));
  } finally { await e.cleanup(); }
});

test('edge: file whose last piece is short is reassembled exactly', async () => {
  const e = await env({ size: 5 * 64 * 1024 + 1 }); // last piece is 1 byte
  try {
    await e.spawn('seed', { seed: true });
    const l = await e.spawn('L');
    await until(() => l.complete, 15000, 'L completes');
    assert.equal(e.meta.pieces.length, 6);
    assert.ok(await e.identical(l));
  } finally { await e.cleanup(); }
});

test('simultaneous dials: both peers dial each other at once -> exactly one connection survives on each side', async () => {
  const e = await env({ tracker: false, size: 256 * 1024 });
  try {
    const a = await e.spawn('A', { seed: true });
    const b = await e.spawn('B');
    for (let round = 0; round < 3; round++) { // repeat: the race is timing dependent
      a.connectToPeers([{ ip: '127.0.0.1', port: b.port }]);
      b.connectToPeers([{ ip: '127.0.0.1', port: a.port }]);
      await new Promise((r) => setTimeout(r, 300));
    }
    await until(() => b.complete, 15000, 'B completes');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(a.conns.size, 1);
    assert.equal(b.conns.size, 1);
    assert.ok(await e.identical(b));
  } finally { await e.cleanup(); }
});

test('rejoin: a peer is killed, restarted on the same file, resumes from verified pieces and completes', async () => {
  const e = await env();
  try {
    await e.spawn('seed', { seed: true, uploadLimit: 600_000 });
    const l1 = await e.spawn('L');
    await until(() => l1.store.bitfield.count() >= 10, 30000, 'L has some pieces');
    const before = l1.store.bitfield.count();
    l1.kill();
    await new Promise((r) => setTimeout(r, 200));
    const l2 = await e.spawn('L', { file: l1.file }); // same name, same file => "restart"
    const resumed = l2.store.bitfield.count();
    assert.ok(resumed >= before - 1 && resumed > 0, `resumed ${resumed}, had ${before}`);
    assert.ok(!l2.complete);
    await until(() => l2.complete, 40000, 'L2 completes');
    assert.ok(await e.identical(l2));
    const fetched = Object.values(l2.stats.piecesFrom).reduce((a, b) => a + b, 0);
    assert.equal(fetched + resumed, e.meta.pieces.length, 'only the missing pieces are downloaded again');
  } finally { await e.cleanup(); }
});

test('late joiner: a peer that joins mid-transfer also completes', async () => {
  const e = await env();
  try {
    await e.spawn('seed', { seed: true, uploadLimit: 800_000 });
    const a = await e.spawn('A');
    await until(() => a.store.bitfield.count() >= 8, 30000, 'A has some pieces');
    const late = await e.spawn('LATE');
    await until(() => a.complete && late.complete, 40000, 'A and LATE complete');
    assert.ok(await e.identical(a) && await e.identical(late));
  } finally { await e.cleanup(); }
});

test('the swarm survives losing its ONLY seed once the leechers collectively hold every piece', async () => {
  const e = await env();
  try {
    const seed = await e.spawn('seed', { seed: true, uploadLimit: 2_000_000 });
    // leechers are slow uploaders so that exchanging pieces takes a while after the seed disappears
    const ls = [await e.spawn('A', { uploadLimit: 250_000 }), await e.spawn('B', { uploadLimit: 250_000 }), await e.spawn('C', { uploadLimit: 250_000 })];
    const n = e.meta.pieces.length;
    const union = () => { let c = 0; for (let i = 0; i < n; i++) if (ls.some((l) => l.store.has(i))) c++; return c; };
    await until(() => union() === n, 30000, 'leechers collectively hold all pieces');
    assert.ok(ls.every((l) => !l.complete), 'nobody may be complete yet, otherwise this proves nothing');
    seed.kill(); // the only seed vanishes
    await until(() => ls.every((l) => l.complete), 60000, 'leechers finish without any seed');
    for (const l of ls) assert.ok(await e.identical(l));
    const bySeed = ls.flatMap((l) => l.sourceOf).filter((s) => s === 'seed').length;
    assert.ok(bySeed < 3 * e.meta.pieces.length, 'some pieces must have come from other leechers');
  } finally { await e.cleanup(); }
});

test('a saturated uploader says BUSY instead of queueing without bound (no timeout storms)', async () => {
  const e = await env({ size: 1024 * 1024, pieceLength: 256 * 1024 });
  try {
    await e.spawn('seed', { seed: true, uploadLimit: 300_000 }); // 256 KiB pieces at 300 KB/s
    const ls = [await e.spawn('A'), await e.spawn('B'), await e.spawn('C')];
    await until(() => ls.every((l) => l.complete), 60000, 'all complete with a slow seed and big pieces');
    for (const l of ls) assert.ok(await e.identical(l));
  } finally { await e.cleanup(); }
});
