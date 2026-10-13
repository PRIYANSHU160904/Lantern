import net from "node:net";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { Connection } from "./connection.js";
import { PieceManager } from "./pieceManager.js";
import { Choker } from "./choker.js";
import { TrackerSource } from "../discovery/trackerSource.js";
import { PexSource } from "../discovery/pexSource.js";
import {
  computeInfoHash,
  numPieces as countPieces,
} from "../metadata/torrent.js";
import { REJECT_REASON } from "../protocol/constants.js";
import { makeLogger } from "../util/logger.js";

const MAX_STRIKES = 3;
const DIAL_TIMEOUT_MS = 5_000;
const REDIAL_BACKOFF_MS = 10_000;

export const nameOfPeerId = (id) =>
  id.subarray(0, 8).toString("latin1").replace(/-+$/, "");

export class Peer extends EventEmitter {
  constructor({
    meta,
    store,
    name = "peer",
    host = "0.0.0.0",
    port = 0,
    trackerUrl = null,
    malicious = false,
    freerider = false,
    uploadLimit = 0,
    maxPeers = 30,
    slots = 3,
    chokeIntervalMs = 10_000,
    pipeline = 4,
    requestTimeoutMs = 10_000,
    pexIntervalMs = 30_000,
    progressEveryMs = 0,
    gracePieces = 2,
    log,
  }) {
    super();
    Object.assign(this, {
      meta,
      store,
      name,
      host,
      port,
      malicious,
      freerider,
      uploadLimit,
      maxPeers,
      chokeIntervalMs,
      progressEveryMs,
    });
    this.log = log ?? makeLogger(name);
    this.n = countPieces(meta);
    this.infoHash = computeInfoHash(meta);

    // Construct peer ID: 8 ASCII name bytes + 12 random bytes
    this.peerId = Buffer.concat([
      Buffer.from(name.slice(0, 8).padEnd(8, "-"), "latin1"),
      crypto.randomBytes(12),
    ]);

    this.conns = new Map(); // peerIdHex -> Connection (handshaken)
    this.sockets = new Set(); // all active Connection instances
    this.addrs = new Set(); // "ip:port" tracking for active dials/conns
    this.failedAt = new Map(); // "ip:port" -> timestamp of failed dial
    this.strikes = new Map(); // peerIdHex -> strike count
    this.banned = new Set(); // banned peerIdHex set
    this.bannedAddrs = new Set(); // banned "ip:listenPort" set
    this.pending = new Set(); // piece indices currently writing to disk
    this.sourceOf = Array.from({ length: this.n }, (_, i) =>
      store.has(i) ? "local" : null,
    );
    this.stats = {
      hashFailures: 0,
      banned: 0,
      piecesFrom: {},
      uploaded: 0,
      downloaded: 0,
    };

    this.maxUploadBacklogMs = Math.floor(requestTimeoutMs / 3);
    this.complete = store.isComplete();
    this.stopped = false;
    this._nextUpload = 0;
    this._lastUnchoked = "";
    this._ticks = 0;

    // Internal component instances
    this.manager = new PieceManager({
      numPieces: this.n,
      have: (i) => store.has(i),
      pipeline,
      requestTimeoutMs,
    });
    this.choker = new Choker({
      slots,
      graceBytes: gracePieces * meta.pieceLength,
    });
    this.slots = slots;

    this.sources = [];
    this.tracker = trackerUrl
      ? new TrackerSource({ trackerUrl, peerId: this.peerId, log: this.log })
      : null;
    if (this.tracker) this.addSource(this.tracker);
    this.pex = new PexSource({
      getConnections: () => [...this.conns.values()],
      intervalMs: pexIntervalMs,
    });
    this.addSource(this.pex);
  }

  addSource(source) {
    this.sources.push(source);
    source.on("peers", (list) => this.connectToPeers(list));
    if (this.started) source.start(this.infoHash, this.port);
  }

  async start() {
    this.server = net.createServer((sock) => this._onInbound(sock));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.port = this.server.address().port;
    this.started = true;
    this._tickTimer = setInterval(() => this._tick(), 1000);
    this._chokeTimer = setInterval(() => this._rechoke(), this.chokeIntervalMs);
    this.log(
      `listening on :${this.port}  pieces ${this.store.bitfield.count()}/${this.n}${this.complete ? " (seeding)" : ""}`,
    );
    for (const s of this.sources) s.start(this.infoHash, this.port);
    return this;
  }

