import {
  AccessDeniedError,
  EntityNotFoundError,
  InvalidCredentialsError,
  ProviderError,
  messageOf,
} from '../errors.js';
import { decryptEnvelope, generateEphemeralKeyPair, type EnvelopeResponse } from './envelope.js';

export * from './envelope.js';

/** Cloud provider discriminator carried on every entity. */
export type Provider = 'aws' | 'azure' | 'gcp' | 'oci';

export const PROVIDER_AWS = 'aws' as const;
export const PROVIDER_AZURE = 'azure' as const;
export const PROVIDER_GCP = 'gcp' as const;
export const PROVIDER_OCI = 'oci' as const;

/** AWS auth modes, matching the values fcserver stores for a cloud account. */
export const AUTH_MODE_ACCESS_KEY = 'access_key';
export const AUTH_MODE_ASSUME_ROLE = 'assume_role';

const REQUEST_TIMEOUT_MS = 30_000;

/** AWS credentials. authMode selects between static keys and assume-role. */
export interface AwsCredentials {
  accessKey: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
  authMode?: string;
  roleArn?: string;
  externalId?: string;
}

/** Azure service-principal credentials, plus optional storage account keys. */
export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  storageAccountName?: string;
  storageAccountKey?: string;
}

/** OCI API-signing-key credentials. */
export interface OciCredentials {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKey: string;
  region: string;
  compartmentOcid?: string;
}

/** GCP service-account credentials. GCP authenticates with a JSON key. */
export interface GcpCredentials {
  projectId: string;
  serviceAccountJson: string;
  location?: string;
}

/** A cloud entity as returned by the FluidCloud server. */
export class CloudEntity {
  readonly entityId: string;
  readonly name: string;
  readonly provider: Provider;
  readonly accountId: string;
  readonly region: string;
  readonly status: string;
  readonly credentials: Record<string, unknown>;

  constructor(init: {
    entityId: string;
    provider: Provider;
    region: string;
    credentials: Record<string, unknown>;
    name?: string;
    accountId?: string;
    status?: string;
  }) {
    this.entityId = init.entityId;
    this.provider = init.provider;
    this.region = init.region;
    this.credentials = init.credentials;
    this.name = init.name ?? '';
    this.accountId = init.accountId ?? '';
    this.status = init.status ?? '';
  }

  /** Extracts AWS credentials from the entity. */
  getAwsCredentials(): AwsCredentials {
    if (this.provider !== PROVIDER_AWS) {
      throw new ProviderError(this.provider, 'getAwsCredentials', new InvalidCredentialsError());
    }

    const creds: AwsCredentials = { accessKey: '', secretAccessKey: '', region: this.region };
    const authMode = this.str('authMode');
    if (authMode) creds.authMode = authMode;
    const sessionToken = this.str('sessionToken');
    if (sessionToken) creds.sessionToken = sessionToken;

    // Assume-role accounts carry a role ARN instead of static access keys.
    if (creds.authMode === AUTH_MODE_ASSUME_ROLE) {
      const roleArn = this.str('roleArn');
      if (!roleArn) throw new ProviderError('aws', 'getAwsCredentials', new InvalidCredentialsError());
      creds.roleArn = roleArn;
      const externalId = this.str('externalId');
      if (externalId) creds.externalId = externalId;
      return creds;
    }

    creds.accessKey = this.require('accessKey', 'aws', 'getAwsCredentials');
    creds.secretAccessKey = this.require('secretAccessKey', 'aws', 'getAwsCredentials');
    return creds;
  }

  /** Extracts Azure credentials from the entity. */
  getAzureCredentials(): AzureCredentials {
    if (this.provider !== PROVIDER_AZURE) {
      throw new ProviderError(this.provider, 'getAzureCredentials', new InvalidCredentialsError());
    }
    return {
      tenantId: this.require('tenantId', 'azure', 'getAzureCredentials'),
      clientId: this.require('clientId', 'azure', 'getAzureCredentials'),
      clientSecret: this.require('clientSecret', 'azure', 'getAzureCredentials'),
      subscriptionId: this.require('subscriptionId', 'azure', 'getAzureCredentials'),
    };
  }

