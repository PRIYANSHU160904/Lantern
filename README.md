# p2p-share
Small-scale BitTorrent-style P2P file sharing. Node.js >= 20, zero dependencies so far.

    npm test                       # protocol framing tests
    npm run make-torrent -- <file> # (Day 1) create metadata
    npm run tracker                # (Day 2)
    npm run peer -- --port 6881    # (Day 2+)

## Layout
- `src/protocol/`   wire format (framing, codec, bitfield) - DONE, tested
- `src/discovery/`  PeerSource interface; trackerSource (Day 2), pexSource (Day 4), dhtSource (future)
- `src/tracker/`    tracker server only (peers never import this)
- `src/metadata/`   torrent metadata + infoHash
- `src/storage/`    piece store, verification, resume
- `src/peer/`       peer core, connection, pieceManager, choker
- `src/ui/`, `dashboard/`  terminal progress and web status page
- `demo/`, `docs/`  demo scripts and design documents
