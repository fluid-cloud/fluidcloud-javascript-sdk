import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws-v3';

import type { AwsCredentials } from '../../credentials/index.js';
import { InvalidCredentialsError } from '../../errors.js';
import { OpenSearchBase } from '../shared/opensearch.js';
import type { Search } from '../types/search.js';
import { type AwsClientConfig, awsClientConfig } from './auth.js';

function toCredentialsGetter(credentials: AwsClientConfig['credentials']) {
  return async () => (typeof credentials === 'function' ? credentials() : credentials);
}

/** AWS OpenSearch-backed Search, requests signed with SigV4 for the "es" service. */
export class OpenSearchAws extends OpenSearchBase implements Search {
  constructor(creds: AwsCredentials, endpoint: string, region?: string) {
    if (!endpoint) throw new InvalidCredentialsError('endpoint is required for AWS OpenSearch');
    const cfg = awsClientConfig(creds, region);
    const signer = AwsSigv4Signer({
      region: cfg.region,
      service: 'es',
      getCredentials: toCredentialsGetter(cfg.credentials) as never,
    });
    const client = new Client({ ...signer, node: endpoint });
    super(client, 'aws');
  }
}
