#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  createMetadata,
  saveMetadata,
  computeInfoHash,
  numPieces,
} from "../src/metadata/torrent.js";

// Parse CLI options and target positional file argument
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    "piece-length": { type: "string", default: String(256 * 1024) },
  },
});

if (positionals.length !== 1) {
  console.error(
    "usage: make-torrent <file> [--out meta.json] [--piece-length N]",
  );
  process.exit(1);
}

const targetFile = positionals[0];
const pieceLength = Number(values["piece-length"]);

// Hash target file pieces and construct metadata object
const meta = await createMetadata(targetFile, pieceLength);
const out = values.out ?? `${targetFile}.torrent.json`;

await saveMetadata(meta, out);

// Output swarm metadata details to stdout
console.log(`wrote ${out}`);
console.log(`  name       ${meta.name}`);
console.log(`  size       ${meta.length} bytes`);
console.log(`  pieces     ${numPieces(meta)} x ${meta.pieceLength} bytes`);
console.log(`  infoHash   ${computeInfoHash(meta).toString("hex")}`);
