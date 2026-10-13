#!/usr/bin/env node
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { loadMetadata } from "../src/metadata/torrent.js";
import { PieceStore } from "../src/storage/pieceStore.js";
import { Peer } from "../src/peer/peer.js";
import { startStatusServer } from "../src/ui/statusServer.js";

// Parse CLI flags and configuration
const { values: v } = parseArgs({
  options: {
    torrent: { type: "string" },
    file: { type: "string" },
    dir: { type: "string" },
    name: { type: "string", default: "peer" },
    port: { type: "string", default: "0" },
    host: { type: "string", default: "0.0.0.0" },
    tracker: { type: "string" },
    connect: { type: "string", multiple: true },
    malicious: { type: "boolean", default: false },
    freerider: { type: "boolean", default: false },
    "upload-limit": { type: "string", default: "0" },
    "choke-interval": { type: "string", default: "10000" },
    slots: { type: "string", default: "3" },
    "max-peers": { type: "string", default: "30" },
    "pex-interval": { type: "string", default: "30000" },
    "progress-every": { type: "string", default: "3000" },
    "exit-on-complete": { type: "boolean", default: false },
    "status-port": { type: "string" },
  },
});

if (!v.torrent || !v.file) {
  console.error("required: --torrent <meta.json>");
  process.exit(1);
}

// 1. Load metadata & ensure file destination directory exists
const meta = await loadMetadata(v.torrent);

const outputDir = v.dir ?? "./downloads";
const filePath = v.file ?? path.join(outputDir, meta.name);

await fs.mkdir(path.dirname(v.file), { recursive: true });

// 2. Open underlying sparse/full file piece storage
const store = await PieceStore.open(meta, v.file);

// 3. Assemble and initialize core Peer orchestrator
const peer = new Peer({
  meta,
  store,
  name: v.name,
  host: v.host,
  port: Number(v.port),
  trackerUrl: v.tracker ?? null,
  malicious: v.malicious,
  freerider: v.freerider,
  uploadLimit: Number(v["upload-limit"]),
  chokeIntervalMs: Number(v["choke-interval"]),
  slots: Number(v.slots),
  maxPeers: Number(v["max-peers"]),
  pexIntervalMs: Number(v["pex-interval"]),
  progressEveryMs: Number(v["progress-every"]),
});

await peer.start();

// 4. Optionally spawn HTTP status dashboard server for real-time visual demo
if (v["status-port"]) startStatusServer(peer, Number(v["status-port"]));

// 5. Connect directly to explicit bootstrap peer addresses if supplied
if (v.connect) {
  peer.connectToPeers(
    v.connect.map((s) => {
      const [ip, port] = s.split(":");
      return { ip, port: Number(port) };
    }),
  );
}

if (v.malicious) peer.log("MALICIOUS mode: every piece I upload is corrupted");
if (v.freerider) peer.log("FREE-RIDER mode: I will never upload");

// 6. Handle automatic exit on download completion or graceful SIGINT shutdown
if (v["exit-on-complete"]) {
  peer.once("complete", () =>
    setTimeout(async () => {
      await peer.stop();
      process.exit(0);
    }, 500),
  );
}

process.on("SIGINT", async () => {
  await peer.stop();
  process.exit(0);
});
