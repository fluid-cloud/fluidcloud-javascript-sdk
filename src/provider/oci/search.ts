import { Client } from '@opensearch-project/opensearch';

import { InvalidCredentialsError } from '../../errors.js';
import { OpenSearchBase } from '../aws/search.js';
import type { Search } from '../types/search.js';

/** OCI Search with OpenSearch-backed Search, authenticated with HTTP basic auth. */
export class OpenSearchOci extends OpenSearchBase implements Search {
  constructor(endpoint: string, username: string, password: string) {
    if (!endpoint) throw new InvalidCredentialsError('endpoint is required for OCI OpenSearch');
    const client = new Client({ node: endpoint, auth: { username, password } });
    super(client, 'oci');
  }
}
