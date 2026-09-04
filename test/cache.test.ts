import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidCredentialsError, NotFoundError } from '../src/errors.js';

interface MockRedisInstance {
  options: Record<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  ttl: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  incrby: ReturnType<typeof vi.fn>;
  decr: ReturnType<typeof vi.fn>;
  hget: ReturnType<typeof vi.fn>;
  hset: ReturnType<typeof vi.fn>;
  hgetall: ReturnType<typeof vi.fn>;
  hdel: ReturnType<typeof vi.fn>;
  lpush: ReturnType<typeof vi.fn>;
  rpush: ReturnType<typeof vi.fn>;
  lpop: ReturnType<typeof vi.fn>;
  rpop: ReturnType<typeof vi.fn>;
  lrange: ReturnType<typeof vi.fn>;
  llen: ReturnType<typeof vi.fn>;
  sadd: ReturnType<typeof vi.fn>;
  srem: ReturnType<typeof vi.fn>;
  smembers: ReturnType<typeof vi.fn>;
  sismember: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  flushdb: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

const redisInstances: MockRedisInstance[] = [];

vi.mock('ioredis', () => {
  class MockRedis {
    options: Record<string, unknown>;
    get = vi.fn();
    set = vi.fn();
    del = vi.fn();
    exists = vi.fn();
    expire = vi.fn();
    ttl = vi.fn();
    incr = vi.fn();
    incrby = vi.fn();
    decr = vi.fn();
    hget = vi.fn();
    hset = vi.fn();
    hgetall = vi.fn();
    hdel = vi.fn();
    lpush = vi.fn();
    rpush = vi.fn();
    lpop = vi.fn();
    rpop = vi.fn();
    lrange = vi.fn();
    llen = vi.fn();
    sadd = vi.fn();
    srem = vi.fn();
    smembers = vi.fn();
    sismember = vi.fn();
    keys = vi.fn();
    scan = vi.fn();
    type = vi.fn();
    ping = vi.fn();
    flushdb = vi.fn();
    quit = vi.fn();
    on = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      redisInstances.push(this as unknown as MockRedisInstance);
    }
  }
  return { default: MockRedis };
});

const { ElastiCacheRedis } = await import('../src/provider/aws/cache.js');
const { AzureRedisCache } = await import('../src/provider/azure/cache.js');
const { MemorystoreRedis } = await import('../src/provider/gcp/cache.js');
const { OciRedisCache } = await import('../src/provider/oci/cache.js');

beforeEach(() => {
  redisInstances.length = 0;
});

describe('constructor endpoint translation', () => {
  it('AWS with TLS on splits host:port and sets a TLS config', () => {
    new ElastiCacheRedis('redis.example.com:6380', 'secret', true, 2);
    expect(redisInstances[0].options).toMatchObject({
      host: 'redis.example.com',
      port: 6380,
      password: 'secret',
      db: 2,
      tls: { minVersion: 'TLSv1.2' },
    });
  });

  it('AWS with TLS off sends no TLS config and no password', () => {
    new ElastiCacheRedis('redis.example.com:6379', '', false, 0);
    expect(redisInstances[0].options.tls).toBeUndefined();
    expect(redisInstances[0].options.password).toBeUndefined();
  });

  it('Azure always forces TLS even though its constructor takes no tls flag', () => {
    new AzureRedisCache('myazure.redis.cache.windows.net:6380', 'accessKey', 0);
    expect(redisInstances[0].options.tls).toEqual({ minVersion: 'TLSv1.2' });
  });

  it.each([
    ['aws', () => new ElastiCacheRedis('', 'p', false, 0)],
    ['azure', () => new AzureRedisCache('', 'p', 0)],
    ['gcp', () => new MemorystoreRedis('', 'p', false, 0)],
    ['oci', () => new OciRedisCache('', 'p', false, 0)],
  ])('%s throws InvalidCredentialsError when endpoint is empty', (_name, factory) => {
    expect(factory).toThrow(InvalidCredentialsError);
  });
});

