import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createMetadata, computeInfoHash, numPieces, pieceLengthAt, saveMetadata, loadMetadata,
} from '../src/metadata/torrent.js';
import { makeTempDir, makeRandomFile, sha256hex } from './helpers.js';

const PL = 1024;
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const validMeta = () => ({ name: 'x.bin', length: 2048, pieceLength: PL, pieces: [H1, H2] });

test('createMetadata: fields and per-piece SHA-256 hashes', async () => {
  const dir = await makeTempDir();
  const { path: p, data } = await makeRandomFile(dir, 'a.bin', 10 * PL + 300);
  const meta = await createMetadata(p, PL);
  assert.equal(meta.name, 'a.bin');
  assert.equal(meta.length, 10 * PL + 300);
  assert.equal(meta.pieceLength, PL);
  assert.equal(meta.pieces.length, 11);
  for (let i = 0; i < 11; i++) {
    const slice = data.subarray(i * PL, Math.min((i + 1) * PL, data.length));
    assert.equal(meta.pieces[i], sha256hex(slice), `piece ${i}`);
  }
});

test('createMetadata: file that is an exact multiple of pieceLength has no extra piece', async () => {
  const dir = await makeTempDir();
  const { path: p } = await makeRandomFile(dir, 'b.bin', 4 * PL);
  const meta = await createMetadata(p, PL);
  assert.equal(meta.pieces.length, 4);
  assert.equal(numPieces(meta), 4);
  assert.equal(pieceLengthAt(meta, 3), PL);
});

test('createMetadata: file smaller than one piece -> single short piece', async () => {
  const dir = await makeTempDir();
  const { path: p } = await makeRandomFile(dir, 'c.bin', 100);
  const meta = await createMetadata(p, PL);
  assert.equal(numPieces(meta), 1);
  assert.equal(pieceLengthAt(meta, 0), 100);
});

test('createMetadata: default pieceLength is 256 KiB', async () => {
  const dir = await makeTempDir();
  const { path: p } = await makeRandomFile(dir, 'd.bin', 1000);
  assert.equal((await createMetadata(p)).pieceLength, 262144);
});

test('createMetadata: empty file is rejected', async () => {
  const dir = await makeTempDir();
  const p = path.join(dir, 'empty.bin');
  await fs.writeFile(p, '');
  await assert.rejects(createMetadata(p, PL));
});

test('numPieces / pieceLengthAt: last piece is shorter', () => {
  const meta = { name: 'x', length: 10 * PL + 300, pieceLength: PL, pieces: new Array(11).fill(H1) };
  assert.equal(numPieces(meta), 11);
  assert.equal(pieceLengthAt(meta, 0), PL);
  assert.equal(pieceLengthAt(meta, 9), PL);
  assert.equal(pieceLengthAt(meta, 10), 300);
});

test('pieceLengthAt: out-of-range index throws RangeError', () => {
  const meta = validMeta();
  assert.throws(() => pieceLengthAt(meta, -1), RangeError);
  assert.throws(() => pieceLengthAt(meta, 2), RangeError);
});

test('computeInfoHash: 32-byte Buffer, deterministic, independent of key order', () => {
  const a = validMeta();
  const b = { pieces: [H1, H2], pieceLength: PL, length: 2048, name: 'x.bin' };
  const h = computeInfoHash(a);
  assert.ok(Buffer.isBuffer(h));
  assert.equal(h.length, 32);
  assert.ok(h.equals(computeInfoHash(b)));
  assert.ok(h.equals(computeInfoHash(a)));
});

test('computeInfoHash: changes when any field changes', () => {
  const base = computeInfoHash(validMeta());
  const m1 = validMeta(); m1.pieces[1] = 'c'.repeat(64);
  const m2 = validMeta(); m2.name = 'y.bin';
  const m3 = validMeta(); m3.length = 2047;
  const m4 = validMeta(); m4.pieceLength = 512;
  for (const m of [m1, m2, m3, m4]) assert.ok(!base.equals(computeInfoHash(m)));
});

test('save/load round-trip', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'x.torrent.json');
  const meta = validMeta();
  await saveMetadata(meta, file);
  assert.deepEqual(await loadMetadata(file), meta);
});

test('loadMetadata rejects malformed or inconsistent files', async () => {
  const dir = await makeTempDir();
  const bad = {
    'piece count does not match length': { ...validMeta(), pieces: [H1] },
    'hash too short': { ...validMeta(), pieces: [H1, 'abc'] },
    'hash not hex': { ...validMeta(), pieces: [H1, 'z'.repeat(64)] },
    'missing name': { length: 2048, pieceLength: PL, pieces: [H1, H2] },
    'pieceLength zero': { ...validMeta(), pieceLength: 0 },
    'pieceLength not integer': { ...validMeta(), pieceLength: 1.5 },
    'length is a string': { ...validMeta(), length: '2048' },
  };
  for (const [label, obj] of Object.entries(bad)) {
    const f = path.join(dir, `bad-${label.replace(/\W+/g, '_')}.json`);
    await fs.writeFile(f, JSON.stringify(obj));
    await assert.rejects(loadMetadata(f), undefined, label);
  }
  const garbage = path.join(dir, 'garbage.json');
  await fs.writeFile(garbage, '{not json');
  await assert.rejects(loadMetadata(garbage));
});
