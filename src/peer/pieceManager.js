// State:
//   availability[i]  how many connected peers have piece i            (for rarest-first)
//   peers: id -> { have: Bitfield, unchoked, inflight: Map(piece -> requestedAt), skipUntil: Map(piece -> ts) }
//   inflight: piece -> Set(peerId)                                      (who we asked for it)

import { Bitfield } from "../protocol/bitfield.js";
import { shuffle } from "../util/random.js";

export class PieceManager {
  constructor({
    numPieces,
    have,
    pipeline = 4,
    requestTimeoutMs = 10_000,
    endgamePieces = 3,
    now = () => Date.now(),
    random = Math.random,
  }) {
    Object.assign(this, {
      numPieces,
      have,
      pipeline,
      requestTimeoutMs,
      endgamePieces,
      now,
      random,
    });
    // Array tracking how many connected peers hold piece i
    this.availability = new Array(numPieces).fill(0);
    this.peers = new Map();
    this.inflight = new Map();
  }

  addPeer(id) {
    if (this.peers.has(id)) return;
    this.peers.set(id, {
      have: new Bitfield(this.numPieces),
      unchoked: false,
      inflight: new Map(),
      skipUntil: new Map(),
    });
  }

  setPeerBitfield(id, bf) {
    const p = this.peers.get(id);
    if (!p) return;
    for (let i = 0; i < this.numPieces; i++) if (bf.has(i)) this._markHas(p, i);
  }

  peerHave(id, i) {
    const p = this.peers.get(id);
    if (p && i >= 0 && i < this.numPieces) this._markHas(p, i);
  }

  _markHas(p, i) {
    if (p.have.has(i)) return;
    p.have.set(i);
    this.availability[i]++;
  }

  removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return [];
    // Decrement global piece availability for pieces this peer held
    for (let i = 0; i < this.numPieces; i++)
      if (p.have.has(i)) this.availability[i]--;
    const released = [...p.inflight.keys()];
    for (const i of released) this._release(id, p, i);
    this.peers.delete(id);
    return released;
  }

  setUnchoked(id, unchoked) {
    const p = this.peers.get(id);
    if (!p) return [];
    p.unchoked = unchoked;
    if (unchoked) return [];
    // If choked, release pending requests so other peers can be asked
    const released = [...p.inflight.keys()];
    for (const i of released) this._release(id, p, i);
    return released;
  }

  _release(id, p, i) {
    p.inflight.delete(i);
    const holders = this.inflight.get(i);
    if (holders) {
      holders.delete(id);
      if (holders.size === 0) this.inflight.delete(i);
    }
  }

  missingCount() {
    let n = 0;
    for (let i = 0; i < this.numPieces; i++) if (!this.have(i)) n++;
    return n;
  }

  nextRequests() {
    const out = [];
    const missing = this.missingCount();
    if (missing === 0) return out;
    const endgame = missing <= this.endgamePieces;
    const t = this.now();
    // Randomize peer iteration order to ensure fair request distribution
    for (const id of shuffle([...this.peers.keys()], this.random)) {
      const p = this.peers.get(id);
      if (!p.unchoked) continue;
      // Fill request pipeline up to max concurrency depth
      while (p.inflight.size < this.pipeline) {
        const i = this._pick(p, endgame, t);
        if (i < 0) break;
        p.inflight.set(i, t);
        if (!this.inflight.has(i)) this.inflight.set(i, new Set());
        this.inflight.get(i).add(id);
        out.push({ peerId: id, index: i });
      }
    }
    return out;
  }

  _pick(p, endgame, t) {
    let bestAvail = Infinity;
    let candidates = [];
    for (let i = 0; i < this.numPieces; i++) {
      if (!p.have.has(i) || this.have(i) || p.inflight.has(i)) continue;
      if ((p.skipUntil.get(i) ?? 0) > t) continue;
      const holders = this.inflight.get(i)?.size ?? 0;
      // Allow duplicate requests only during endgame mode to prevent slow peer tail latency
      if (holders > 0 && !(endgame && holders < 2)) continue;
      const a = this.availability[i];
      if (a < bestAvail) {
        bestAvail = a;
        candidates = [i];
      } else if (a === bestAvail) candidates.push(i);
    }
    if (candidates.length === 0) return -1;
    return candidates[Math.floor(this.random() * candidates.length)];
  }

  onPieceReceived(_id, i) {
    const holders = this.inflight.get(i);
    if (!holders) return;
    // Clear pending requests across all peers that were asked for this piece
    for (const pid of holders) this.peers.get(pid)?.inflight.delete(i);
    this.inflight.delete(i);
  }

  onRequestFailed(id, i, backoffMs = 0) {
    const p = this.peers.get(id);
    if (!p) return;
    if (p.inflight.has(i)) this._release(id, p, i);
    if (backoffMs > 0) p.skipUntil.set(i, this.now() + backoffMs);
  }

  expire() {
    const t = this.now();
    const out = [];
    for (const [id, p] of this.peers) {
      for (const [i, at] of [...p.inflight]) {
        if (t - at > this.requestTimeoutMs) {
          this._release(id, p, i);
          p.skipUntil.set(i, t + this.requestTimeoutMs);
          out.push({ peerId: id, index: i });
        }
      }
    }
    return out;
  }

  inflightCount() {
    let n = 0;
    for (const s of this.inflight.values()) n += s.size;
    return n;
  }
}
