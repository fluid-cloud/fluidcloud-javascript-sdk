import Redis, { type RedisOptions } from 'ioredis';
import { NotFoundError, wrapProviderError } from '../../errors.js';
import type { Cache } from '../types/cache.js';

/** Builds ioredis connection options from a "host:port" endpoint. */
export function redisConnectionOptions(endpoint: string, password: string, tls: boolean, db: number): RedisOptions {
  const separator = endpoint.lastIndexOf(':');
  const host = separator === -1 ? endpoint : endpoint.slice(0, separator);
  const port = separator === -1 ? 6379 : Number(endpoint.slice(separator + 1));
  return {
    host,
    port,
    password: password || undefined,
    db,
    tls: tls ? { minVersion: 'TLSv1.2' } : undefined,
    lazyConnect: true,
  };
}

/** Shared Redis wire-protocol implementation of Cache, reused by every managed-Redis provider. */
export abstract class RedisCacheBase implements Cache {
  protected readonly client: Redis;
  protected readonly providerName: string;

  protected constructor(providerName: string, options: RedisOptions) {
    this.providerName = providerName;
    this.client = new Redis(options);
    this.client.on('error', () => {});
  }

  /** Reads a key. Throws NotFoundError when the key is absent. */
  async get(key: string): Promise<string> {
    let val: string | null;
    try {
      val = await this.client.get(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'get', err);
    }
    if (val === null) throw new NotFoundError(`key not found: ${key}`);
    return val;
  }

  /** Writes a key with a TTL in seconds; 0 or absent means no expiry. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch (err) {
      wrapProviderError(this.providerName, 'set', err);
    }
  }

  /** Deletes keys, returning how many were removed. */
  async del(...keys: string[]): Promise<number> {
    try {
      return await this.client.del(...keys);
    } catch (err) {
      wrapProviderError(this.providerName, 'del', err);
    }
  }

  /** Counts which of the given keys exist. */
  async exists(...keys: string[]): Promise<number> {
    try {
      return await this.client.exists(...keys);
    } catch (err) {
      wrapProviderError(this.providerName, 'exists', err);
    }
  }

