import { RedisCacheBase, redisConnectionOptions } from '../aws/cache.js';
import { InvalidCredentialsError } from '../../errors.js';

/** OCI Cache (Redis). */
export class OciRedisCache extends RedisCacheBase {
  constructor(endpoint: string, password: string, tls: boolean, db: number) {
    if (!endpoint) throw new InvalidCredentialsError('endpoint is required for OCI Cache Redis');
    super('oci', redisConnectionOptions(endpoint, password, tls, db));
  }
}
