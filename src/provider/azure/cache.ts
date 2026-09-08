import { RedisCacheBase, redisConnectionOptions } from '../shared/redis-cache.js';
import { InvalidCredentialsError } from '../../errors.js';

/** Azure Cache for Redis. Always uses TLS. */
export class AzureRedisCache extends RedisCacheBase {
  constructor(endpoint: string, password: string, db: number) {
    if (!endpoint) throw new InvalidCredentialsError('endpoint is required for Azure Cache for Redis');
    super('azure', redisConnectionOptions(endpoint, password, true, db));
  }
}