  /** Sets a TTL in seconds on an existing key. */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      return (await this.client.expire(key, ttlSeconds)) === 1;
    } catch (err) {
      wrapProviderError(this.providerName, 'expire', err);
    }
  }

  /** Reads remaining TTL in seconds; -1 no expiry, -2 missing. */
  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'ttl', err);
    }
  }

  /** Increments by one. */
  async incr(key: string): Promise<number> {
    try {
      return await this.client.incr(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'incr', err);
    }
  }

  /** Increments by n. */
  async incrBy(key: string, n: number): Promise<number> {
    try {
      return await this.client.incrby(key, n);
    } catch (err) {
      wrapProviderError(this.providerName, 'incrBy', err);
    }
  }

  /** Decrements by one. */
  async decr(key: string): Promise<number> {
    try {
      return await this.client.decr(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'decr', err);
    }
  }

  /** Reads one hash field. Throws NotFoundError when the field is absent. */
  async hGet(key: string, field: string): Promise<string> {
    let val: string | null;
    try {
      val = await this.client.hget(key, field);
    } catch (err) {
      wrapProviderError(this.providerName, 'hGet', err);
    }
    if (val === null) throw new NotFoundError(`hash field not found: ${key}.${field}`);
    return val;
  }

  /** Writes hash fields. */
  async hSet(key: string, values: Record<string, string>): Promise<void> {
    try {
      await this.client.hset(key, values);
    } catch (err) {
      wrapProviderError(this.providerName, 'hSet', err);
    }
  }

  /** Reads a whole hash. */
  async hGetAll(key: string): Promise<Record<string, string>> {
    try {
      return await this.client.hgetall(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'hGetAll', err);
    }
  }

  /** Deletes hash fields. */
  async hDel(key: string, ...fields: string[]): Promise<number> {
    try {
      return await this.client.hdel(key, ...fields);
    } catch (err) {
      wrapProviderError(this.providerName, 'hDel', err);
    }
  }

  /** Pushes onto the head. */
  async lPush(key: string, ...values: string[]): Promise<number> {
    try {
      return await this.client.lpush(key, ...values);
    } catch (err) {
      wrapProviderError(this.providerName, 'lPush', err);
    }
  }

  /** Pushes onto the tail. */
  async rPush(key: string, ...values: string[]): Promise<number> {
    try {
      return await this.client.rpush(key, ...values);
    } catch (err) {
      wrapProviderError(this.providerName, 'rPush', err);
    }
  }

  /** Pops from the head. Throws NotFoundError when the list is empty. */
  async lPop(key: string): Promise<string> {
    let val: string | null;
    try {
      val = await this.client.lpop(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'lPop', err);
    }
    if (val === null) throw new NotFoundError(`list is empty: ${key}`);
    return val;
  }

  /** Pops from the tail. Throws NotFoundError when the list is empty. */
  async rPop(key: string): Promise<string> {
    let val: string | null;
    try {
      val = await this.client.rpop(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'rPop', err);
    }
    if (val === null) throw new NotFoundError(`list is empty: ${key}`);
    return val;
  }

  /** Reads an inclusive range. */
  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    try {
      return await this.client.lrange(key, start, stop);
    } catch (err) {
      wrapProviderError(this.providerName, 'lRange', err);
    }
  }

  /** Reads list length. */
  async lLen(key: string): Promise<number> {
    try {
      return await this.client.llen(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'lLen', err);
    }
  }

  /** Adds set members. */
  async sAdd(key: string, ...members: string[]): Promise<number> {
    try {
      return await this.client.sadd(key, ...members);
    } catch (err) {
      wrapProviderError(this.providerName, 'sAdd', err);
    }
  }

  /** Removes set members. */
  async sRem(key: string, ...members: string[]): Promise<number> {
    try {
      return await this.client.srem(key, ...members);
    } catch (err) {
      wrapProviderError(this.providerName, 'sRem', err);
    }
  }

  /** Reads all set members. */
  async sMembers(key: string): Promise<string[]> {
    try {
      return await this.client.smembers(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'sMembers', err);
    }
  }

  /** Reports set membership. */
  async sIsMember(key: string, member: string): Promise<boolean> {
    try {
      return (await this.client.sismember(key, member)) === 1;
    } catch (err) {
      wrapProviderError(this.providerName, 'sIsMember', err);
    }
  }

  /** Lists keys matching a glob pattern. */
  async keys(pattern: string): Promise<string[]> {
    try {
      return await this.client.keys(pattern);
    } catch (err) {
      wrapProviderError(this.providerName, 'keys', err);
    }
  }

  /** Incrementally iterates the keyspace. */
  async scan(cursor: string, match: string, count: number): Promise<{ keys: string[]; cursor: string }> {
    try {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', count);
      return { keys, cursor: nextCursor };
    } catch (err) {
      wrapProviderError(this.providerName, 'scan', err);
    }
  }

  /** Reads a key type. */
  async type(key: string): Promise<string> {
    try {
      return await this.client.type(key);
    } catch (err) {
      wrapProviderError(this.providerName, 'type', err);
    }
  }

  /** Pings the server. */
  async ping(): Promise<void> {
    try {
      await this.client.ping();
    } catch (err) {
      wrapProviderError(this.providerName, 'ping', err);
    }
  }

  /** Flushes the selected logical database. */
  async flushDb(): Promise<void> {
    try {
      await this.client.flushdb();
    } catch (err) {
      wrapProviderError(this.providerName, 'flushDb', err);
    }
  }

  /** Releases the underlying connection pool. */
  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch (err) {
      wrapProviderError(this.providerName, 'close', err);
    }
  }
}
