import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every provider class is replaced with a marker object, so this test exercises
// only the client's service-gating matrix, never a real cloud SDK.
const stub = (name: string) =>
  vi.fn(function () {
    return { __service: name, close: vi.fn() };
  });

vi.mock('../src/provider/aws/index.js', () => makeProviderModule('aws'));
vi.mock('../src/provider/azure/index.js', () => makeProviderModule('azure'));
vi.mock('../src/provider/gcp/index.js', () => makeProviderModule('gcp'));
vi.mock('../src/provider/oci/index.js', () => makeProviderModule('oci'));

function makeProviderModule(provider: string): Record<string, unknown> {
  const names = [
    'S3Storage',
    'SecretsManager',
    'ParameterStore',
    'SnsMessaging',
    'SqsQueue',
    'SesEmail',
    'CloudWatchMonitoring',
    'CloudTrailAudit',
    'KinesisStreaming',
    'MskStreaming',
    'CloudFrontCdn',
    'CognitoIdentity',
    'ElastiCacheRedis',
    'OpenSearchAws',
    'BlobStorage',
    'KeyVaultSecrets',
    'AppConfigurationParameters',
    'ServiceBusMessaging',
    'ServiceBusQueue',
    'AcsEmail',
    'AzureMonitoring',
    'ActivityLogAudit',
    'EventHubsStreaming',
    'FrontDoorCdn',
    'EntraIdentity',
    'AzureRedisCache',
    'AiSearch',
    'GcsStorage',
    'SecretManagerSecrets',
    'ParameterManagerParameters',
    'PubSubMessaging',
    'PubSubQueue',
    'GcpEmail',
    'CloudMonitoring',
    'CloudAudit',
    'PubSubStreaming',
    'CloudCdn',
    'CloudIdentity',
    'MemorystoreRedis',
    'GcpSearch',
    'ObjectStorage',
    'VaultSecrets',
    'VaultParameters',
    'OnsMessaging',
    'OciQueue',
    'OciEmail',
    'OciMonitoring',
    'OciAudit',
    'OciStreaming',
    'OciCdn',
    'IamDomainsIdentity',
    'OciRedisCache',
    'OpenSearchOci',
  ];
  return Object.fromEntries(names.map((n) => [n, stub(`${provider}.${n}`)]));
}

vi.mock('../src/credentials/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/credentials/index.js')>();
  return {
    ...actual,
    Fetcher: class {
      async close(): Promise<void> {}
      async getCloudEntitySecure(entityId: string): Promise<InstanceType<typeof actual.CloudEntity>> {
        return new actual.CloudEntity({
          entityId,
          provider: currentProvider,
          region: 'us-east-1',
          credentials: credentialsFor(currentProvider),
        });
      }
    },
  };
});

let currentProvider: 'aws' | 'azure' | 'gcp' | 'oci' = 'aws';

function credentialsFor(provider: string): Record<string, unknown> {
  switch (provider) {
    case 'aws':
      return { accessKey: 'AKIA', secretAccessKey: 'shh' };
    case 'azure':
      return { tenantId: 't', clientId: 'c', clientSecret: 's', subscriptionId: 'sub' };
    case 'gcp':
      return { projectId: 'p', serviceAccountJson: '{}' };
    default:
      return { tenancyOcid: 't', userOcid: 'u', fingerprint: 'f', privateKey: 'k', compartmentOcid: 'comp' };
  }
}

const { createClient } = await import('../src/client.js');
const { ValidationError } = await import('../src/errors.js');

