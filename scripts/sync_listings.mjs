import 'dotenv/config';
import { syncGuestyListings } from '../src/services/syncListings.service.js';

syncGuestyListings().then(n => {
  console.log('Synced rows:', n);
  process.exit(0);
}).catch(e => {
  console.error('Sync failed:', e);
  process.exit(1);
});