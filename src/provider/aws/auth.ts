import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';

import { AUTH_MODE_ASSUME_ROLE, type AwsCredentials } from '../../credentials/index.js';

/** Shared client config for every @aws-sdk/client-* constructor. */
export interface AwsClientConfig {
  region: string;
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
}

/**
 * Builds the region and credential pair every AWS service client needs.
 * Assume-role entities resolve through STS with the ambient identity as source;
 * the returned provider refreshes the temporary credentials on its own.
 */
export function awsClientConfig(creds: AwsCredentials, regionOverride?: string): AwsClientConfig {
  const region = regionOverride || creds.region;

  if (creds.authMode === AUTH_MODE_ASSUME_ROLE) {
    return {
      region,
      credentials: fromTemporaryCredentials({
        params: {
          RoleArn: creds.roleArn as string,
          RoleSessionName: 'fluidcloud-js-sdk',
          ...(creds.externalId ? { ExternalId: creds.externalId } : {}),
        },
        clientConfig: { region },
      }),
    };
  }

  return {
    region,
    credentials: {
      accessKeyId: creds.accessKey,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  };
}