  async stop() {
    if (this.stopped) return;
    this._shutdown();
    if (this.tracker) await this.tracker.stop();
    this.log("stopped");
  }

  kill() {
    if (this.stopped) return;
    this.tracker?.halt();
    this._shutdown();
  }

  _shutdown() {
    this.stopped = true;
    clearInterval(this._tickTimer);
    clearInterval(this._chokeTimer);
    for (const s of this.sources) s.stop?.();
    this.server?.close();
    for (const c of [...this.sockets]) c.destroy();
  }

  whenComplete() {
    return this.complete
      ? Promise.resolve()
      : new Promise((r) => this.once("complete", r));
  }

  connectToPeers(list) {
    for (const { ip, port } of list) this._dial(ip, port);
  }

  _dial(ip, port) {
    if (this.stopped) return;
    const key = `${ip}:${port}`;
    if (port === this.port && (ip === "127.0.0.1" || ip === this.host)) return;
    if (this.addrs.has(key) || this.bannedAddrs.has(key)) return;
    if (this.sockets.size >= this.maxPeers) return;
    const failed = this.failedAt.get(key);
    if (failed && Date.now() - failed < REDIAL_BACKOFF_MS) return;

    this.addrs.add(key);
    const sock = net.connect({ host: ip, port });
    sock.setTimeout(DIAL_TIMEOUT_MS, () => sock.destroy());
    sock.once("connect", () => sock.setTimeout(0));
    const conn = this._wrap(sock, true);
    conn.once("close", () => {
      this.addrs.delete(key);
      if (!conn.id) this.failedAt.set(key, Date.now());
    });
  }

  _onInbound(sock) {
    if (this.stopped || this.sockets.size >= this.maxPeers) {
      sock.destroy();
      return;
    }
    this._wrap(sock, false);
  }

  _wrap(sock, isInitiator) {
    const conn = new Connection(sock, {
      numPieces: this.n,
      pieceLength: this.meta.pieceLength,
      infoHash: this.infoHash,
      myPeerId: this.peerId,
      myListenPort: this.port,
      isInitiator,
      log: this.log,
    });
    this.sockets.add(conn);
    conn.on("handshake", () => this._onHandshake(conn));
    conn.on("bitfield", () => {
      this.manager.setPeerBitfield(conn.id, conn.bitfield);
      this._updateInterest(conn);
      this._pump();
    });
    conn.on("have", (i) => {
      this.manager.peerHave(conn.id, i);
      this._updateInterest(conn);
      this._pump();
    });
    conn.on("interested", () => this._maybeUnchokeNow(conn));
    conn.on("choke", () => {
      this.manager.setUnchoked(conn.id, false);
      this._pump();
    });
    conn.on("unchoke", () => {
      this.manager.setUnchoked(conn.id, true);
      this._pump();
    });
    conn.on("reject", (i, reason) => {
      const backoff =
        reason === REJECT_REASON.DONT_HAVE
          ? 60_000
          : reason === REJECT_REASON.BUSY
            ? 2_000
            : 0;
      this.manager.onRequestFailed(conn.id, i, backoff);
      this._pump();
    });
    conn.on("request", (i) => this._serve(conn, i));
    conn.on("piece", (i, data) => this._onPiece(conn, i, data));
    conn.on("pex", (list) => this.pex.receive(list));
    conn.on("protocol_error", () => this._strike(conn, "protocol violation"));
    conn.on("close", () => this._onClose(conn));
    return conn;
  }

  _onHandshake(conn) {
    const id = conn.peerId.toString("hex");
    const addrKey = `${conn.remoteIp}:${conn.listenPort}`;
    conn.id = id;
    conn.name = nameOfPeerId(conn.peerId);
    conn.addrKey = addrKey;

    if (this.banned.has(id) || this.bannedAddrs.has(addrKey)) {
      this.log(`refusing banned peer ${conn.name}`);
      conn.destroy();
      return;
    }

    // Concurrent dial tie-breaking: keep connection initiated by smaller peerId
    const existing = this.conns.get(id);
    if (existing) {
      const iAmSmaller = Buffer.compare(this.peerId, conn.peerId) < 0;
      const keepNew =
        conn.isInitiator === iAmSmaller && existing.isInitiator !== iAmSmaller;
      if (!keepNew) {
        conn.destroy();
        return;
      }
      this.conns.delete(id);
      this.manager.removePeer(id);
      existing.destroy();
    }

    this.conns.set(id, conn);
    this.addrs.add(addrKey);
    this.manager.addPeer(id);
    conn.sendBitfield(this.store.bitfield);
    this.log(
      `connected to ${conn.name} (${addrKey}) [${this.conns.size} peers]`,
    );
    this.emit("peer_connected", conn);
    this.pex.shareNow();
  }

