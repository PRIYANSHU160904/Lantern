import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encode } from '../src/protocol/codec.js';
import { FrameParser } from '../src/protocol/framer.js';
import { Bitfield } from '../src/protocol/bitfield.js';
import { MSG, REJECT_REASON, ProtocolError } from '../src/protocol/constants.js';

const infoHash = crypto.randomBytes(32);
const peerId = crypto.randomBytes(20);

test('handshake round-trips', () => {
  const [m] = new FrameParser().push(encode.handshake({ infoHash, peerId, listenPort: 6881 }));
  assert.equal(m.type, MSG.HANDSHAKE);
  assert.ok(m.infoHash.equals(infoHash));
  assert.ok(m.peerId.equals(peerId));
  assert.equal(m.listenPort, 6881);
});

test('all message types round-trip', () => {
  const bf = new Bitfield(10); bf.set(0); bf.set(9);
  const data = crypto.randomBytes(1000);
  const msgs = new FrameParser().push(Buffer.concat([
    encode.keepalive(), encode.bitfield(bf), encode.have(7), encode.request(3),
    encode.piece(5, data), encode.choke(), encode.unchoke(), encode.interested(),
    encode.notInterested(), encode.reject(2, REJECT_REASON.CHOKED),
    encode.pex([{ ip: '10.0.0.5', port: 7000 }]),
  ]));
  assert.deepEqual(msgs.map((m) => m.type), [
    MSG.KEEPALIVE, MSG.BITFIELD, MSG.HAVE, MSG.REQUEST, MSG.PIECE, MSG.CHOKE,
    MSG.UNCHOKE, MSG.INTERESTED, MSG.NOT_INTERESTED, MSG.REJECT, MSG.PEX,
  ]);
  assert.equal(msgs[2].index, 7);
  assert.ok(msgs[4].data.equals(data));
  assert.deepEqual(msgs[10].peers, [{ ip: '10.0.0.5', port: 7000 }]);
  const got = Bitfield.fromBuffer(msgs[1].bitfield, 10);
  assert.ok(got.has(0) && got.has(9) && !got.has(1));
});

test('parser survives 1-byte-at-a-time delivery', () => {
  const data = crypto.randomBytes(5000);
  const wire = Buffer.concat([encode.have(1), encode.piece(2, data), encode.unchoke()]);
  const p = new FrameParser();
  const out = [];
  for (const b of wire) out.push(...p.push(Buffer.from([b])));
  assert.equal(out.length, 3);
  assert.ok(out[1].data.equals(data));
});

test('oversized frame is rejected', () => {
  const evil = Buffer.alloc(4); evil.writeUInt32BE(0x7fffffff);
  assert.throws(() => new FrameParser({ maxFrame: 1024 }).push(evil), ProtocolError);
});

test('unknown type and malformed payloads are rejected', () => {
  const bad = Buffer.from([0, 0, 0, 1, 0xee]);
  assert.throws(() => new FrameParser().push(bad), ProtocolError);
  const badHave = Buffer.from([0, 0, 0, 3, MSG.HAVE, 0, 0]);
  assert.throws(() => new FrameParser().push(badHave), ProtocolError);
});

test('bitfield validates length and spare bits', () => {
  assert.throws(() => Bitfield.fromBuffer(Buffer.alloc(3), 10), ProtocolError);
  assert.throws(() => Bitfield.fromBuffer(Buffer.from([0, 0b00000001]), 10), ProtocolError);
  const bf = new Bitfield(10);
  for (let i = 0; i < 10; i++) bf.set(i);
  assert.ok(bf.isComplete());
  assert.equal(bf.toBuffer()[0], 0xff);
  assert.equal(bf.toBuffer()[1], 0b11000000);
});
