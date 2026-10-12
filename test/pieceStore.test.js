import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PieceStore } from '../src/storage/pieceStore.js';
import { makeTempDir, makeRandomFile, buildMeta, sha256hex } from './helpers.js';

const PL = 1024;
const SIZE = 10 * PL + 300; // 11 pieces, last one is 300 bytes
const N = 11;

async function setup() {
  const dir = await makeTempDir();
  const { data } = await makeRandomFile(dir, 'orig.bin', SIZE);
  const meta = buildMeta(data, 'orig.bin', PL);
  const target = path.join(dir, 'download.bin');
  const piece = (i) => data.subarray(i * PL, Math.min((i + 1) * PL, data.length));
  return { dir, data, meta, target, piece };
}

test('open: creates a preallocated file with an empty bitfield', async () => {
  const { meta, target } = await setup();
  const store = await PieceStore.open(meta, target);
  assert.equal((await fs.stat(target)).size, SIZE);
  assert.equal(store.bitfield.count(), 0);
  assert.equal(store.isComplete(), false);
  assert.equal(store.has(0), false);
  await store.close();
});

test('open: existing file of the wrong size is resized', async () => {
  const { meta, target } = await setup();
  await fs.writeFile(target, Buffer.alloc(5));
  const store = await PieceStore.open(meta, target);
  assert.equal((await fs.stat(target)).size, SIZE);
  assert.equal(store.bitfield.count(), 0);
  await store.close();
});

test('verify: accepts correct data, rejects wrong content and wrong length', async () => {
  const { meta, target, piece } = await setup();
  const store = await PieceStore.open(meta, target);
  assert.equal(store.verify(3, piece(3)), true);
  assert.equal(store.verify(10, piece(10)), true); // short last piece

  const flipped = Buffer.from(piece(3)); flipped[0] ^= 0xff;
  assert.equal(store.verify(3, flipped), false);
  assert.equal(store.verify(3, piece(4)), false);            // valid piece, wrong index
  assert.equal(store.verify(0, piece(0).subarray(0, PL - 1)), false); // too short
  assert.equal(store.verify(10, Buffer.concat([piece(10), Buffer.alloc(1)])), false); // too long
  assert.equal(store.has(3), false, 'verify must not mark the piece as stored');
  await store.close();
});

test('write: corrupt data is rejected and nothing changes (bitfield or disk)', async () => {
  const { meta, target, piece } = await setup();
  const store = await PieceStore.open(meta, target);
  const bad = Buffer.from(piece(2)); bad[10] ^= 0x01;
  await assert.rejects(store.write(2, bad));
  assert.equal(store.has(2), false);
  assert.equal(store.bitfield.count(), 0);
  const onDisk = (await fs.readFile(target)).subarray(2 * PL, 3 * PL);
  assert.ok(onDisk.equals(Buffer.alloc(PL)), 'disk must be untouched');
  await store.close();
});

test('write: pieces in random order reassemble to a byte-identical file', async () => {
  const { data, meta, target, piece } = await setup();
  const store = await PieceStore.open(meta, target);
  const order = [...Array(N).keys()].sort(() => Math.random() - 0.5);
  for (const i of order) await store.write(i, piece(i));
  assert.equal(store.isComplete(), true);
  assert.equal(sha256hex(await fs.readFile(target)), sha256hex(data));
  await store.close();
});

test('write: concurrent writes are safe', async () => {
  const { data, meta, target, piece } = await setup();
  const store = await PieceStore.open(meta, target);
  await Promise.all([...Array(N).keys()].map((i) => store.write(i, piece(i))));
  assert.equal(store.isComplete(), true);
  assert.equal(sha256hex(await fs.readFile(target)), sha256hex(data));
  await store.close();
});

test('write: writing the same piece twice is harmless', async () => {
  const { meta, target, piece } = await setup();
  const store = await PieceStore.open(meta, target);
  await store.write(4, piece(4));
  await store.write(4, piece(4));
  assert.equal(store.bitfield.count(), 1);
  await store.close();
});

test('read: returns stored piece; rejects for a piece we do not have', async () => {
  const { meta, target, piece } = await setup();
  const store = await PieceStore.open(meta, target);
  await assert.rejects(store.read(6));
  await store.write(6, piece(6));
  await store.write(10, piece(10));
  assert.ok((await store.read(6)).equals(piece(6)));
  assert.ok((await store.read(10)).equals(piece(10)));
  await store.close();
});

test('resume: reopening rebuilds the bitfield from the file on disk', async () => {
  const { meta, target, piece } = await setup();
  let store = await PieceStore.open(meta, target);
  for (const i of [2, 5, 10]) await store.write(i, piece(i));
  await store.close();

  store = await PieceStore.open(meta, target);
  assert.equal(store.bitfield.count(), 3);
  for (let i = 0; i < N; i++) assert.equal(store.has(i), [2, 5, 10].includes(i), `piece ${i}`);
  await store.close();
});

test('resume: a piece corrupted on disk is NOT trusted after reopen', async () => {
  const { meta, target, piece } = await setup();
  let store = await PieceStore.open(meta, target);
  for (let i = 0; i < N; i++) await store.write(i, piece(i));
  await store.close();

  const fh = await fs.open(target, 'r+');
  await fh.write(Buffer.from([0x00, 0x00]), 0, 2, 4 * PL + 7); // damage piece 4
  await fh.close();

  store = await PieceStore.open(meta, target);
  assert.equal(store.has(4), false);
  assert.equal(store.bitfield.count(), N - 1);
  assert.equal(store.isComplete(), false);
  await store.close();
});

test('out-of-range indexes', async () => {
  const { meta, target, piece } = await setup();
  const store = await PieceStore.open(meta, target);
  assert.equal(store.has(-1), false);
  assert.equal(store.has(N), false);
  assert.throws(() => store.verify(N, piece(0)), RangeError);
  await assert.rejects(store.write(N, piece(0)), RangeError);
  await assert.rejects(store.read(N), RangeError);
  await store.close();
});