  _onClose(conn) {
    this.sockets.delete(conn);
    if (conn.addrKey) this.addrs.delete(conn.addrKey);
    if (!conn.id || this.conns.get(conn.id) !== conn) return;
    this.conns.delete(conn.id);
    const released = this.manager.removePeer(conn.id);
    this.log(
      `${conn.name} disconnected, requeued ${released.length} in-flight piece(s)`,
    );
    this.emit("peer_disconnected", conn);
    this._pump();
  }

  _needsFrom(conn) {
    for (let i = 0; i < this.n; i++)
      if (conn.bitfield.has(i) && !this.store.has(i)) return true;
    return false;
  }

  _updateInterest(conn) {
    conn.setInterested(!this.complete && this._needsFrom(conn));
  }

  _pump() {
    if (this.stopped || this.complete) return;
    for (const { peerId, index } of this.manager.nextRequests())
      this.conns.get(peerId)?.requestPiece(index);
  }

  async _onPiece(conn, i, data) {
    if (this.store.has(i) || this.pending.has(i)) {
      this.manager.onRequestFailed(conn.id, i);
      this._pump();
      return;
    }
    if (!this.store.verify(i, data)) {
      this.stats.hashFailures++;
      this.log(`HASH MISMATCH piece ${i} from ${conn.name}, discarding`);
      this.manager.onRequestFailed(conn.id, i);
      this._strike(conn, `bad data for piece ${i}`);
      this._pump();
      return;
    }
    this.pending.add(i);
    try {
      await this.store.write(i, data);
    } catch (e) {
      this.log(`disk write failed for piece ${i}: ${e.message}`);
      this.pending.delete(i);
      this.manager.onRequestFailed(conn.id, i);
      return;
    }
    this.pending.delete(i);
    this.stats.downloaded += data.length;
    this.sourceOf[i] = conn.name;
    this.stats.piecesFrom[conn.name] =
      (this.stats.piecesFrom[conn.name] ?? 0) + 1;
    this.manager.onPieceReceived(conn.id, i);
    for (const c of this.conns.values()) c.sendHave(i);
    this.log(
      `got piece ${i} from ${conn.name} [${this.store.bitfield.count()}/${this.n}]`,
    );
    if (this.store.isComplete() && !this.complete) this._onComplete();
    for (const c of this.conns.values()) this._updateInterest(c);
    this._pump();
  }

  _onComplete() {
    this.complete = true;
    const by = Object.entries(this.stats.piecesFrom)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    this.log(
      `*** DOWNLOAD COMPLETE (${this.n} pieces; sources ${by}) - now seeding`,
    );
    this.tracker?.announce("completed");
    this.emit("complete");
  }

  _serve(conn, i) {
    if (this.freerider || conn.amChoking)
      return conn.sendReject(i, REJECT_REASON.CHOKED);
    if (!this.store.has(i)) return conn.sendReject(i, REJECT_REASON.DONT_HAVE);
    if (conn.writableLength > this.meta.pieceLength * 8)
      return conn.sendReject(i, REJECT_REASON.BUSY);
    if (this._uploadBacklogMs() > this.maxUploadBacklogMs)
      return conn.sendReject(i, REJECT_REASON.BUSY);

    this.store
      .read(i)
      .then((data) => {
        if (this.malicious) {
          data = Buffer.from(data);
          data[0] ^= 0xff; // Sabotage byte for demo testing
        }
        const delay = this._uploadDelay(data.length);
        const send = () => {
          if (!conn.closed) {
            conn.sendPiece(i, data);
            this.stats.uploaded += data.length;
          }
        };
        if (delay > 0) setTimeout(send, delay);
        else send();
      })
      .catch((e) => this.log(`read piece ${i} failed: ${e.message}`));
  }

