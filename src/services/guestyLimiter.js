import Bottleneck from 'bottleneck';

export const guestyLimiter = new Bottleneck({
  minTime: 200,           // ~5 req/seg
  reservoir: 10,          // burst inicial
  reservoirRefreshAmount: 10,
  reservoirRefreshInterval: 1000, // cada 1s
});