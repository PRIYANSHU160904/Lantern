import http from "node:http";
import { shuffle } from "../util/random.js";

const INFOHASH_RE = /^[0-9a-f]{64}$/;
const PEERID_RE = /^[0-9a-f]{40}$/;

// Normalize loopback or IPv6-mapped IPv4 addresses
const normIp = (a = "") =>
  a.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");

// Extract 8-character display name from peer ID hex
const peerName = (hex) =>
  Buffer.from(hex, "hex").subarray(0, 8).toString("latin1").replace(/-+$/, "");

export function createTracker({
  port = 8000,
  host = "0.0.0.0",
  peerTtlMs = 90_000,
  intervalSec = 15,
  maxPeersReturned = 50,
  log = () => {},
} = {}) {
  // Central memory store: infoHashHex -> Map(peerIdHex -> { ip, port, lastSeen })
  const swarms = new Map();

  const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(s),
    });
    res.end(s);
  };

  function handleAnnounce(url, req, res) {
    const q = url.searchParams;
    const infoHash = q.get("infoHash") ?? "";
    const peerId = q.get("peerId") ?? "";
    const peerPort = Number(q.get("port"));
    const event = q.get("event") || "update";

    // Request parameter validation
    if (!INFOHASH_RE.test(infoHash))
      return json(res, 400, { error: "bad infoHash" });
    if (!PEERID_RE.test(peerId)) return json(res, 400, { error: "bad peerId" });
    if (!Number.isInteger(peerPort) || peerPort < 1 || peerPort > 65535)
      return json(res, 400, { error: "bad port" });

    let swarm = swarms.get(infoHash);
    if (!swarm) swarms.set(infoHash, (swarm = new Map()));

    // Graceful peer exit handling
    if (event === "stopped") {
      swarm.delete(peerId);
      if (swarm.size === 0) swarms.delete(infoHash);
      log(
        `announce stopped   ${peerName(peerId)} swarm=${infoHash.slice(0, 8)} (${swarm.size} left)`,
      );
      return json(res, 200, { interval: intervalSec, peers: [] });
    }

    const ip = q.get("ip") || normIp(req.socket.remoteAddress);
    swarm.set(peerId, { ip, port: peerPort, lastSeen: Date.now() });

    // Build peer response array, filtering out the requesting peer
    const others = [...swarm.entries()]
      .filter(([id]) => id !== peerId)
      .map(([id, p]) => ({ peerId: id, ip: p.ip, port: p.port }));
    const peers = shuffle(others).slice(0, maxPeersReturned);

    if (event !== "update")
      log(
        `announce ${event.padEnd(9)}  ${peerName(peerId)} swarm=${infoHash.slice(0, 8)} (${swarm.size} peers)`,
      );

    json(res, 200, { interval: intervalSec, peers });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://tracker");
    if (req.method !== "GET") return json(res, 405, { error: "GET only" });
    if (url.pathname === "/announce") return handleAnnounce(url, req, res);
    if (url.pathname === "/stats") {
      const out = {};
      for (const [h, s] of swarms)
        out[h.slice(0, 8)] = [...s.entries()].map(([id, p]) => ({
          name: peerName(id),
          ip: p.ip,
          port: p.port,
        }));
      return json(res, 200, out);
    }
    json(res, 404, { error: "not found" });
  });

  // Sweeper timer to drop unannounced/dead peers
  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const [hash, swarm] of swarms) {
        for (const [id, p] of swarm)
          if (now - p.lastSeen > peerTtlMs) swarm.delete(id);
        if (swarm.size === 0) swarms.delete(hash);
      }
    },
    Math.max(50, Math.floor(peerTtlMs / 3)),
  );
  sweep.unref();

  return {
    server,
    swarms,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      clearInterval(sweep);
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
