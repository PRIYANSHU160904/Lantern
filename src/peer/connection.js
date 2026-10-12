import { EventEmitter } from "node:events";
import { FrameParser } from "../protocol/framer.js";
import { encode } from "../protocol/codec.js";
import { Bitfield } from "../protocol/bitfield.js";
import { MSG, PROTOCOL_VERSION, ProtocolError } from "../protocol/constants.js";

export class Connection extends EventEmitter {
  constructor(
    socket,
    {
      numPieces,
      pieceLength,
      infoHash,
      myPeerId,
      myListenPort,
      isInitiator,
      log = () => {},
      keepAliveMs = 30_000,
      idleTimeoutMs = 90_000,
      handshakeTimeoutMs = 5_000,
    },
  ) {
    super();
    this.socket = socket;
    this.numPieces = numPieces;
    this.infoHash = infoHash;
    this.myPeerId = myPeerId;
    this.isInitiator = isInitiator;
    this.log = log;
    this.idleTimeoutMs = idleTimeoutMs;
    this.keepAliveMs = keepAliveMs;

    // Buffer capped to fit max expected piece frame + control headroom
    this.parser = new FrameParser({ maxFrame: pieceLength + 1024 });
    this.peerId = null;
    this.listenPort = null;
    this.id = null;
    this.name = "?";
    this.handshaken = false;
    this.gotBitfield = false;
    this.bitfield = new Bitfield(numPieces);

    // Initial choking and interest state flags
    this.amChoking = true;
    this.amInterested = false;
    this.peerChoking = true;
    this.peerInterested = false;

    this.bytesDownloaded = 0;
    this.bytesUploaded = 0;
    this.downRate = 0;
    this.upRate = 0;
    this._lastDown = 0;
    this._lastUp = 0;
    this._lastSample = Date.now();

    this.closed = false;
    this.lastSent = this.lastRecv = Date.now();

    // Disable Nagle's algorithm for low-latency message passing
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (e) => {
      this.log(`socket error: ${e.code ?? e.message}`);
      socket.destroy();
    });
    socket.on("close", () => this._onClose());

    // Connection lifecycle timers
    this._hsTimer = setTimeout(() => {
      if (!this.handshaken) this.socket.destroy();
    }, handshakeTimeoutMs);
    this._kaTimer = setInterval(
      () => this._keepAliveTick(),
      Math.max(50, Math.min(5_000, Math.floor(keepAliveMs / 2))),
    );
    this._hsTimer.unref();
    this._kaTimer.unref();

