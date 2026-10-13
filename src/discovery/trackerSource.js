import { PeerSource } from "./peerSource.js";

export class TrackerSource extends PeerSource {
  constructor({ trackerUrl, peerId, log = () => {}, timeoutMs = 3000 }) {
    super();
    Object.assign(this, { trackerUrl, peerId, log, timeoutMs });
    this.interval = 15;
    this.failures = 0;
    this.stopped = false;
    this.timer = null;
  }

  start(infoHash, myPort) {
    this.infoHash = infoHash;
    this.port = myPort;
    this.stopped = false;
    this.announce("started");
  }

  async announce(event = "") {
    if (this.stopped && event !== "stopped") return;

    // Construct HTTP GET request URL
    const url = new URL("/announce", this.trackerUrl);
    url.searchParams.set("infoHash", this.infoHash.toString("hex"));
    url.searchParams.set("peerId", this.peerId.toString("hex"));
    url.searchParams.set("port", String(this.port));
    if (event) url.searchParams.set("event", event);

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();

      if (this.failures > 0) this.log("tracker is back");
      this.failures = 0;
      this.interval = body.interval ?? 15;

      // Emit discovered peer contact details
      if (Array.isArray(body.peers) && body.peers.length) {
        this.emit(
          "peers",
          body.peers.map(({ ip, port }) => ({ ip, port })),
        );
      }
    } catch (e) {
      if (event !== "stopped") {
        if (this.failures === 0) {
          this.log(
            `tracker unreachable (${e.message}); continuing without it, will retry`,
          );
        }
        this.failures++;
      }
    }

    if (event !== "stopped" && !this.stopped) this._schedule();
  }

  _schedule() {
    clearTimeout(this.timer);
    // Back off to 5 seconds on failure; otherwise use tracker's requested re-announce interval
    const delayMs = this.failures > 0 ? 5000 : this.interval * 1000;
    this.timer = setTimeout(() => this.announce(""), delayMs);
    this.timer.unref();
  }

  // Abruptly stop local timers without notifying tracker (simulates a crash)
  halt() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  // Graceful shutdown: notify tracker that local client is leaving
  async stop() {
    this.halt();
    await this.announce("stopped");
  }
}
