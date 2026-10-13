import { PeerSource } from "./peerSource.js";
import { MAX_PEX_ENTRIES } from "../protocol/constants.js";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Validate IP format, octet ranges (0-255), and valid TCP port bounds
const validEntry = (p) =>
  p &&
  typeof p.ip === "string" &&
  IPV4.test(p.ip) &&
  p.ip.split(".").every((x) => Number(x) <= 255) &&
  Number.isInteger(p.port) &&
  p.port > 0 &&
  p.port < 65536;

export class PexSource extends PeerSource {
  constructor({ getConnections, intervalMs = 30_000 }) {
    super();
    this.getConnections = getConnections;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.shareNow(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  shareNow() {
    // Collect active handshaken connections that have known listen ports
    const conns = this.getConnections().filter(
      (c) => c.listenPort && c.remoteIp,
    );
    const all = conns.map((c) => ({ ip: c.remoteIp, port: c.listenPort }));

    // Broadcast peer list to each connection, omitting recipient's own address
    for (const c of conns) {
      const list = all
        .filter((p) => !(p.ip === c.remoteIp && p.port === c.listenPort))
        .slice(0, MAX_PEX_ENTRIES);
      if (list.length) c.sendPex(list);
    }
  }

  receive(list) {
    // Sanitize incoming untrusted peer list before emitting to Peer dialer
    const good = list.filter(validEntry);
    if (good.length) this.emit("peers", good);
  }
}