    // Initiate handshake on socket open
    this._send(
      encode.handshake({
        infoHash,
        peerId: myPeerId,
        listenPort: myListenPort,
      }),
    );
  }

  // Strip IPv6 mapped IPv4 prefix if present
  get remoteIp() {
    return (this.socket.remoteAddress || "").replace(/^::ffff:/, "");
  }

  _onData(chunk) {
    this.lastRecv = Date.now();
    try {
      for (const msg of this.parser.push(chunk)) {
        if (this.socket.destroyed) break; // connection dropped mid-chunk loop
        this._handle(msg);
      }
    } catch (e) {
      if (e instanceof ProtocolError) {
        this.log(`protocol violation from ${this.name}: ${e.message}`);
        this.emit("protocol_error", e);
      } else {
        this.log(`internal error handling message: ${e.stack}`);
      }
      this.socket.destroy();
    }
  }

  _checkIndex(i) {
    if (i >= this.numPieces)
      throw new ProtocolError(
        `piece index ${i} out of range (${this.numPieces} pieces)`,
      );
  }

  _handle(msg) {
    if (msg.type === MSG.KEEPALIVE) return;

    // Enforce handshake sequence first
    if (!this.handshaken) {
      if (msg.type !== MSG.HANDSHAKE)
        throw new ProtocolError("expected HANDSHAKE first");
      if (msg.version !== PROTOCOL_VERSION)
        throw new ProtocolError(`unsupported protocol version ${msg.version}`);
      if (!msg.infoHash.equals(this.infoHash))
        throw new ProtocolError("infoHash mismatch (different swarm)");
      if (msg.peerId.equals(this.myPeerId))
        throw new ProtocolError("connected to myself");
      this.handshaken = true;
      clearTimeout(this._hsTimer);
      this.peerId = msg.peerId;
      this.listenPort = msg.listenPort;
      this.emit("handshake");
      return;
    }

    switch (msg.type) {
      case MSG.HANDSHAKE:
        throw new ProtocolError("duplicate HANDSHAKE");
      case MSG.BITFIELD: {
        if (this.gotBitfield) throw new ProtocolError("duplicate BITFIELD");
        const bf = Bitfield.fromBuffer(msg.bitfield, this.numPieces);
        // Retain any early HAVE messages received prior to BITFIELD
        for (let i = 0; i < this.numPieces; i++)
          if (this.bitfield.has(i)) bf.set(i);
        this.bitfield = bf;
        this.gotBitfield = true;
        this.emit("bitfield");
        break;
      }
      case MSG.HAVE:
        this._checkIndex(msg.index);
        this.bitfield.set(msg.index);
        this.emit("have", msg.index);
        break;
      case MSG.REQUEST:
        this._checkIndex(msg.index);
        this.emit("request", msg.index);
        break;
      case MSG.PIECE:
        this._checkIndex(msg.index);
        this.bytesDownloaded += msg.data.length;
        this.emit("piece", msg.index, msg.data);
        break;
      case MSG.CHOKE:
        this.peerChoking = true;
        this.emit("choke");
        break;
      case MSG.UNCHOKE:
        this.peerChoking = false;
        this.emit("unchoke");
        break;
      case MSG.INTERESTED:
        this.peerInterested = true;
        this.emit("interested");
        break;
      case MSG.NOT_INTERESTED:
        this.peerInterested = false;
        this.emit("not_interested");
        break;
      case MSG.REJECT:
        this._checkIndex(msg.index);
        this.emit("reject", msg.index, msg.reason);
        break;
      case MSG.PEX:
        this.emit("pex", msg.peers);
        break;
    }
  }

  _send(buf) {
    if (this.closed || this.socket.destroyed) return false;
    this.lastSent = Date.now();
    return this.socket.write(buf);
  }

  get writableLength() {
    return this.socket.writableLength;
  }

  sendBitfield(bf) {
    this._send(encode.bitfield(bf));
  }
  sendHave(i) {
    this._send(encode.have(i));
  }
  requestPiece(i) {
    this._send(encode.request(i));
  }
  sendPiece(i, data) {
    this.bytesUploaded += data.length;
    this._send(encode.piece(i, data));
  }
  sendReject(i, reason) {
    this._send(encode.reject(i, reason));
  }
  sendPex(peers) {
    this._send(encode.pex(peers));
  }

  // State guards prevent redundant network sends
  setChoking(v) {
    if (v === this.amChoking) return;
    this.amChoking = v;
    this._send(v ? encode.choke() : encode.unchoke());
  }

  setInterested(v) {
    if (v === this.amInterested) return;
    this.amInterested = v;
    this._send(v ? encode.interested() : encode.notInterested());
  }

  // Exponential moving average for transfer rates
  sampleRates(now = Date.now()) {
    const dt = (now - this._lastSample) / 1000;
    if (dt <= 0) return;
    this.downRate =
      0.5 * this.downRate +
      0.5 * ((this.bytesDownloaded - this._lastDown) / dt);
    this.upRate =
      0.5 * this.upRate + 0.5 * ((this.bytesUploaded - this._lastUp) / dt);
    this._lastDown = this.bytesDownloaded;
    this._lastUp = this.bytesUploaded;
    this._lastSample = now;
  }

  _keepAliveTick() {
    const now = Date.now();
    if (now - this.lastRecv > this.idleTimeoutMs) {
      this.log(
        `${this.name} silent for ${this.idleTimeoutMs / 1000}s, dropping`,
      );
      this.socket.destroy();
    } else if (now - this.lastSent > this.keepAliveMs) {
      this._send(encode.keepalive());
    }
  }

  destroy() {
    this.socket.destroy();
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._hsTimer);
    clearInterval(this._kaTimer);
    this.emit("close");
  }
}
