// End-to-end tests: real tracker, real TCP, real files. These need YOUR torrent.js and pieceStore.js to work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTracker } from '../src/tracker/server.js';
import { Peer } from '../src/peer/peer.js';
import { PieceStore } from '../src/storage/pieceStore.js';
import { createMetadata } from '../src/metadata/torrent.js';
import { encode } from '../src/protocol/codec.js';
import { makeTempDir, makeRandomFile, sha256hex } from './helpers.js';

const until = async (fn, ms = 20000, label = 'condition') => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function env({ size = 3 * 1024 * 1024 + 12345, pieceLength = 64 * 1024 } = {}) { // +12345 => the last piece is SHORT
  const dir = await makeTempDir();
  const { path: orig, data } = await makeRandomFile(dir, 'orig.bin', size);
  const meta = await createMetadata(orig, pieceLength);
  const tracker = createTracker({ port: 0, host: '127.0.0.1', intervalSec: 1 });
  const trackerUrl = `http://127.0.0.1:${await tracker.listen()}`;
  const peers = [];
  async function spawn(name, { seed = false, ...opts } = {}) {
    const file = path.join(dir, `${name}.bin`);
    if (seed) await fs.copyFile(orig, file);
    const store = await PieceStore.open(meta, file);
    const peer = new Peer({
      meta, store, name, host: '127.0.0.1', port: 0, trackerUrl,
      chokeIntervalMs: 300, requestTimeoutMs: 3000, log: () => {}, ...opts,
    });
    await peer.start();
    peer.file = file;
    peers.push(peer);
    return peer;
  }
  const hash = sha256hex(data);
  const identical = async (p) => sha256hex(await fs.readFile(p.file)) === hash;
  async function cleanup() {
    for (const p of peers) p.kill();
    await tracker.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
  return { meta, tracker, spawn, cleanup, identical };
}

test('swarm: 3 leechers finish from one throttled seed, trading pieces with each other', async () => {
  const e = await env();
  try {
    await e.spawn('seed', { seed: true, uploadLimit: 1_500_000 });
    const ls = [await e.spawn('A'), await e.spawn('B'), await e.spawn('C')];
    await until(() => ls.every((l) => l.complete), 40000, 'all leechers complete');
    for (const l of ls) assert.ok(await e.identical(l), `${l.name} file must be byte-identical`);
    const fromPeers = ls.flatMap((l) => l.sourceOf).filter((s) => s && s !== 'seed' && s !== 'local');
    assert.ok(fromPeers.length > 0, 'some pieces must come from other leechers, not only the seed');
  } finally { await e.cleanup(); }
});

test('churn: a leecher dies mid-transfer, the others still finish with correct files', async () => {
  const e = await env();
  try {
    await e.spawn('seed', { seed: true, uploadLimit: 1_000_000 });
    const [a, b, c] = [await e.spawn('A'), await e.spawn('B'), await e.spawn('C')];
    await until(() => a.store.bitfield.count() >= 8, 30000, 'A has some pieces');
    assert.ok(!b.complete && !c.complete, 'must be mid-transfer when A dies');
    a.kill();
    await until(() => b.complete && c.complete, 40000, 'B and C complete');
    assert.ok(await e.identical(b) && await e.identical(c));
  } finally { await e.cleanup(); }
});

test('churn: one of two seeds dies mid-transfer, the leecher completes from the other', async () => {
  const e = await env();
  try {
    const s1 = await e.spawn('seed1', { seed: true, uploadLimit: 700_000 });
    await e.spawn('seed2', { seed: true, uploadLimit: 700_000 });
    const l = await e.spawn('L');
    await until(() => l.store.bitfield.count() >= 6, 30000, 'L has some pieces');
    assert.ok(!l.complete);
    s1.kill();
    await until(() => l.complete, 40000, 'L completes');
    assert.ok(await e.identical(l));
  } finally { await e.cleanup(); }
});

test('integrity: a malicious peer is detected, banned, and the download still completes correctly', async () => {
  const e = await env();
  try {
    await e.spawn('seed', { seed: true, uploadLimit: 800_000 });
    await e.spawn('evil', { seed: true, malicious: true });
    const l = await e.spawn('L');
    await until(() => l.complete, 40000, 'L completes');
    assert.ok(await e.identical(l), 'no corrupted byte may reach the file');
    assert.ok(l.stats.hashFailures >= 1, 'tampered pieces must have been detected');
    assert.ok(l.stats.banned >= 1, 'evil peer must be banned after 3 strikes');
  } finally { await e.cleanup(); }
});

test('discovery: killing the tracker mid-transfer does not stop connected peers', async () => {
  const e = await env();
  try {
    await e.spawn('seed', { seed: true, uploadLimit: 1_000_000 });
    const [a, b] = [await e.spawn('A'), await e.spawn('B')];
    await until(() => a.conns.size >= 1 && b.conns.size >= 1, 15000, 'peers connected');
    await e.tracker.close();
    assert.ok(!a.complete || !b.complete, 'tracker must die mid-transfer');
    await until(() => a.complete && b.complete, 40000, 'both complete without tracker');
    assert.ok(await e.identical(a) && await e.identical(b));
  } finally { await e.cleanup(); }
});

test('discovery: PEX lets a peer find others without the tracker', async () => {
  const e = await env({ size: 512 * 1024 });
  try {
    const seed = await e.spawn('seed', { seed: true, pexIntervalMs: 200 });
    const a = await e.spawn('A', { pexIntervalMs: 200 });
    await until(() => a.conns.size >= 1, 10000, 'A connected to seed');
    await e.tracker.close();
    // B knows ONLY the seed's address (as if bootstrapped by hand); it must learn about A through PEX.
    const store = await PieceStore.open(e.meta, path.join(path.dirname(seed.file), 'B.bin'));
    const b = new Peer({ meta: e.meta, store, name: 'B', host: '127.0.0.1', port: 0, pexIntervalMs: 200, log: () => {} });
    await b.start();
    b.connectToPeers([{ ip: '127.0.0.1', port: seed.port }]);
    try {
      await until(() => [...b.conns.values()].some((c) => c.name === 'A'), 10000, 'B learns about A via PEX');
    } finally { b.kill(); }
  } finally { await e.cleanup(); }
});

test('security: wrong infoHash is rejected at the handshake', async () => {
  const e = await env({ size: 128 * 1024 });
  try {
    const seed = await e.spawn('seed', { seed: true });
    const sock = net.connect({ host: '127.0.0.1', port: seed.port });
    sock.on('error', () => {});
    sock.resume(); // a paused socket never reports the server's FIN
    sock.write(encode.handshake({ infoHash: crypto.randomBytes(32), peerId: crypto.randomBytes(20), listenPort: 1234 }));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket was not closed')), 3000);
      sock.on('close', () => { clearTimeout(t); resolve(); });
    });
    assert.equal(seed.conns.size, 0);
  } finally { await e.cleanup(); }
});
