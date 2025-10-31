import Bottleneck from 'bottleneck';

export const guestyLimiter = new Bottleneck({
  minTime: 250,                
  reservoir: 8,            
  reservoirRefreshAmount: 8,
  reservoirRefreshInterval: 1000
});