import Redis from 'ioredis';
export const redis = new Redis(process.env.REDIS_URL); // rediss://default:PASS@host:6379
export const kJob   = id => `job:${id}`;
export const kPicks = id => `picks:${id}`;
export const kRecent= ch => `recent:${ch}`;
