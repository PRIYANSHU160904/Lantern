import {
  MSG, PROTOCOL_VERSION, INFOHASH_LEN, PEERID_LEN, PEX_ENTRY_SIZE,
  MAX_PEX_ENTRIES, REJECT_REASON, ProtocolError,
} from './constants.js';

const EMPTY = Buffer.alloc(0);

// ---------- encoding ----------
// Frame: [u32 length][u8 type][payload]; length = 1 + payload.length
function frame(type, payload = EMPTY) {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt32BE(1 + payload.length, 0);
  out[4] = type;
  payload.copy(out, 5);
  return out;
}

const u32 = (n) => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b; };

export const encode = {
  keepalive: () => Buffer.alloc(4), // length 0, no type byte

  handshake({ infoHash, peerId, listenPort }) {
    if (infoHash.length !== INFOHASH_LEN) throw new Error('bad infoHash length');
    if (peerId.length !== PEERID_LEN) throw new Error('bad peerId length');
    const p = Buffer.allocUnsafe(1 + INFOHASH_LEN + PEERID_LEN + 2);
    p.writeUInt8(PROTOCOL_VERSION, 0);
    infoHash.copy(p, 1);
    peerId.copy(p, 1 + INFOHASH_LEN);
    p.writeUInt16BE(listenPort, 1 + INFOHASH_LEN + PEERID_LEN);
    return frame(MSG.HANDSHAKE, p);
  },

  bitfield: (bitfield) => frame(MSG.BITFIELD, bitfield.toBuffer()),
  have: (index) => frame(MSG.HAVE, u32(index)),
  request: (index) => frame(MSG.REQUEST, u32(index)),
  piece: (index, data) => frame(MSG.PIECE, Buffer.concat([u32(index), data])),
  choke: () => frame(MSG.CHOKE),
  unchoke: () => frame(MSG.UNCHOKE),
  interested: () => frame(MSG.INTERESTED),
  notInterested: () => frame(MSG.NOT_INTERESTED),

  reject(index, reason) {
    const p = Buffer.allocUnsafe(5);
    p.writeUInt32BE(index, 0);
    p.writeUInt8(reason, 4);
    return frame(MSG.REJECT, p);
  },

  pex(peers) { // peers: [{ip: '1.2.3.4', port: 6881}]
    const list = peers.slice(0, MAX_PEX_ENTRIES);
    const p = Buffer.allocUnsafe(2 + list.length * PEX_ENTRY_SIZE);
    p.writeUInt16BE(list.length, 0);
    list.forEach(({ ip, port }, i) => {
      const o = 2 + i * PEX_ENTRY_SIZE;
      const parts = ip.split('.').map(Number);
      if (parts.length !== 4 || parts.some((x) => !(x >= 0 && x <= 255))) {
        throw new Error(`bad IPv4 address ${ip}`);
      }
      parts.forEach((x, j) => p.writeUInt8(x, o + j));
      p.writeUInt16BE(port, o + 4);
    });
    return frame(MSG.PEX, p);
  },
};

// ---------- decoding ----------
// body = type byte + payload (the length prefix is already stripped)
function expectLen(p, n, name) {
  if (p.length !== n) throw new ProtocolError(`${name}: payload ${p.length}B, expected ${n}B`);
}

export function decode(body) {
  const type = body[0];
  const p = body.subarray(1);
  switch (type) {
    case MSG.HANDSHAKE:
      expectLen(p, 1 + INFOHASH_LEN + PEERID_LEN + 2, 'HANDSHAKE');
      return {
        type,
        version: p.readUInt8(0),
        infoHash: Buffer.from(p.subarray(1, 1 + INFOHASH_LEN)),
        peerId: Buffer.from(p.subarray(1 + INFOHASH_LEN, 1 + INFOHASH_LEN + PEERID_LEN)),
        listenPort: p.readUInt16BE(1 + INFOHASH_LEN + PEERID_LEN),
      };
    case MSG.BITFIELD:
      return { type, bitfield: Buffer.from(p) }; // validated later against numPieces
    case MSG.HAVE:
      expectLen(p, 4, 'HAVE');
      return { type, index: p.readUInt32BE(0) };
    case MSG.REQUEST:
      expectLen(p, 4, 'REQUEST');
      return { type, index: p.readUInt32BE(0) };
    case MSG.PIECE:
      if (p.length < 4) throw new ProtocolError('PIECE: too short');
      return { type, index: p.readUInt32BE(0), data: Buffer.from(p.subarray(4)) };
    case MSG.CHOKE:
    case MSG.UNCHOKE:
    case MSG.INTERESTED:
    case MSG.NOT_INTERESTED:
      expectLen(p, 0, `type 0x${type.toString(16)}`);
      return { type };
    case MSG.REJECT: {
      expectLen(p, 5, 'REJECT');
      const reason = p.readUInt8(4);
      if (!Object.values(REJECT_REASON).includes(reason)) {
        throw new ProtocolError(`REJECT: unknown reason ${reason}`);
      }
      return { type, index: p.readUInt32BE(0), reason };
    }
    case MSG.PEX: {
      if (p.length < 2) throw new ProtocolError('PEX: too short');
      const count = p.readUInt16BE(0);
      if (count > MAX_PEX_ENTRIES) throw new ProtocolError('PEX: too many entries');
      expectLen(p, 2 + count * PEX_ENTRY_SIZE, 'PEX');
      const peers = [];
      for (let i = 0; i < count; i++) {
        const o = 2 + i * PEX_ENTRY_SIZE;
        peers.push({ ip: `${p[o]}.${p[o + 1]}.${p[o + 2]}.${p[o + 3]}`, port: p.readUInt16BE(o + 4) });
      }
      return { type, peers };
    }
    default:
      throw new ProtocolError(`unknown message type 0x${type.toString(16)}`);
  }
}