describe('happy path method mapping (AWS, most translation logic)', () => {
  let cache: InstanceType<typeof ElastiCacheRedis>;
  let redis: MockRedisInstance;

  beforeEach(() => {
    cache = new ElastiCacheRedis('h:6379', 'p', false, 0);
    redis = redisInstances[0];
  });

  it('get maps to client.get', async () => {
    redis.get.mockResolvedValue('v1');
    await expect(cache.get('k')).resolves.toBe('v1');
    expect(redis.get).toHaveBeenCalledWith('k');
  });

  it('set with a TTL sends EX', async () => {
    redis.set.mockResolvedValue('OK');
    await cache.set('k', 'v', 30);
    expect(redis.set).toHaveBeenCalledWith('k', 'v', 'EX', 30);
  });

  it('set without a TTL sends no expiry', async () => {
    redis.set.mockResolvedValue('OK');
    await cache.set('k', 'v');
    expect(redis.set).toHaveBeenCalledWith('k', 'v');
  });

  it('set with ttlSeconds 0 sends no expiry', async () => {
    redis.set.mockResolvedValue('OK');
    await cache.set('k', 'v', 0);
    expect(redis.set).toHaveBeenCalledWith('k', 'v');
  });

  it('del passes through all keys and the count', async () => {
    redis.del.mockResolvedValue(2);
    await expect(cache.del('a', 'b')).resolves.toBe(2);
    expect(redis.del).toHaveBeenCalledWith('a', 'b');
  });

  it('exists passes through all keys and the count', async () => {
    redis.exists.mockResolvedValue(1);
    await expect(cache.exists('a', 'b')).resolves.toBe(1);
    expect(redis.exists).toHaveBeenCalledWith('a', 'b');
  });

  it.each([
    [1, true],
    [0, false],
  ])('expire maps redis %i to boolean %s', async (raw, expected) => {
    redis.expire.mockResolvedValue(raw);
    await expect(cache.expire('k', 60)).resolves.toBe(expected);
    expect(redis.expire).toHaveBeenCalledWith('k', 60);
  });

  it.each([-1, -2, 42])('ttl passes through redis value %i unchanged', async (raw) => {
    redis.ttl.mockResolvedValue(raw);
    await expect(cache.ttl('k')).resolves.toBe(raw);
  });

  it('incr / incrBy / decr map to their redis commands', async () => {
    redis.incr.mockResolvedValue(1);
    redis.incrby.mockResolvedValue(6);
    redis.decr.mockResolvedValue(-1);
    await expect(cache.incr('k')).resolves.toBe(1);
    await expect(cache.incrBy('k', 5)).resolves.toBe(6);
    expect(redis.incrby).toHaveBeenCalledWith('k', 5);
    await expect(cache.decr('k')).resolves.toBe(-1);
  });

  it('hSet passes the field map through, hGetAll returns the hash', async () => {
    redis.hset.mockResolvedValue(2);
    redis.hgetall.mockResolvedValue({ a: '1', b: '2' });
    await cache.hSet('k', { a: '1', b: '2' });
    expect(redis.hset).toHaveBeenCalledWith('k', { a: '1', b: '2' });
    await expect(cache.hGetAll('k')).resolves.toEqual({ a: '1', b: '2' });
  });

  it('hDel passes through fields and the count', async () => {
    redis.hdel.mockResolvedValue(2);
    await expect(cache.hDel('k', 'a', 'b')).resolves.toBe(2);
    expect(redis.hdel).toHaveBeenCalledWith('k', 'a', 'b');
  });

  it('lPush / rPush pass through values and the new length', async () => {
    redis.lpush.mockResolvedValue(2);
    redis.rpush.mockResolvedValue(3);
    await expect(cache.lPush('k', 'a', 'b')).resolves.toBe(2);
    expect(redis.lpush).toHaveBeenCalledWith('k', 'a', 'b');
    await expect(cache.rPush('k', 'c')).resolves.toBe(3);
    expect(redis.rpush).toHaveBeenCalledWith('k', 'c');
  });

  it('lRange and lLen map straight through', async () => {
    redis.lrange.mockResolvedValue(['a', 'b']);
    redis.llen.mockResolvedValue(2);
    await expect(cache.lRange('k', 0, -1)).resolves.toEqual(['a', 'b']);
    expect(redis.lrange).toHaveBeenCalledWith('k', 0, -1);
    await expect(cache.lLen('k')).resolves.toBe(2);
  });

  it('sAdd / sRem / sMembers map straight through', async () => {
    redis.sadd.mockResolvedValue(1);
    redis.srem.mockResolvedValue(1);
    redis.smembers.mockResolvedValue(['x']);
    await expect(cache.sAdd('k', 'x')).resolves.toBe(1);
    await expect(cache.sRem('k', 'x')).resolves.toBe(1);
    await expect(cache.sMembers('k')).resolves.toEqual(['x']);
  });

  it.each([
    [1, true],
    [0, false],
  ])('sIsMember maps redis %i to boolean %s', async (raw, expected) => {
    redis.sismember.mockResolvedValue(raw);
    await expect(cache.sIsMember('k', 'x')).resolves.toBe(expected);
  });

  it('keys maps to client.keys', async () => {
    redis.keys.mockResolvedValue(['a', 'b']);
    await expect(cache.keys('a*')).resolves.toEqual(['a', 'b']);
    expect(redis.keys).toHaveBeenCalledWith('a*');
  });

  it('scan sends MATCH/COUNT tokens and returns a string cursor', async () => {
    redis.scan.mockResolvedValue(['12', ['a', 'b']]);
    await expect(cache.scan('0', 'a*', 10)).resolves.toEqual({ keys: ['a', 'b'], cursor: '12' });
    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'a*', 'COUNT', 10);
  });

  it('type / ping / flushDb / close map to their redis commands', async () => {
    redis.type.mockResolvedValue('string');
    redis.ping.mockResolvedValue('PONG');
    redis.flushdb.mockResolvedValue('OK');
    redis.quit.mockResolvedValue('OK');
    await expect(cache.type('k')).resolves.toBe('string');
    await cache.ping();
    await cache.flushDb();
    await cache.close();
    expect(redis.quit).toHaveBeenCalled();
  });
});

describe('not-found mapping', () => {
  let cache: InstanceType<typeof ElastiCacheRedis>;
  let redis: MockRedisInstance;

  beforeEach(() => {
    cache = new ElastiCacheRedis('h:6379', 'p', false, 0);
    redis = redisInstances[0];
  });

  it.each([
    ['get', () => cache.get('missing'), 'get'],
    ['hGet', () => cache.hGet('missing', 'f'), 'hget'],
    ['lPop', () => cache.lPop('missing'), 'lpop'],
    ['rPop', () => cache.rPop('missing'), 'rpop'],
  ] as const)('%s throws NotFoundError when redis returns null', async (_method, call, mockName) => {
    (redis[mockName] as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(call()).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('provider error wrapping', () => {
  it('wraps a redis failure with provider and operation context', async () => {
    const cache = new ElastiCacheRedis('h:6379', 'p', false, 0);
    const redis = redisInstances[0];
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(cache.get('k')).rejects.toThrow(/aws: get failed: ECONNREFUSED/);
  });
});
