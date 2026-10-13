import test from 'node:test';
import assert from 'node:assert/strict';
import { PieceManager } from '../src/peer/pieceManager.js';
import { Bitfield } from '../src/protocol/bitfield.js';

const N = 10;
function bf(...idx) { const b = new Bitfield(N); idx.forEach((i) => b.set(i)); return b; }
const all = () => bf(...Array(N).keys());

function make({ have: haveList = [], ...opts } = {}) {
  const have = new Set(haveList);
  let t = 1000;
  const m = new PieceManager({
    numPieces: N, have: (i) => have.has(i), pipeline: 4, requestTimeoutMs: 1000, endgamePieces: 3,
    now: () => t, ...opts,
  });
  return { m, have, tick: (ms) => { t += ms; } };
}
function connect(m, id, bitfield, unchoked = true) {
  m.addPeer(id); m.setPeerBitfield(id, bitfield); m.setUnchoked(id, unchoked);
}

test('choked peers are never asked', () => {
  const { m } = make();
  connect(m, 'A', all(), false);
  assert.deepEqual(m.nextRequests(), []);
});

test('only requests pieces the peer has and we lack', () => {
  const { m } = make({ have: [0, 1] });
  connect(m, 'A', bf(0, 1, 2, 3));
  const got = m.nextRequests().map((r) => r.index).sort();
  assert.deepEqual(got, [2, 3]);
});

test('pipeline limit per peer', () => {
  const { m } = make({ pipeline: 3 });
  connect(m, 'A', all());
  assert.equal(m.nextRequests().length, 3);
  assert.equal(m.nextRequests().length, 0); // slots full
});

test('rarest-first: picks the piece the fewest peers have', () => {
  const { m } = make({ pipeline: 1 });
  connect(m, 'A', bf(0, 1, 2), true);
  connect(m, 'B', bf(0, 1), false);
  connect(m, 'C', bf(0), false);
  // availability: p0=3, p1=2, p2=1  -> A must be asked for piece 2
  assert.deepEqual(m.nextRequests(), [{ peerId: 'A', index: 2 }]);
});

test('peerHave updates availability and removePeer reverses it', () => {
  const { m } = make();
  connect(m, 'A', bf(0)); connect(m, 'B', bf(0, 1));
  m.peerHave('A', 1); m.peerHave('A', 1); // duplicate HAVE must not double count
  assert.deepEqual(m.availability.slice(0, 3), [2, 2, 0]);
  m.removePeer('B');
  assert.deepEqual(m.availability.slice(0, 3), [1, 1, 0]);
});

test('no piece is requested from two peers outside endgame', () => {
  const { m } = make({ pipeline: 10 });
  connect(m, 'A', all()); connect(m, 'B', all());
  const reqs = m.nextRequests();
  assert.equal(reqs.length, N);
  assert.equal(new Set(reqs.map((r) => r.index)).size, N);
});

test('removePeer returns in-flight pieces and they move to another peer', () => {
  const { m } = make({ pipeline: 2 });
  connect(m, 'A', bf(0, 1)); 
  const first = m.nextRequests();
  assert.equal(first.length, 2);
  connect(m, 'B', bf(0, 1));
  assert.equal(m.nextRequests().length, 0); // both pieces are already being fetched from A
  const released = m.removePeer('A');
  assert.deepEqual(released.sort(), [0, 1]);
  assert.deepEqual(m.nextRequests().map((r) => r.index).sort(), [0, 1]);
});

test('choking a peer releases its pending requests', () => {
  const { m } = make();
  connect(m, 'A', bf(0, 1));
  m.nextRequests();
  assert.deepEqual(m.setUnchoked('A', false).sort(), [0, 1]);
  assert.equal(m.inflightCount(), 0);
});

test('timeouts: request expires, slow peer is backed off, another peer gets it', () => {
  const { m, tick } = make();
  connect(m, 'A', bf(0));
  assert.deepEqual(m.nextRequests(), [{ peerId: 'A', index: 0 }]);
  tick(500); assert.deepEqual(m.expire(), []);
  tick(600);
  assert.deepEqual(m.expire(), [{ peerId: 'A', index: 0 }]);
  assert.deepEqual(m.nextRequests(), []); // A is backed off for piece 0
  connect(m, 'B', bf(0));
  assert.deepEqual(m.nextRequests(), [{ peerId: 'B', index: 0 }]);
});

test('onPieceReceived clears the request and the piece is not asked again', () => {
  const { m, have } = make();
  connect(m, 'A', bf(0));
  m.nextRequests();
  have.add(0); m.onPieceReceived('A', 0);
  assert.equal(m.inflightCount(), 0);
  assert.deepEqual(m.nextRequests(), []);
});

test('endgame: last few pieces may be requested from two peers', () => {
  const { m } = make({ have: [0, 1, 2, 3, 4, 5, 6], endgamePieces: 3 });
  connect(m, 'A', all()); connect(m, 'B', all());
  const reqs = m.nextRequests();
  const byPiece = {};
  for (const r of reqs) (byPiece[r.index] ??= []).push(r.peerId);
  assert.deepEqual(Object.keys(byPiece).sort(), ['7', '8', '9']);
  for (const peers of Object.values(byPiece)) assert.equal(new Set(peers).size, peers.length); // never same peer twice
  assert.ok(Object.values(byPiece).some((p) => p.length === 2), 'expected duplicate requests in endgame');
});

test('onRequestFailed with backoff skips that piece for that peer only', () => {
  const { m, tick } = make({ pipeline: 1 });
  connect(m, 'A', bf(0)); connect(m, 'B', bf(0), false);
  m.nextRequests();
  m.onRequestFailed('A', 0, 2000);
  assert.deepEqual(m.nextRequests(), []);
  tick(2500);
  assert.deepEqual(m.nextRequests(), [{ peerId: 'A', index: 0 }]);
});

test('ties between equally rare pieces are broken randomly', () => {
  const seen = new Set();
  for (let k = 0; k < 40; k++) {
    const { m } = make({ pipeline: 1 });
    connect(m, 'A', all());
    seen.add(m.nextRequests()[0].index);
  }
  assert.ok(seen.size > 3, `expected variety, got ${[...seen]}`);
});
