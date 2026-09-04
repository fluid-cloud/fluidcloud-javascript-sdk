import { createClient, type Client, type ClientOptions } from '../../src/index.js';

/** Every environment knob the live suites read, mirroring the Go SDK Makefile. */
export const env = {
  serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
  apiKey: process.env.API_KEY ?? '',
  entityIds: {
    aws: process.env.ENTITY_ID_AWS ?? '',
    azure: process.env.ENTITY_ID_AZURE ?? '',
    gcp: process.env.ENTITY_ID_GCP ?? '',
    oci: process.env.ENTITY_ID_OCI ?? '',
  },
  buckets: {
    aws: process.env.TEST_BUCKET ?? '',
    azure: process.env.AZURE_TEST_CONTAINER ?? process.env.TEST_BUCKET ?? '',
    gcp: process.env.GCP_TEST_BUCKET ?? process.env.TEST_BUCKET ?? '',
    oci: process.env.OCI_TEST_BUCKET ?? '',
  },
  azure: {
    storageAccount: process.env.AZURE_STORAGE_ACCOUNT ?? '',
    storageAccountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY ?? '',
    keyVaultName: process.env.AZURE_KEY_VAULT ?? '',
    appConfigEndpoint: process.env.AZURE_APPCONFIG_ENDPOINT ?? '',
    serviceBusNamespace: process.env.AZURE_SERVICEBUS_NAMESPACE ?? '',
    resourceGroup: process.env.AZURE_RESOURCE_GROUP ?? '',
  },
  oci: {
    namespace: process.env.OCI_NAMESPACE ?? '',
    compartment: process.env.OCI_COMPARTMENT ?? '',
    vaultOcid: process.env.OCI_VAULT_OCID ?? '',
    keyOcid: process.env.OCI_KEY_OCID ?? '',
  },
  redis: {
    endpoint: process.env.REDIS_ENDPOINT ?? '',
    password: process.env.REDIS_PASSWORD ?? '',
    tls: process.env.REDIS_TLS === 'true',
  },
  search: {
    endpoint: process.env.SEARCH_ENDPOINT ?? '',
    apiKey: process.env.SEARCH_API_KEY ?? '',
    username: process.env.SEARCH_USERNAME ?? '',
    password: process.env.SEARCH_PASSWORD ?? '',
  },
} as const;

export type ProviderName = 'aws' | 'azure' | 'gcp' | 'oci';
export const PROVIDERS: ProviderName[] = ['aws', 'azure', 'gcp', 'oci'];

/** Explains why a provider cannot be exercised, or null when it can. */
export function skipReason(provider: ProviderName): string | null {
  if (!env.apiKey) return 'API_KEY not provided';
  if (!env.entityIds[provider]) return `ENTITY_ID_${provider.toUpperCase()} not provided`;
  return null;
}

/** Builds a live client for one provider with every option that provider needs. */
export async function clientFor(provider: ProviderName): Promise<Client> {
  const options: ClientOptions = {
    storageAccount: env.azure.storageAccount,
    storageAccountKey: env.azure.storageAccountKey,
    keyVaultName: env.azure.keyVaultName,
    appConfigEndpoint: env.azure.appConfigEndpoint,
    serviceBusNamespace: env.azure.serviceBusNamespace,
    resourceGroup: env.azure.resourceGroup,
    namespace: env.oci.namespace,
    compartment: env.oci.compartment,
    vaultOcid: env.oci.vaultOcid,
    keyOcid: env.oci.keyOcid,
    redisEndpoint: env.redis.endpoint,
    redisPassword: env.redis.password,
    redisTls: env.redis.tls,
    searchEndpoint: env.search.endpoint,
    searchApiKey: env.search.apiKey,
    searchUsername: env.search.username,
    searchPassword: env.search.password,
  };

  return createClient(
    { serverUrl: env.serverUrl, apiKey: env.apiKey, entityId: env.entityIds[provider] },
    options,
  );
}

/** A unique-per-run name so concurrent runs never collide on live resources. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