describe('createClient', () => {
  beforeEach(() => {
    currentProvider = 'aws';
  });

  it.each([
    ['missing apiKey', { apiKey: '', entityId: 'e' }],
    ['missing entityId', { apiKey: 'k', entityId: '' }],
  ])('rejects %s before any network call', async (_name, cfg) => {
    await expect(createClient(cfg)).rejects.toBeInstanceOf(ValidationError);
  });

  it('creates every always-on service for AWS with no options', async () => {
    const client = await createClient({ apiKey: 'k', entityId: 'e' });
    expect(client.provider).toBe('aws');
    expect([
      client.hasStorage,
      client.hasSecrets,
      client.hasParameters,
      client.hasMessaging,
      client.hasQueue,
      client.hasEmail,
      client.hasMonitoring,
      client.hasAudit,
      client.hasStreaming,
      client.hasCdn,
      client.hasIdentity,
    ]).toEqual(Array(11).fill(true));
    // Cache and search need endpoints that no entity can supply.
    expect(client.hasCache).toBe(false);
    expect(client.hasSearch).toBe(false);
    await client.close();
  });

  it.each([
    ['storage without storageAccount', {}, (c: Awaited<ReturnType<typeof createClient>>) => c.hasStorage, false],
    [
      'storage with storageAccount',
      { storageAccount: 'acct' },
      (c: Awaited<ReturnType<typeof createClient>>) => c.hasStorage,
      true,
    ],
    ['secrets without keyVaultName', {}, (c: Awaited<ReturnType<typeof createClient>>) => c.hasSecrets, false],
    [
      'secrets with keyVaultName',
      { keyVaultName: 'kv' },
      (c: Awaited<ReturnType<typeof createClient>>) => c.hasSecrets,
      true,
    ],
    ['queue without serviceBusNamespace', {}, (c: Awaited<ReturnType<typeof createClient>>) => c.hasQueue, false],
    [
      'queue with serviceBusNamespace',
      { serviceBusNamespace: 'sb' },
      (c: Awaited<ReturnType<typeof createClient>>) => c.hasQueue,
      true,
    ],
    ['cdn without cdnProfileName', {}, (c: Awaited<ReturnType<typeof createClient>>) => c.hasCdn, false],
    [
      'cdn with cdnProfileName',
      { cdnProfileName: 'fd' },
      (c: Awaited<ReturnType<typeof createClient>>) => c.hasCdn,
      true,
    ],
    [
      'streaming without eventHubsNamespace',
      {},
      (c: Awaited<ReturnType<typeof createClient>>) => c.hasStreaming,
      false,
    ],
    [
      'streaming with eventHubsNamespace',
      { eventHubsNamespace: 'eh' },
      (c: Awaited<ReturnType<typeof createClient>>) => c.hasStreaming,
      true,
    ],
  ])('gates Azure %s', async (_name, options, read, expected) => {
    currentProvider = 'azure';
    const client = await createClient({ apiKey: 'k', entityId: 'e' }, options);
    expect(read(client)).toBe(expected);
    await client.close();
  });

  it.each([
    ['without namespace', {}, false],
    ['with namespace', { namespace: 'ns' }, true],
  ])('gates OCI storage %s', async (_name, options, expected) => {
    currentProvider = 'oci';
    const client = await createClient({ apiKey: 'k', entityId: 'e' }, options);
    expect(client.hasStorage).toBe(expected);
    await client.close();
  });

  it('leaves OCI identity unset until the identity domain endpoint is given', async () => {
    currentProvider = 'oci';
    const without = await createClient({ apiKey: 'k', entityId: 'e' }, {});
    expect(without.hasIdentity).toBe(false);
    await without.close();

    const withEndpoint = await createClient({ apiKey: 'k', entityId: 'e' }, { identityDomainEndpoint: 'https://idcs' });
    expect(withEndpoint.hasIdentity).toBe(true);
    await withEndpoint.close();
  });

  it('never creates search for GCP, which has no wired search service', async () => {
    currentProvider = 'gcp';
    const client = await createClient({ apiKey: 'k', entityId: 'e' }, { searchEndpoint: 'https://s' });
    expect(client.hasSearch).toBe(false);
    await client.close();
  });

  it('creates cache whenever a redis endpoint is supplied, on any provider', async () => {
    for (const provider of ['aws', 'azure', 'gcp', 'oci'] as const) {
      currentProvider = provider;
      const client = await createClient({ apiKey: 'k', entityId: 'e' }, { redisEndpoint: 'h:6379' });
      expect(client.hasCache).toBe(true);
      await client.close();
    }
  });

  it('throws a helpful error when reading a service that was not created', async () => {
    currentProvider = 'azure';
    const client = await createClient({ apiKey: 'k', entityId: 'e' }, {});
    expect(() => client.storage).toThrow(/storage not initialized/);
    expect(() => client.secrets).toThrow(/secrets not initialized/);
    await client.close();
  });

  it('folds a config region into the provider options', async () => {
    const client = await createClient({ apiKey: 'k', entityId: 'e', region: 'ap-south-1' });
    const aws = await import('../src/provider/aws/index.js');
    expect(vi.mocked(aws.S3Storage)).toHaveBeenCalledWith(expect.anything(), 'ap-south-1');
    await client.close();
  });
});
