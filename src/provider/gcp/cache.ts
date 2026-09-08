import { RedisCacheBase, redisConnectionOptions } from '../shared/redis-cache.js';
import { InvalidCredentialsError } from '../../errors.js';

/** GCP Memorystore for Redis. */
export class MemorystoreRedis extends RedisCacheBase {
  constructor(endpoint: string, password: string, tls: boolean, db: number) {
    if (!endpoint) throw new InvalidCredentialsError('endpoint is required for GCP Memorystore Redis');
    super('gcp', redisConnectionOptions(endpoint, password, tls, db));
  }
}
