// Usage: const log = makeLogger('peerB'); log('got piece', 14, 'from peerA');
export function makeLogger(tag) {
  const t0 = Date.now();
  return (...args) => {
    const s = ((Date.now() - t0) / 1000).toFixed(2).padStart(7);
    console.log(`[${s}s] [${tag}]`, ...args);
  };
}
