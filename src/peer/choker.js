import { shuffle } from "../util/random.js";

export class Choker {
  constructor({
    slots = 3,
    optimisticEvery = 3,
    graceBytes = 0,
    random = Math.random,
  } = {}) {
    Object.assign(this, { slots, optimisticEvery, graceBytes, random });
    this.round = 0;
    this.optimisticId = null;
  }

  // Deadbeat check: uploaded at least graceBytes, but received less than 10% back
  isDeadbeat(p) {
    const up = p.uploaded ?? 0,
      down = p.downloaded ?? 0;
    return (
      up >= this.graceBytes && up > 0 && down < up * 0.1 && this.graceBytes > 0
    );
  }

  select(peers, { isSeed = false } = {}) {
    // Randomize order first to break ties fairly
    const interested = shuffle(
      peers.filter((p) => p.interested),
      this.random,
    );
    const capacity = this.slots + 1;
    let unchoke;

    if (isSeed) {
      // Seeders favor peers that have received the LEAST data so far
      const ranked = [...interested].sort(
        (a, b) => (a.uploaded ?? 0) - (b.uploaded ?? 0),
      );
      unchoke = new Set(ranked.slice(0, this.slots).map((p) => p.id));
      this._optimistic(
        interested.filter((p) => !unchoke.has(p.id)),
        unchoke,
      );
    } else {
      // Leechers prioritize non-deadbeats providing the highest download rates
      const good = interested.filter((p) => !this.isDeadbeat(p));
      const bad = interested.filter((p) => this.isDeadbeat(p));
      const ranked = [...good].sort(
        (a, b) =>
          b.downRate - a.downRate || (b.downloaded ?? 0) - (a.downloaded ?? 0),
      );
      unchoke = new Set(ranked.slice(0, this.slots).map((p) => p.id));
      this._optimistic(
        good.filter((p) => !unchoke.has(p.id)),
        unchoke,
      );
      // Fill unused capacity with deadbeats (work-conserving)
      for (const p of bad) if (unchoke.size < capacity) unchoke.add(p.id);
    }
    this.round++;
    return unchoke;
  }

  _optimistic(rest, unchoke) {
    const stillValid =
      this.optimisticId !== null &&
      rest.some((p) => p.id === this.optimisticId);
    if (this.round % this.optimisticEvery === 0 || !stillValid) {
      this.optimisticId = rest.length
        ? rest[Math.floor(this.random() * rest.length)].id
        : null;
    }
    if (this.optimisticId !== null) unchoke.add(this.optimisticId);
  }
}