  /** Extracts OCI credentials from the entity. */
  getOciCredentials(): OciCredentials {
    if (this.provider !== PROVIDER_OCI) {
      throw new ProviderError(this.provider, 'getOciCredentials', new InvalidCredentialsError());
    }
    const creds: OciCredentials = {
      tenancyOcid: this.require('tenancyOcid', 'oci', 'getOciCredentials'),
      userOcid: this.require('userOcid', 'oci', 'getOciCredentials'),
      fingerprint: this.require('fingerprint', 'oci', 'getOciCredentials'),
      privateKey: this.require('privateKey', 'oci', 'getOciCredentials'),
      region: this.region,
    };
    const compartment = this.str('compartmentOcid');
    if (compartment) creds.compartmentOcid = compartment;
    return creds;
  }

  /** Extracts GCP credentials from the entity. */
  getGcpCredentials(): GcpCredentials {
    if (this.provider !== PROVIDER_GCP) {
      throw new ProviderError(this.provider, 'getGcpCredentials', new InvalidCredentialsError());
    }
    const creds: GcpCredentials = {
      projectId: this.require('projectId', 'gcp', 'getGcpCredentials'),
      serviceAccountJson: this.require('serviceAccountJson', 'gcp', 'getGcpCredentials'),
      location: this.region,
    };
    const location = this.str('location');
    if (location) creds.location = location;
    return creds;
  }

  private str(key: string): string | undefined {
    const value = this.credentials[key];
    return typeof value === 'string' ? value : undefined;
  }

  private require(key: string, provider: string, operation: string): string {
    const value = this.str(key);
    if (!value) throw new ProviderError(provider, operation, new InvalidCredentialsError());
    return value;
  }
}

/** The envelope-encrypted API response shape. */
interface SecureCredentialResponse {
  provider: string;
  region: string;
  encryptedCredentials: string;
  encryptedKey: string;
  nonce: string;
}

/** Fetches envelope-encrypted credentials from the FluidCloud server. */
export class Fetcher {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(fcServerUrl: string, authToken: string) {
    if (!fcServerUrl) throw new InvalidCredentialsError('fcServerUrl is required');
    if (!authToken) throw new InvalidCredentialsError('authToken is required');
    this.baseUrl = fcServerUrl.replace(/\/+$/, '');
    this.authToken = authToken;
  }

  /** No-op; kept for parity with the Go SDK lifecycle. */
  async close(): Promise<void> {}

  /**
   * Fetches the cloud entity with envelope-encrypted credentials:
   *   1. generate an ephemeral RSA-2048 key pair
   *   2. POST the public key to /api/v1/cloudaccounts/{id}/secure-credentials
   *   3. the server encrypts with AES-256-GCM and wraps the DEK with RSA-OAEP-SHA256
   *   4. decrypt locally — the private key never leaves this process
   */
  async getCloudEntitySecure(entityId: string, signal?: AbortSignal): Promise<CloudEntity> {
    const kp = generateEphemeralKeyPair();
    const url = `${this.baseUrl}/api/v1/cloudaccounts/${entityId}/secure-credentials`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'X-API-Key': this.authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: kp.publicKeyPem }),
        signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ProviderError('fcserver', 'getCloudEntitySecure', err);
    }

    const body = await res.text();

    if (res.status === 404) throw new EntityNotFoundError();
    if (res.status === 401 || res.status === 403) throw new AccessDeniedError();
    if (res.status !== 200) {
      throw new ProviderError(
        'fcserver',
        'getCloudEntitySecure',
        new Error(`API returned status ${res.status}: ${body}`),
      );
    }

    let apiResp: SecureCredentialResponse;
    try {
      apiResp = JSON.parse(body) as SecureCredentialResponse;
    } catch (err) {
      throw new ProviderError('fcserver', 'getCloudEntitySecure', new Error(`failed to parse API response: ${messageOf(err)}`));
    }

    const envelope: EnvelopeResponse = {
      provider: apiResp.provider,
      region: apiResp.region,
      encryptedCredentials: apiResp.encryptedCredentials,
      encryptedKey: apiResp.encryptedKey,
      nonce: apiResp.nonce,
    };

    const credentials = decryptEnvelope(kp, envelope);

    return new CloudEntity({
      entityId,
      provider: (apiResp.provider ?? '').toLowerCase() as Provider,
      region: apiResp.region,
      credentials,
    });
  }
}
