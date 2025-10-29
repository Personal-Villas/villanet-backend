import NodeCache from 'node-cache';

// Configuración del caché
const cache = new NodeCache({
  stdTTL: 300,      
  checkperiod: 60,      
  useClones: false,      
  deleteOnExpire: true 
});

// Log para debugging (opcional)
cache.on('set', (key, value) => {
  console.log(`[Cache] SET: ${key}`);
});

cache.on('expired', (key, value) => {
  console.log(`[Cache] EXPIRED: ${key}`);
});

export { cache };