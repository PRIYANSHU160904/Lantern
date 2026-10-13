#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createTracker } from "../src/tracker/server.js";
import { makeLogger } from "../src/util/logger.js";

// Parse command-line parameters for tracker configuration
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8000" },
    host: { type: "string", default: "0.0.0.0" },
    ttl: { type: "string", default: "90" }, // Peer eviction threshold (seconds)
    interval: { type: "string", default: "15" }, // Swarm announce heartbeat interval (seconds)
  },
});

const log = makeLogger("tracker");

// Instantiate HTTP tracker server factory
const tracker = createTracker({
  port: Number(values.port),
  host: values.host,
  peerTtlMs: Number(values.ttl) * 1000,
  intervalSec: Number(values.interval),
  log,
});

const port = await tracker.listen();
log(`listening on ${values.host}:${port} (peer ttl ${values.ttl}s)`);

// Graceful termination handling
process.on("SIGINT", async () => {
  await tracker.close();
  process.exit(0);
});
