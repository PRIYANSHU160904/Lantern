import fs from "node:fs/promises";
import crypto from "node:crypto";
import { Bitfield } from "../protocol/bitfield.js";
import { numPieces, pieceLengthAt } from "../metadata/torrent.js";

export class PieceStore {
  constructor(meta, fh) {
    this.meta = meta;
    this.fh = fh;
    this.bitfield = new Bitfield(numPieces(meta));
  }

  static async open(meta, filePath) {
    let fh;
    try {
      fh = await fs.open(filePath, "r+");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fh = await fs.open(filePath, "w+");
    }

    if ((await fh.stat()).size !== meta.length) await fh.truncate(meta.length);

    const store = new PieceStore(meta, fh);
    for (let i = 0; i < numPieces(meta); i++) {
      const len = pieceLengthAt(meta, i);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, i * meta.pieceLength);
      if (store.verify(i, buf)) store.bitfield.set(i);
    }
    return store;
  }

  has(i) {
    return this.bitfield.has(i);
  }

  verify(i, data) {
    if (data.length !== pieceLengthAt(this.meta, i)) return false;
    return (
      crypto.createHash("sha256").update(data).digest("hex") ===
      this.meta.pieces[i]
    );
  }

  async write(i, data) {
    pieceLengthAt(this.meta, i);
    if (!this.verify(i, data))
      throw new Error(`piece ${i} failed verification`);
    if (this.has(i)) return;

    await this.fh.write(data, 0, data.length, i * this.meta.pieceLength);
    this.bitfield.set(i);
  }

  async read(i) {
    const len = pieceLengthAt(this.meta, i);
    if (!this.has(i)) throw new Error(`do not have piece ${i}`);
    const buf = Buffer.alloc(len);
    await this.fh.read(buf, 0, len, i * this.meta.pieceLength);
    return buf;
  }

  isComplete() {
    return this.bitfield.isComplete();
  }
  async close() {
    await this.fh.close();
  }
}
