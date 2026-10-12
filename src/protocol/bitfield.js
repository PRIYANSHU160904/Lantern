import { ProtocolError } from "./constants.js";

// piece 0 is the MOST significant bit of byte 0.
export class Bitfield {
  constructor(numPieces, bytes) {
    this.numPieces = numPieces;
    this.bytes = bytes ?? Buffer.alloc(Math.ceil(numPieces / 8));
  }

  static fromBuffer(buf, numPieces) {
    const expected = Math.ceil(numPieces / 8);
    if (buf.length !== expected) {
      throw new ProtocolError(
        `BITFIELD length ${buf.length}, expected ${expected}`,
      );
    }
    const spare = expected * 8 - numPieces;
    if (spare > 0 && (buf[expected - 1] & ((1 << spare) - 1)) !== 0) {
      throw new ProtocolError("BITFIELD has spare bits set");
    }
    return new Bitfield(numPieces, Buffer.from(buf));
  }

  has(i) {
    if (i < 0 || i >= this.numPieces) return false;
    return ((this.bytes[i >> 3] >> (7 - (i & 7))) & 1) === 1;
  }

  set(i) {
    if (i < 0 || i >= this.numPieces)
      throw new RangeError(`piece ${i} out of range`);
    this.bytes[i >> 3] |= 1 << (7 - (i & 7));
  }

  count() {
    let n = 0;
    for (let i = 0; i < this.numPieces; i++) if (this.has(i)) n++;
    return n;
  }

  isComplete() {
    return this.count() === this.numPieces;
  }
  toBuffer() {
    return Buffer.from(this.bytes);
  }
}
