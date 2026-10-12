import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { Connection } from '../src/peer/connection.js';
import { encode } from '../src/protocol/codec.js';

const infoHash = crypto.randomBytes(32);
const baseOpts = (extra = {}) => ({
  numPieces: 4, pieceLength: 1024, infoHash, myPeerId: crypto.randomBytes(20), myListenPort: 1111,
  isInitiator: false, ...extra,
});

// Accept ONE inbound socket and wrap it in a Connection; hand back a raw client socket to play the remote peer.
async function pair(opts) {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const accepted = new Promise((r) => server.once('connection', r));
  const raw = net.connect(server.address().port, '127.0.0.1');
  raw.on('error', () => {}); raw.resume();
  const conn = new Connection(await accepted, baseOpts(opts));
  const closed = new Promise((r) => conn.once('close', r));
  return { conn, raw, closed, done: () => { raw.destroy(); server.close(); } };
}
const rawHandshake = () => encode.handshake({ infoHash, peerId: crypto.randomBytes(20), listenPort: 2222 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('handshake completes and exposes the remote peerId and LISTEN port (not the ephemeral one)', async () => {
  const { conn, raw, done } = await pair();
  const hs = new Promise((r) => conn.once('handshake', r));
  raw.write(rawHandshake());
  await hs;
  assert.equal(conn.handshaken, true);
  assert.equal(conn.listenPort, 2222);
  assert.equal(conn.peerId.length, 20);
  done();
});

test('keepalives keep a quiet but healthy connection open; a silent peer is dropped', async () => {
  // A: both ends alive (raw side sends keepalives manually) -> stays open past the idle timeout.
  const a = await pair({ keepAliveMs: 100, idleTimeoutMs: 500 });
  a.raw.write(rawHandshake());
  const ka = setInterval(() => a.raw.write(encode.keepalive()), 100);
  await sleep(1200);
  assert.equal(a.conn.closed, false, 'connection with keepalives must survive');
  clearInterval(ka);
  // ...and once the remote goes silent (no FIN, like a pulled network cable) it is detected and dropped.
  await Promise.race([a.closed, sleep(2000).then(() => assert.fail('silent peer was not dropped'))]);
  assert.equal(a.conn.closed, true);
  a.done();
});

test('connection that never handshakes is closed', async () => {
  const { closed, done } = await pair({ handshakeTimeoutMs: 200 });
  await Promise.race([closed, sleep(2000).then(() => assert.fail('no handshake timeout'))]);
  done();
});

test('malformed traffic: bad piece index, oversized frame, data before handshake all cause protocol_error + close', async () => {
  const cases = {
    'piece index out of range': (raw) => { raw.write(rawHandshake()); raw.write(encode.have(99)); },
    'oversized frame': (raw) => { raw.write(rawHandshake()); const b = Buffer.alloc(4); b.writeUInt32BE(10_000_000); raw.write(b); },
    'message before handshake': (raw) => raw.write(encode.have(1)),
    'wrong infoHash': (raw) => raw.write(encode.handshake({ infoHash: crypto.randomBytes(32), peerId: crypto.randomBytes(20), listenPort: 1 })),
    'duplicate bitfield': (raw) => {
      raw.write(rawHandshake());
      const bf = Buffer.alloc(1);
      raw.write(encode.bitfield({ toBuffer: () => bf })); raw.write(encode.bitfield({ toBuffer: () => bf }));
    },
  };
  for (const [label, act] of Object.entries(cases)) {
    const { conn, raw, closed, done } = await pair();
    let violations = 0;
    conn.on('protocol_error', () => violations++);
    act(raw);
    await Promise.race([closed, sleep(2000).then(() => assert.fail(`${label}: not closed`))]);
    assert.equal(violations, 1, label);
    done();
  }
});

test('a connection to ourselves is refused', async () => {
  const myPeerId = crypto.randomBytes(20);
  const { conn, raw, closed, done } = await pair({ myPeerId });
  raw.write(encode.handshake({ infoHash, peerId: myPeerId, listenPort: 1 }));
  await Promise.race([closed, sleep(2000).then(() => assert.fail('self-connection not refused'))]);
  assert.equal(conn.handshaken, false);
  done();
});

test('messages split across arbitrary TCP chunks are reassembled', async () => {
  const { conn, raw, done } = await pair();
  const got = [];
  conn.on('have', (i) => got.push(i));
  const wire = Buffer.concat([rawHandshake(), encode.have(1), encode.have(2), encode.have(3)]);
  for (let i = 0; i < wire.length; i += 7) { raw.write(wire.subarray(i, i + 7)); await sleep(1); }
  await sleep(100);
  assert.deepEqual(got, [1, 2, 3]);
  done();
});
