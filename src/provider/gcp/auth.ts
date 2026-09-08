import type { GcpCredentials } from '../../credentials/index.js';
import { InvalidCredentialsError, messageOf } from '../../errors.js';

/** Shared client options for every @google-cloud/* constructor. */
export interface GcpClientConfig {
  projectId: string;
  credentials: Record<string, unknown>;
  // google-cloud client options are structurally indexed; without this the
  // config is not assignable to their ClientOptions.
  [option: string]: string | number | object | undefined;
}

/** Parses the service-account JSON into the shape google-cloud clients expect. */
export function gcpClientConfig(creds: GcpCredentials): GcpClientConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(creds.serviceAccountJson) as Record<string, unknown>;
  } catch (err) {
    throw new InvalidCredentialsError(`failed to parse GCP service account JSON: ${messageOf(err)}`);
  }
  return { projectId: creds.projectId, credentials: parsed };
}