  _uploadBacklogMs() {
    return this.uploadLimit ? Math.max(0, this._nextUpload - Date.now()) : 0;
  }

  _uploadDelay(bytes) {
    if (!this.uploadLimit) return 0;
    const now = Date.now();
    const start = Math.max(now, this._nextUpload);
    this._nextUpload = start + (bytes / this.uploadLimit) * 1000;
    return start - now;
  }

  _rechoke() {
    if (this.freerider || this.stopped) return;
    const peers = [...this.conns.values()].map((c) => ({
      id: c.id,
      interested: c.peerInterested,
      downRate: c.downRate,
      upRate: c.upRate,
      uploaded: c.bytesUploaded,
      downloaded: c.bytesDownloaded,
    }));
    const unchoke = this.choker.select(peers, { isSeed: this.complete });
    for (const c of this.conns.values()) c.setChoking(!unchoke.has(c.id));
    const desc = [...this.conns.values()]
      .filter((c) => !c.amChoking)
      .map((c) => (c.id === this.choker.optimisticId ? `${c.name}*` : c.name))
      .sort()
      .join(",");
    if (desc !== this._lastUnchoked) {
      this.log(`unchoked: [${desc}] (* = optimistic)`);
      this._lastUnchoked = desc;
    }
  }

  _maybeUnchokeNow(conn) {
    if (this.freerider || !conn.amChoking) return;
    if (
      !this.complete &&
      this.choker.isDeadbeat({
        uploaded: conn.bytesUploaded,
        downloaded: conn.bytesDownloaded,
      })
    )
      return;
    const unchoked = [...this.conns.values()].filter(
      (c) => !c.amChoking,
    ).length;
    if (unchoked < this.slots + 1) conn.setChoking(false);
  }

  _strike(conn, reason) {
    if (!conn.id) return;
    const s = (this.strikes.get(conn.id) ?? 0) + 1;
    this.strikes.set(conn.id, s);
    this.log(`strike ${s}/${MAX_STRIKES} against ${conn.name}: ${reason}`);
    if (s >= MAX_STRIKES) {
      this.banned.add(conn.id);
      this.bannedAddrs.add(conn.addrKey);
      this.stats.banned++;
      this.log(`BANNED ${conn.name} (disconnecting)`);
      conn.destroy();
    }
  }

  _tick() {
    const now = Date.now();
    for (const c of this.conns.values()) c.sampleRates(now);
    for (const e of this.manager.expire())
      this.log(
        `request for piece ${e.index} timed out, re-requesting elsewhere`,
      );
    this._pump();
    this._ticks++;
    if (
      this.progressEveryMs &&
      (this._ticks * 1000) % this.progressEveryMs === 0
    )
      this._logProgress();
  }

  _logProgress() {
    const have = this.store.bitfield.count();
    const pct = Math.floor((have / this.n) * 100);
    const bar = "#".repeat(Math.floor(pct / 5)).padEnd(20, ".");
    let down = 0,
      up = 0;
    for (const c of this.conns.values()) {
      down += c.downRate;
      up += c.upRate;
    }
    this.log(
      `[${bar}] ${String(pct).padStart(3)}% ${have}/${this.n}  down ${(down / 1024).toFixed(0)} KB/s  up ${(up / 1024).toFixed(0)} KB/s  peers ${this.conns.size}`,
    );
  }

  getStatus() {
    return {
      name: this.name,
      peerId: this.peerId.toString("hex"),
      port: this.port,
      complete: this.complete,
      total: this.n,
      have: this.store.bitfield.count(),
      bitfield: Array.from({ length: this.n }, (_, i) =>
        this.store.has(i) ? 1 : 0,
      ).join(""),
      sources: this.sourceOf,
      stats: this.stats,
      banned: this.banned.size,
      peers: [...this.conns.values()].map((c) => ({
        name: c.name,
        addr: c.addrKey,
        pieces: c.bitfield.count(),
        amChoking: c.amChoking,
        peerChoking: c.peerChoking,
        interested: c.peerInterested,
        downRate: Math.round(c.downRate),
        upRate: Math.round(c.upRate),
        downloaded: c.bytesDownloaded,
        uploaded: c.bytesUploaded,
      })),
    };
  }
}
