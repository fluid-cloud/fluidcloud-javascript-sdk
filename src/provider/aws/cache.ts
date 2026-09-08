import { InvalidCredentialsError } from '../../errors.js';
import { RedisCacheBase, redisConnectionOptions } from '../shared/redis-cache.js';

/** AWS ElastiCache for Redis. */
export class ElastiCacheRedis extends RedisCacheBase {
  constructor(endpoint: string, password: string, tls: boolean, db: number) {
    if (!endpoint) throw new InvalidCredentialsError('endpoint is required for AWS ElastiCache Redis');
    super('aws', redisConnectionOptions(endpoint, password, tls, db));
  }
}
