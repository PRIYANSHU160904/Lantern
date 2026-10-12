import {
  DEFAULT_MAX_FRAME,
  HEADER_SIZE,
  MSG,
  ProtocolError,
} from "./constants.js";
import { decode } from "./codec.js";

export class FrameParser {
  constructor({ maxFrame = DEFAULT_MAX_FRAME } = {}) {
    this.maxFrame = maxFrame;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const messages = [];
    while (this.buf.length >= HEADER_SIZE) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxFrame) {
        throw new ProtocolError(
          `frame length ${len} exceeds max ${this.maxFrame}`,
        );
      }
      if (this.buf.length < HEADER_SIZE + len) break; // wait for the rest
      const body = this.buf.subarray(HEADER_SIZE, HEADER_SIZE + len);
      this.buf = this.buf.subarray(HEADER_SIZE + len);
      messages.push(len === 0 ? { type: MSG.KEEPALIVE } : decode(body));
    }
    return messages;
  }
}
