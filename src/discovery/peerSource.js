import { EventEmitter } from "node:events";

// Abstract base class for peer discovery providers
export class PeerSource extends EventEmitter {
  start(infoHash, myPort) {
    throw new Error("start() must be implemented by subclass");
  }
  stop() {}
}
