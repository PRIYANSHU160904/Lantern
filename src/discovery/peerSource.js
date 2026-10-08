import { EventEmitter } from 'node:events';

// Every discovery mechanism (tracker, PEX, DHT) extends this.
// Contract: call start(), then listen for 'peers' events carrying [{ ip, port }].
// The peer core never needs to know which mechanism produced an address.
export class PeerSource extends EventEmitter {
  // eslint-disable-next-line no-unused-vars
  start(infoHash, myPort) { throw new Error('not implemented'); }
  stop() {}
}
