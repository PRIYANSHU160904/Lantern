# Lantern

A small BitTorrent-style peer-to-peer file sharing system for local networks, written in Node.js with no third-party dependencies.

A file is described by a metadata file that records the SHA-256 hash of every piece. Peers find each other through a lightweight tracker and by exchanging peer lists with one another, then transfer pieces directly over TCP. The tracker never handles file data. Each piece is checked against the metadata before it is written to disk, so a corrupted or tampered piece cannot end up in the downloaded file.

## Features

- Concurrent download of different pieces from multiple peers, rarest piece first
- Per-piece SHA-256 verification; a peer that sends bad data is struck and banned after three offences
- Transfers survive peers, including the only seed, and the tracker disappearing mid-download
- Resume: restarting a peer on the same file re-hashes it and fetches only what is missing
- Tit-for-tat choking with an optimistic unchoke slot and a per-peer contribution ledger, to discourage download-only peers
- Peer exchange (PEX), so the swarm stays connected without the tracker
- Fault-injection flags and a scripted demo that verifies every downloaded file by hash

## Requirements

Node.js 20 or later. There are no dependencies, so `npm install` is not needed.

## Quick start

```
npm test                  # test suite
npm run demo              # scripted demo, see "Demo scenarios"
```

To run a swarm by hand, see [Running a swarm](#running-a-swarm).

## Architecture

```
          HTTP (JSON)                          TCP (binary frames)
  Peer ------------------> Tracker      Peer <------------------> Peer
   "who else is in swarm X?"             HANDSHAKE, BITFIELD, HAVE, REQUEST, PIECE, ...
   (no file data, no piece info)         all file data moves here
```

| Component     | Role                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Metadata file | File name, size, piece size and the SHA-256 of every piece. Its hash (the infoHash) identifies the swarm.      |
| Tracker       | Keeps a list of peers per swarm and returns it on request. Forgets peers that stop announcing.                 |
| Peer          | Downloads and uploads at the same time. A peer with every piece is a seed.                                     |
| PEX           | Peers send each other the addresses of the peers they know, so discovery keeps working if the tracker is gone. |

Each peer is built from separate layers: `Connection` (one socket: handshake, framing, keepalive), `PieceManager` (what to request from whom), `Choker` (who may download from me), `PieceStore` (verified reads and writes) and `Peer` (wires them together).

## Command reference

All commands are run from the project root. Each also has an npm script (`npm run tracker`, `npm run peer`, `npm run make-torrent`; arguments go after `--`).

### `bin/make-torrent.js`

Creates a metadata file for a file.

```
node bin/make-torrent.js <file> [--out <path>] [--piece-length <bytes>]
```

| Option           | Default               | Description                                             |
| ---------------- | --------------------- | ------------------------------------------------------- |
| `<file>`         | required              | File to share. The metadata records its base name.      |
| `--out`          | `<file>.torrent.json` | Where to write the metadata.                            |
| `--piece-length` | `262144` (256 KiB)    | Piece size in bytes. The last piece is usually shorter. |

It prints the name, size, piece count and infoHash. Every peer in a swarm needs the same metadata file.

### `bin/tracker.js`

```
node bin/tracker.js [--port <n>] [--host <addr>] [--ttl <s>] [--interval <s>]
```

| Option       | Default   | Description                                                                                         |
| ------------ | --------- | --------------------------------------------------------------------------------------------------- |
| `--port`     | `8000`    | HTTP port to listen on.                                                                             |
| `--host`     | `0.0.0.0` | Interface to bind.                                                                                  |
| `--ttl`      | `90`      | Seconds without an announce before a peer is dropped. A peer that exits cleanly is removed at once. |
| `--interval` | `15`      | Announce interval, in seconds, that peers are told to use.                                          |

HTTP endpoints:

| Endpoint                                                               | Description                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /announce?infoHash=<64 hex>&peerId=<40 hex>&port=<n>[&event=<e>]` | Registers the peer and returns `{interval, peers:[{peerId, ip, port}]}`: up to 50 random other peers, never the caller. `event` is `started`, `completed` or `stopped`; omit it for a routine re-announce. Malformed parameters return 400. |
| `GET /stats`                                                           | Peers currently registered, per swarm. For debugging.                                                                                                                                                                                       |

### `bin/peer.js`

```
node bin/peer.js --torrent <meta.json> (--file <path> | --dir <directory>) [options]
```

Exactly one of `--file` and `--dir` is required.

**Files**

| Option              | Default  | Description                                                                                                                              |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--torrent <path>`  | required | Metadata file from `make-torrent`.                                                                                                       |
| `--file <path>`     |          | Path of this peer's copy. For a seed, the existing complete file. For a leecher, where to write; missing parent directories are created. |
| `--dir <directory>` |          | Directory only. The file is stored as `<directory>/<name from the metadata>`.                                                            |

An existing file is verified piece by piece on startup. Valid pieces are kept, so pointing a peer at a partial download resumes it, and pointing a seed at the complete file makes it seed immediately.

**Identity and network**

| Option          | Default   | Description                                                                                                                      |
| --------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--name <text>` | `peer`    | Label shown in logs. The first 8 characters are embedded in the peer ID, which is how other peers' logs refer to this one.       |
| `--port <n>`    | `0`       | TCP port to accept connections on. `0` picks a free port. Pin it when running across machines so firewall rules are predictable. |
| `--host <addr>` | `0.0.0.0` | Interface to bind.                                                                                                               |

**Discovery**

| Option                | Default | Description                                                                                                    |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `--tracker <url>`     | none    | Tracker to announce to, for example `http://192.168.1.10:8000`. Without it, use `--connect`.                   |
| `--connect <ip:port>` | none    | Dial a peer directly. May be repeated. IPv4 only.                                                              |
| `--pex-interval <ms>` | `30000` | How often to send known peer addresses to connected peers. They are also sent right after every new handshake. |

**Transfer tuning**

| Option                  | Default | Description                                                       |
| ----------------------- | ------- | ----------------------------------------------------------------- |
| `--max-peers <n>`       | `30`    | Maximum simultaneous connections.                                 |
| `--slots <n>`           | `3`     | Regular unchoke slots. One extra optimistic slot is always added. |
| `--choke-interval <ms>` | `10000` | How often the choker re-decides who gets an unchoke.              |

**Testing and fault injection**

| Option                     | Default         | Description                                                                                                 |
| -------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `--upload-limit <bytes/s>` | `0` (unlimited) | Caps this peer's total upload. Without it, localhost transfers finish too quickly to observe.               |
| `--malicious`              | off             | Corrupts one byte of every piece this peer uploads. Receivers should detect it, strike the peer and ban it. |
| `--freerider`              | off             | Never uploads and never unchokes anyone.                                                                    |

**Output and lifecycle**

| Option                  | Default | Description                                                                                                    |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `--progress-every <ms>` | `3000`  | Interval of the progress line. Checked on a one-second tick, so use multiples of 1000. `0` turns it off.       |
| `--status-port <n>`     | off     | Serves `GET /status` (JSON) on this port. Read-only and unauthenticated.                                       |
| `--exit-on-complete`    | off     | Exit shortly after the download finishes, telling the tracker first. By default a finished peer keeps seeding. |

Not exposed as flags, but set in the `Peer` constructor (`src/peer/peer.js`): requests in flight per peer (4), request timeout (10 s) and the contribution-ledger grace allowance (2 pieces).

`GET /status` returns the peer name and ID, progress (`have`, `total`, a `bitfield` string of 0 and 1), `sources` (which peer supplied each piece), transfer and failure counters (`stats`), and one entry per connection with piece count, choke and interest flags, rates and bytes transferred.

### `demo/run-demo.js`

```
node demo/run-demo.js [full | seed-dies | malicious | freerider | all] [--size-mb <n>] [--piece-kb <n>]
```

| Option       | Default | Description                                                                              |
| ------------ | ------- | ---------------------------------------------------------------------------------------- |
| scenario     | `full`  | Scenario to run, or `all` to run each in turn.                                           |
| `--size-mb`  | `8`     | Size of the generated test file. A few extra bytes are added so the last piece is short. |
| `--piece-kb` | `64`    | Piece size in KiB.                                                                       |

The demo starts real tracker and peer processes (tracker on port 18000, peers from 19001, status ports from 19101), injects failures, then hashes every downloaded file against the original and prints a summary table. It exits with status 0 if all files match. Working files go in `data/demo/` and are recreated on each run.

## Running a swarm

Open one terminal per process. This example uses a 20 MiB file and 64 KiB pieces.

```
# once: create a test file and its metadata
node -e "require('fs').writeFileSync('data/seed/test.bin', require('crypto').randomBytes(20*1024*1024))"
node bin/make-torrent.js data/seed/test.bin --out data/test.torrent.json --piece-length 65536

# terminal 1: tracker
node bin/tracker.js --port 8000

# terminal 2: seed (rate-limited so the transfer is visible)
node bin/peer.js --torrent data/test.torrent.json --dir data/seed --name seed \
  --tracker http://127.0.0.1:8000 --upload-limit 1500000

# terminals 3 to 5: leechers
node bin/peer.js --torrent data/test.torrent.json --dir data/downloads/A --name A --tracker http://127.0.0.1:8000
node bin/peer.js --torrent data/test.torrent.json --dir data/downloads/B --name B --tracker http://127.0.0.1:8000
node bin/peer.js --torrent data/test.torrent.json --dir data/downloads/C --name C --tracker http://127.0.0.1:8000
```

Each leecher logs which peer every piece came from. When one finishes it keeps seeding. Compare the results with `sha256sum` (macOS: `shasum -a 256`; Windows: `certutil -hashfile <file> SHA256`).

Things to try:

| Action             | How                                                                               | Expected                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Crash a peer       | `Ctrl-C` for a clean exit, or `kill -9 <pid>` (Windows: `taskkill /F /PID <pid>`) | Others log `X disconnected, requeued N` and finish. A clean exit is removed from the tracker at once; a crash after the tracker TTL. |
| Resume             | Restart the crashed leecher with the same `--dir` or `--file`                     | It reports the pieces already on disk and fetches only the rest.                                                                     |
| Kill the tracker   | `Ctrl-C` in its terminal                                                          | Peers log `tracker unreachable` and keep transferring.                                                                               |
| Tampering          | Add a peer started with `--malicious`                                             | Receivers log `HASH MISMATCH`, then `strike n/3`, then `BANNED`. Final files are unaffected.                                         |
| Download-only peer | Add a peer started with `--freerider`                                             | It completes later than contributing peers when upload bandwidth is scarce.                                                          |
| No tracker         | Start peers with `--connect <ip>:<port>` and no `--tracker`                       | Peers find the rest through PEX.                                                                                                     |

### Several machines on a LAN

Run the tracker on one machine and give every peer `--tracker http://<tracker-ip>:8000`. Pin each peer's `--port` and allow those TCP ports through the firewall. Copy the same metadata file to every machine. The tracker records the address each peer announces from, so this is meant for a flat LAN and does not handle NAT.

## Demo scenarios

| Scenario    | What happens                                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`      | One seed and three leechers. Peer B is killed with SIGKILL at 30% and restarted three seconds later, resuming from disk. The tracker is then killed once A reaches 70%. All peers still finish. |
| `seed-dies` | The only seed is killed once the leechers together hold every piece. They finish among themselves.                                                                                              |
| `malicious` | A peer corrupts everything it uploads. It is detected, struck three times and banned, and the other peers' files still match.                                                                   |
| `freerider` | Five contributing peers and two free-riders with scarce upload bandwidth. Prints the time to reach 50%, 90% and 100% for each group.                                                            |

## Reading the logs

| Log line                                                                | Meaning                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `connected to B (127.0.0.1:38605) [2 peers]`                            | Handshake completed with B. The address is B's listening port, not the source port of the socket. |
| `got piece 17 from B [20/81]`                                           | Piece 17 verified and stored; 20 of 81 pieces held.                                               |
| `HASH MISMATCH piece 17 from evil, discarding`                          | Data failed verification and was dropped.                                                         |
| `strike 2/3 against evil: bad data for piece 17`                        | Strike count for that peer.                                                                       |
| `BANNED evil (disconnecting)`                                           | Third strike. The peer is disconnected and refused on reconnect.                                  |
| `B disconnected, requeued 3 in-flight piece(s)`                         | A peer left; its outstanding requests go back to the pool.                                        |
| `request for piece 9 timed out, re-requesting elsewhere`                | No reply within 10 s.                                                                             |
| `unchoked: [A,B*] (* = optimistic)`                                     | Peers currently allowed to download from this peer.                                               |
| `tracker unreachable (...); continuing without it, will retry`          | Tracker is down; peers keep working.                                                              |
| `[#########...........] 45% 36/81  down 512 KB/s  up 120 KB/s  peers 3` | Progress line (`--progress-every`).                                                               |
| `*** DOWNLOAD COMPLETE (81 pieces; sources A:30 seed:51) - now seeding` | Download finished, with the number of pieces from each source.                                    |

## Protocol

Every message on a TCP connection is a frame:

```
[ u32 length ][ u8 type ][ payload ]        length = 1 + payload size, big-endian
```

A frame with length 0 is a keepalive. Frames larger than the piece size plus 1 KiB are rejected, and any malformed message closes the connection.

| Type   | Message        | Payload                                                                                                        |
| ------ | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `0x00` | HANDSHAKE      | version `u8`, infoHash `32 B`, peerId `20 B`, listenPort `u16`. Sent by both sides first; infoHash must match. |
| `0x01` | BITFIELD       | One bit per piece, piece 0 in the top bit of byte 0. Sent once after the handshake.                            |
| `0x02` | HAVE           | Piece index `u32`. Sent to all peers after a piece is verified.                                                |
| `0x03` | REQUEST        | Piece index `u32`.                                                                                             |
| `0x04` | PIECE          | Piece index `u32`, then the piece data.                                                                        |
| `0x05` | CHOKE          | none. The sender will not serve requests.                                                                      |
| `0x06` | UNCHOKE        | none. The sender will serve requests.                                                                          |
| `0x07` | INTERESTED     | none. The sender wants a piece the receiver has.                                                               |
| `0x08` | NOT_INTERESTED | none.                                                                                                          |
| `0x09` | REJECT         | Piece index `u32`, reason `u8` (1 choked, 2 does not have it, 3 busy).                                         |
| `0x0A` | PEX            | Count `u16`, then that many entries of IPv4 `4 B` and port `u16` (at most 50).                                 |

Whole pieces are requested in one message; there are no sub-piece blocks.

## Design notes

**Piece selection.** Among pieces a peer can supply and this peer lacks, the one held by the fewest connected peers is requested first, with random tie-breaking. Up to four requests are kept in flight per peer. When three or fewer pieces remain, they may be requested from two peers at once so a slow peer cannot hold up the finish.

**Integrity.** `PieceStore.write` verifies length and SHA-256 before writing, and marks the piece as held only after the write completes. Nothing unverified reaches the file or the bitfield. Three bad pieces from one peer ban its peer ID and address.

**Churn.** When a connection closes, everything requested from that peer is returned to the pool. Requests unanswered for 10 s are cancelled and re-issued elsewhere. Pieces are independent and verified, so a departing peer cannot corrupt the download. A peer that sends nothing for 90 s is dropped; a keepalive is sent after 30 s without sending anything.

**Fairness.** Every 10 s the choker unchokes the three interested peers that gave the best download rate, plus one optimistic peer rotated every three rounds so newcomers can start. A peer that has taken at least two pieces' worth of data while returning under 10% of it is treated as a free-rider and receives only slots nobody else wants. A seed serves the least-served peers first.

**Discovery.** The tracker answers "who is in swarm X"; `BITFIELD` and `HAVE` messages answer "who has which pieces". Discovery sources implement one small interface (`src/discovery/peerSource.js`), so another mechanism such as a DHT could be added next to the tracker and PEX.

Known limits: LAN only (no NAT traversal); identities are free, so a free-rider that reconnects under a new ID gets a new grace allowance; the metadata file must reach peers through a trusted channel; the piece list is a flat hash list rather than a Merkle tree; no encryption.

## Project layout

```
bin/            make-torrent.js, tracker.js, peer.js
demo/           run-demo.js
src/
  protocol/     frame parser, message codec, bitfield, constants
  metadata/     torrent.js: piece hashes and infoHash
  storage/      pieceStore.js: verified reads and writes, resume
  tracker/      server.js
  discovery/    peerSource.js (interface), trackerSource.js, pexSource.js
  peer/         connection.js, pieceManager.js, choker.js, peer.js
  ui/           statusServer.js (GET /status)
  util/         logger, random helpers
test/           unit and end-to-end tests
docs/           design and requirements notes
data/           seed files and downloads (git-ignored)
```

## Tests

```
npm test
```

Covers the wire format, tracker, piece selection, choking, storage and connection handling, plus end-to-end swarms with real tracker, sockets and files: peers dying mid-transfer, the only seed dying, a tampering peer, tracker loss, discovery through PEX alone, restart and resume, late joiners and files with a short last piece.

## Troubleshooting

| Problem                                                 | Likely cause                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE`                                            | The port is taken, often by an earlier run still alive. Use another `--port`, or stop the old process. The demo needs 18000, 19001+ and 19101+ free. |
| Peers on different machines never connect               | Firewall blocking the peers' TCP ports, or the tracker is not reachable at the URL given. Check `http://<tracker-ip>:8000/stats`.                    |
| Transfer finishes instantly on localhost                | Expected for small files. Use `--upload-limit` on the seed or a larger file.                                                                         |
| `required: --torrent ... exactly one of --file / --dir` | Pass `--torrent` and one of `--file` or `--dir`, not both.                                                                                           |
