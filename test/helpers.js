import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'p2p-test-'));
}

export async function makeRandomFile(dir, name, size) {
  const data = crypto.randomBytes(size);
  const p = path.join(dir, name);
  await fs.writeFile(p, data);
  return { path: p, data };
}

// Builds metadata independently of src/metadata so storage tests don't depend on torrent.js.
export function buildMeta(data, name, pieceLength) {
  const pieces = [];
  for (let pos = 0; pos < data.length; pos += pieceLength) {
    pieces.push(sha256hex(data.subarray(pos, Math.min(pos + pieceLength, data.length))));
  }
  return { name, length: data.length, pieceLength, pieces };
}
