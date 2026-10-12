import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_PIECE_LENGTH = 256 * 1024;

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export async function createMetadata(
  filePath,
  pieceLength = DEFAULT_PIECE_LENGTH,
) {
  const fh = await fs.open(filePath, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) throw new Error("empty file");
    const pieces = [];
    const buf = Buffer.alloc(pieceLength);
    for (let pos = 0; pos < size; pos += pieceLength) {
      const want = Math.min(pieceLength, size - pos);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, pos + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      pieces.push(sha(buf.subarray(0, got)));
    }
    return { name: path.basename(filePath), length: size, pieceLength, pieces };
  } finally {
    await fh.close();
  }
}

export function computeInfoHash(meta) {
  const canonical = JSON.stringify([
    meta.name,
    meta.length,
    meta.pieceLength,
    meta.pieces,
  ]);
  return crypto.createHash("sha256").update(canonical).digest();
}

export const numPieces = (meta) => Math.ceil(meta.length / meta.pieceLength);

export function pieceLengthAt(meta, i) {
  const n = numPieces(meta);
  if (!Number.isInteger(i) || i < 0 || i >= n)
    throw new RangeError(`piece ${i} out of range`);
  return i === n - 1 ? meta.length - i * meta.pieceLength : meta.pieceLength;
}

export async function saveMetadata(meta, filePath) {
  await fs.writeFile(filePath, JSON.stringify(meta, null, 2));
}

export async function loadMetadata(filePath) {
  const m = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (typeof m.name !== "string" || !m.name)
    throw new Error("metadata: bad name");
  if (!Number.isInteger(m.length) || m.length <= 0)
    throw new Error("metadata: bad length");
  if (!Number.isInteger(m.pieceLength) || m.pieceLength <= 0)
    throw new Error("metadata: bad pieceLength");
  if (
    !Array.isArray(m.pieces) ||
    m.pieces.length !== Math.ceil(m.length / m.pieceLength)
  ) {
    throw new Error("metadata: piece count does not match length");
  }
  if (
    !m.pieces.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))
  ) {
    throw new Error(
      "metadata: pieces must be 64-char lowercase hex SHA-256 hashes",
    );
  }
  return m;
}
