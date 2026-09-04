import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  {
    redisEndpoint: process.env.REDIS_ENDPOINT!,
    redisPassword: process.env.REDIS_PASSWORD,
    redisTls: process.env.REDIS_TLS === 'true',
    redisDb: process.env.REDIS_DB ? Number(process.env.REDIS_DB) : 0,
  },
);

const cache = client.cache;

await cache.ping();

await cache.set('greeting', 'hello', 60);
console.log('get:', await cache.get('greeting'));
console.log('ttl:', await cache.ttl('greeting'));

await cache.hSet('user:1', { name: 'ada', role: 'admin' });
console.log('hGetAll:', await cache.hGetAll('user:1'));

await cache.rPush('queue', 'a', 'b', 'c');
console.log('lRange:', await cache.lRange('queue', 0, -1));
console.log('lPop:', await cache.lPop('queue'));

await cache.sAdd('tags', 'ts', 'redis');
console.log('sIsMember:', await cache.sIsMember('tags', 'ts'));

let cursor = '0';
const seen: string[] = [];
do {
  const page = await cache.scan(cursor, '*', 100);
  seen.push(...page.keys);
  cursor = page.cursor;
} while (cursor !== '0');
console.log('scanned keys:', seen);

await cache.del('greeting', 'user:1', 'queue', 'tags');

await client.close();
