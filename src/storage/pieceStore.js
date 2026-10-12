// On-disk piece storage with verification and resume. See the Day 1 spec. Tests: test/pieceStore.test.js
import { Bitfield } from '../protocol/bitfield.js';

export class PieceStore {
  /** Open/create the target file, preallocate it, and rebuild the bitfield by hashing what is on disk. */
  static async open(meta, filePath) {
    throw new Error('TODO');
  }

  /** @type {Bitfield} */
  bitfield;

  has(i) { throw new Error('TODO'); }
  verify(i, data) { throw new Error('TODO'); }
  async write(i, data) { throw new Error('TODO'); }
  async read(i) { throw new Error('TODO'); }
  isComplete() { throw new Error('TODO'); }
  async close() { throw new Error('TODO'); }
}
