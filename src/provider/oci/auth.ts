import * as common from 'oci-common';

import type { OciCredentials } from '../../credentials/index.js';

/** Builds the API-signing-key auth provider every OCI client needs. */
export function ociAuthProvider(creds: OciCredentials): common.SimpleAuthenticationDetailsProvider {
  return new common.SimpleAuthenticationDetailsProvider(
    creds.tenancyOcid,
    creds.userOcid,
    creds.fingerprint,
    creds.privateKey,
    null,
    creds.region ? common.Region.fromRegionId(creds.region) : undefined,
  );
}
