import NodeCache from 'node-cache';

const cache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false,
  deleteOnExpire: true
});

cache.on('set', (key) => console.log(`[Cache] SET: ${key}`));
cache.on('expired', (key) => console.log(`[Cache] EXPIRED: ${key}`));

export { cache };
