// Wire-protocol constants. See README for the full frame spec.
export const PROTOCOL_VERSION = 1;

export const HEADER_SIZE = 4;          // u32 big-endian length prefix
export const INFOHASH_LEN = 32;        // SHA-256
export const PEERID_LEN = 20;
export const PEX_ENTRY_SIZE = 6;       // 4 bytes IPv4 + 2 bytes port
export const MAX_PEX_ENTRIES = 50;
export const DEFAULT_MAX_FRAME = 2 * 1024 * 1024; // sanity cap; set to pieceSize + 1 KiB in practice

export const MSG = Object.freeze({
  HANDSHAKE: 0x00,
  BITFIELD: 0x01,
  HAVE: 0x02,
  REQUEST: 0x03,
  PIECE: 0x04,
  CHOKE: 0x05,
  UNCHOKE: 0x06,
  INTERESTED: 0x07,
  NOT_INTERESTED: 0x08,
  REJECT: 0x09,
  PEX: 0x0a,
  KEEPALIVE: -1, // pseudo-type: a frame with length 0 (no type byte)
});

export const MSG_NAME = Object.fromEntries(
  Object.entries(MSG).map(([name, id]) => [id, name])
);

export const REJECT_REASON = Object.freeze({
  CHOKED: 1,
  DONT_HAVE: 2,
  BUSY: 3,
});

export class ProtocolError extends Error {}
