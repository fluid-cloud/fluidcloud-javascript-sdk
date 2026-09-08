import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AwsCredentials, AzureCredentials, GcpCredentials, OciCredentials } from '../src/credentials/index.js';
import { NotFoundError, UnsupportedError } from '../src/errors.js';
import type { SecretsOperation } from '../src/provider/types/secrets.js';

const awsSendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-secrets-manager', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-secrets-manager')>(
    '@aws-sdk/client-secrets-manager',
  );
  return {
    ...actual,
    SecretsManagerClient: vi.fn().mockImplementation(function SecretsManagerClient() {
      return { send: awsSendMock };
    }),
  };
});

const azureMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  beginDeleteSecret: vi.fn(),
  beginRecoverDeletedSecret: vi.fn(),
  listPropertiesOfSecrets: vi.fn(),
  listPropertiesOfSecretVersions: vi.fn(),
}));

vi.mock('@azure/keyvault-secrets', () => ({
  SecretClient: vi.fn().mockImplementation(function SecretClient() {
    return azureMocks;
  }),
}));

const gcpMocks = vi.hoisted(() => ({
  accessSecretVersion: vi.fn(),
  getSecret: vi.fn(),
  createSecret: vi.fn(),
  addSecretVersion: vi.fn(),
  deleteSecret: vi.fn(),
  listSecretsAsync: vi.fn(),
  listSecretVersionsAsync: vi.fn(),
}));

vi.mock('@google-cloud/secret-manager', async () => {
  const actual = await vi.importActual<typeof import('@google-cloud/secret-manager')>('@google-cloud/secret-manager');
  return {
    ...actual,
    SecretManagerServiceClient: vi.fn().mockImplementation(function SecretManagerServiceClient() {
      return gcpMocks;
    }),
  };
});

const ociMocks = vi.hoisted(() => ({
  secrets: {
    getSecretBundleByName: vi.fn(),
    getSecretBundle: vi.fn(),
    listSecretBundleVersions: vi.fn(),
  },
  vault: {
    listSecrets: vi.fn(),
    getSecret: vi.fn(),
    createSecret: vi.fn(),
    updateSecret: vi.fn(),
    scheduleSecretDeletion: vi.fn(),
    cancelSecretDeletion: vi.fn(),
  },
}));

vi.mock('oci-secrets', async () => {
  const actual = await vi.importActual<typeof import('oci-secrets')>('oci-secrets');
  return {
    ...actual,
    SecretsClient: vi.fn().mockImplementation(function SecretsClient() {
      return ociMocks.secrets;
    }),
  };
});

vi.mock('oci-vault', async () => {
  const actual = await vi.importActual<typeof import('oci-vault')>('oci-vault');
  return {
    ...actual,
    VaultsClient: vi.fn().mockImplementation(function VaultsClient() {
      return ociMocks.vault;
    }),
  };
});

const { SecretsManager } = await import('../src/provider/aws/secrets.js');
const { KeyVaultSecrets } = await import('../src/provider/azure/secrets.js');
const { SecretManagerSecrets } = await import('../src/provider/gcp/secrets.js');
const { VaultSecrets } = await import('../src/provider/oci/secrets.js');
const awsCommands = await import('@aws-sdk/client-secrets-manager');

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) yield item;
    },
  };
}

const awsCreds: AwsCredentials = { accessKey: 'AKIA', secretAccessKey: 'shh', region: 'us-east-1' };
const azureCreds: AzureCredentials = {
  tenantId: 't',
  clientId: 'c',
  clientSecret: 's',
  subscriptionId: 'sub',
};
const gcpCreds: GcpCredentials = {
  projectId: 'proj',
  serviceAccountJson: JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: 'k' }),
};
const ociCreds: OciCredentials = {
  tenancyOcid: 'ocid1.tenancy.oc1..a',
  userOcid: 'ocid1.user.oc1..a',
  fingerprint: 'aa:bb:cc',
  privateKey: 'fake-key',
  region: 'us-ashburn-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('aws SecretsManager', () => {
  it('get returns the secret string', async () => {
    awsSendMock.mockResolvedValueOnce({ SecretString: 'hello' });
    const sm = new SecretsManager(awsCreds);
    await expect(sm.get('foo')).resolves.toBe('hello');
    const cmd = awsSendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(awsCommands.GetSecretValueCommand);
    expect(cmd.input).toEqual({ SecretId: 'foo' });
  });

  it('put creates a new secret when DescribeSecret fails', async () => {
    awsSendMock.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce({});
    const sm = new SecretsManager(awsCreds);
    await sm.put('foo', 'bar', { description: 'd', tags: { env: 'prod' } });
    const createCall = awsSendMock.mock.calls[1][0];
    expect(createCall).toBeInstanceOf(awsCommands.CreateSecretCommand);
    expect(createCall.input).toMatchObject({
      Name: 'foo',
      SecretString: 'bar',
      Description: 'd',
      Tags: [{ Key: 'env', Value: 'prod' }],
    });
  });

  it('put updates an existing secret when DescribeSecret succeeds', async () => {
    awsSendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const sm = new SecretsManager(awsCreds);
    await sm.put('foo', 'bar');
    const putCall = awsSendMock.mock.calls[1][0];
    expect(putCall).toBeInstanceOf(awsCommands.PutSecretValueCommand);
    expect(putCall.input).toEqual({ SecretId: 'foo', SecretString: 'bar' });
  });

  it('delete forces deletion without recovery', async () => {
    awsSendMock.mockResolvedValueOnce({});
    const sm = new SecretsManager(awsCreds);
    await sm.delete('foo');
    const cmd = awsSendMock.mock.calls[0][0];
    expect(cmd.input).toEqual({ SecretId: 'foo', ForceDeleteWithoutRecovery: true });
  });

  it.each([
    [true, 'DescribeSecret resolves'],
    [false, 'DescribeSecret rejects'],
  ])('exists returns %s when %s', async (expected) => {
    if (expected) awsSendMock.mockResolvedValueOnce({});
    else awsSendMock.mockRejectedValueOnce(new Error('boom'));
    const sm = new SecretsManager(awsCreds);
    await expect(sm.exists('foo')).resolves.toBe(expected);
  });

  it('listVersions maps stages to current/previous/deprecated', async () => {
    awsSendMock.mockResolvedValueOnce({
      Versions: [
        { VersionId: 'v1', VersionStages: ['AWSCURRENT'], CreatedDate: new Date('2024-01-01') },
        { VersionId: 'v2', VersionStages: ['AWSPREVIOUS'] },
        { VersionId: 'v3', VersionStages: [] },
      ],
    });
    const sm = new SecretsManager(awsCreds);
    const versions = await sm.listVersions('foo');
    expect(versions.map((v) => v.status)).toEqual(['current', 'previous', 'deprecated']);
  });

  it('putBinary/getBinary round-trip through SecretBinary', async () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    awsSendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const sm = new SecretsManager(awsCreds);
    await sm.putBinary('foo', bytes);
    const putCall = awsSendMock.mock.calls[1][0];
    expect(putCall.input.SecretBinary).toEqual(bytes);

    awsSendMock.mockResolvedValueOnce({ SecretBinary: bytes });
    await expect(sm.getBinary('foo')).resolves.toEqual(bytes);
  });

  it('rotateSecret gets then puts the same value', async () => {
    awsSendMock.mockResolvedValueOnce({ SecretString: 'v' }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const sm = new SecretsManager(awsCreds);
    await sm.rotateSecret('foo');
    expect(awsSendMock).toHaveBeenCalledTimes(3);
  });

  it('wraps SDK failures as ProviderError', async () => {
    awsSendMock.mockRejectedValueOnce(new Error('AWS down'));
    const sm = new SecretsManager(awsCreds);
    await expect(sm.get('foo')).rejects.toMatchObject({ code: 'PROVIDER', provider: 'aws' });
  });

  it('supports every operation and reports its provider name', () => {
    const sm = new SecretsManager(awsCreds);
    const ops: SecretsOperation[] = ['get', 'put', 'delete', 'list', 'restore', 'rotate'];
    for (const op of ops) expect(sm.supports(op)).toBe(true);
    expect(sm.provider()).toBe('aws');
  });
});

describe('azure KeyVaultSecrets', () => {
  it('get returns the secret value', async () => {
    azureMocks.getSecret.mockResolvedValueOnce({ value: 'hello', properties: {} });
    const kv = new KeyVaultSecrets(azureCreds, 'my-vault');
    await expect(kv.get('foo')).resolves.toBe('hello');
    expect(azureMocks.getSecret).toHaveBeenCalledWith('foo');
  });

  it('put forwards tags to setSecret', async () => {
    azureMocks.setSecret.mockResolvedValueOnce({});
    const kv = new KeyVaultSecrets(azureCreds, 'my-vault');
    await kv.put('foo', 'bar', { tags: { env: 'prod' } });
    expect(azureMocks.setSecret).toHaveBeenCalledWith('foo', 'bar', { tags: { env: 'prod' } });
  });

  it('delete polls the delete operation to completion', async () => {
    const pollUntilDone = vi.fn().mockResolvedValue({});
    azureMocks.beginDeleteSecret.mockResolvedValueOnce({ pollUntilDone });
    const kv = new KeyVaultSecrets(azureCreds, 'my-vault');
    await kv.delete('foo');
    expect(pollUntilDone).toHaveBeenCalled();
  });

  it('exists returns true when getSecret resolves', async () => {
    azureMocks.getSecret.mockResolvedValueOnce({ value: 'x', properties: {} });
    const kv = new KeyVaultSecrets(azureCreds, 'my-vault');
    await expect(kv.exists('foo')).resolves.toBe(true);
  });

  it('exists returns false, never throws, when getSecret rejects', async () => {
    azureMocks.getSecret.mockRejectedValueOnce(new Error('not found'));
    const kv = new KeyVaultSecrets(azureCreds, 'my-vault');
    await expect(kv.exists('foo')).resolves.toBe(false);
  });

  it('putBinary/getBinary round-trip through base64', async () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    azureMocks.setSecret.mockResolvedValueOnce({});
    const kv = new KeyVaultSecrets(azureCreds, 'my-vault');
    await kv.putBinary('foo', bytes);
    expect(azureMocks.setSecret).toHaveBeenCalledWith('foo', bytes.toString('base64'), { tags: undefined });

    azureMocks.getSecret.mockResolvedValueOnce({ value: bytes.toString('base64'), properties: {} });
    await expect(kv.getBinary('foo')).resolves.toEqual(bytes);
  });

  it('restore polls the recover operation to completion', async () => {
    const pollUntilDone = vi.fn().mockResolvedValue({});
    azureMocks.beginRecoverDeletedSecret.mockResolvedValueOnce({ pollUntilDone });
    const kv = new KeyVaultSecrets(azureCreds, 'my-vault');
    await kv.restore('foo');
    expect(pollUntilDone).toHaveBeenCalled();
  });

  it('supports every operation and reports its provider name', () => {
    const kv = new KeyVaultSecrets(azureCreds, 'my-vault');
    expect(kv.supports('restore')).toBe(true);
    expect(kv.supports('rotate')).toBe(true);
    expect(kv.provider()).toBe('azure');
  });
});

describe('gcp SecretManagerSecrets', () => {
  it('get accesses the latest version', async () => {
    gcpMocks.accessSecretVersion.mockResolvedValueOnce([{ payload: { data: Buffer.from('hello') } }]);
    const sm = new SecretManagerSecrets(gcpCreds);
    await expect(sm.get('foo')).resolves.toBe('hello');
    expect(gcpMocks.accessSecretVersion).toHaveBeenCalledWith({
      name: 'projects/proj/secrets/foo/versions/latest',
    });
  });

  it('put creates the secret then adds a version, tolerating AlreadyExists', async () => {
    gcpMocks.createSecret.mockRejectedValueOnce({ code: 6 });
    gcpMocks.addSecretVersion.mockResolvedValueOnce([{}]);
    const sm = new SecretManagerSecrets(gcpCreds);
    await sm.put('foo', 'bar', { tags: { env: 'prod' } });
    expect(gcpMocks.createSecret).toHaveBeenCalledWith({
      parent: 'projects/proj',
      secretId: 'foo',
      secret: { replication: { automatic: {} }, labels: { env: 'prod' } },
    });
    expect(gcpMocks.addSecretVersion).toHaveBeenCalledWith({
      parent: 'projects/proj/secrets/foo',
      payload: { data: Buffer.from('bar', 'utf-8') },
    });
  });

  it('putBinary/getBinary round-trip raw bytes', async () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    gcpMocks.createSecret.mockResolvedValueOnce([{}]);
    gcpMocks.addSecretVersion.mockResolvedValueOnce([{}]);
    const sm = new SecretManagerSecrets(gcpCreds);
    await sm.putBinary('foo', bytes);
    expect(gcpMocks.addSecretVersion).toHaveBeenCalledWith({
      parent: 'projects/proj/secrets/foo',
      payload: { data: bytes },
    });

    gcpMocks.accessSecretVersion.mockResolvedValueOnce([{ payload: { data: bytes } }]);
    await expect(sm.getBinary('foo')).resolves.toEqual(bytes);
  });

  it('exists returns true when getSecret resolves', async () => {
    gcpMocks.getSecret.mockResolvedValueOnce([{}]);
    const sm = new SecretManagerSecrets(gcpCreds);
    await expect(sm.exists('foo')).resolves.toBe(true);
  });

  it('exists returns false, never throws, when getSecret rejects', async () => {
    gcpMocks.getSecret.mockRejectedValueOnce(new Error('not found'));
    const sm = new SecretManagerSecrets(gcpCreds);
    await expect(sm.exists('foo')).resolves.toBe(false);
  });

  it('list maps secrets, and listVersions maps version state', async () => {
    gcpMocks.listSecretsAsync.mockReturnValueOnce(
      asyncIterable([{ name: 'projects/proj/secrets/foo', labels: { env: 'prod' } }]),
    );
    const sm = new SecretManagerSecrets(gcpCreds);
    await expect(sm.list()).resolves.toEqual([
      {
        name: 'foo',
        version: '',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        description: '',
        tags: { env: 'prod' },
      },
    ]);

    gcpMocks.listSecretVersionsAsync.mockReturnValueOnce(
      asyncIterable([{ name: 'projects/proj/secrets/foo/versions/1', state: 'ENABLED' }]),
    );
    const versions = await sm.listVersions('foo');
    expect(versions).toEqual([{ version: '1', status: 'ENABLED', createdAt: new Date(0) }]);
  });

  it('restore and rotateSecret throw UnsupportedError', async () => {
    const sm = new SecretManagerSecrets(gcpCreds);
    await expect(sm.restore('foo')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(sm.rotateSecret('foo')).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('supports() disagrees only on restore/rotate', () => {
    const sm = new SecretManagerSecrets(gcpCreds);
    expect(sm.supports('restore')).toBe(false);
    expect(sm.supports('rotate')).toBe(false);
    expect(sm.supports('get')).toBe(true);
    expect(sm.supports('put')).toBe(true);
    expect(sm.provider()).toBe('gcp');
  });
});

describe('oci VaultSecrets', () => {
  it('get reads the secret bundle by name directly, no OCID lookup', async () => {
    ociMocks.secrets.getSecretBundleByName.mockResolvedValueOnce({
      secretBundle: { secretBundleContent: { content: Buffer.from('hello').toString('base64') } },
    });
    const v = new VaultSecrets(ociCreds, 'ocid1.vault.oc1..v', 'ocid1.compartment.oc1..c');
    await expect(v.get('foo')).resolves.toBe('hello');
    expect(ociMocks.secrets.getSecretBundleByName).toHaveBeenCalledWith({
      secretName: 'foo',
      vaultId: 'ocid1.vault.oc1..v',
    });
    expect(ociMocks.vault.listSecrets).not.toHaveBeenCalled();
  });

  it('get throws NotFoundError when the vault has no such secret', async () => {
    ociMocks.secrets.getSecretBundleByName.mockRejectedValueOnce({ statusCode: 404 });
    const v = new VaultSecrets(ociCreds, 'v', 'c');
    await expect(v.get('missing')).rejects.toBeInstanceOf(Error);
  });

  it('delete not found propagates as NotFoundError, and exists() never throws', async () => {
    ociMocks.vault.listSecrets.mockResolvedValueOnce({ items: [] });
    const v = new VaultSecrets(ociCreds, 'v', 'c');
    await expect(v.delete('missing')).rejects.toBeInstanceOf(NotFoundError);

    ociMocks.vault.listSecrets.mockRejectedValueOnce(new Error('down'));
    await expect(v.exists('missing')).resolves.toBe(false);
  });

  it('put creates a new secret with the key OCID when none exists, and waits for ACTIVE', async () => {
    ociMocks.vault.listSecrets.mockResolvedValueOnce({ items: [] });
    ociMocks.vault.createSecret.mockResolvedValueOnce({ secret: { id: 'ocid1.secret.oc1..new' } });
    ociMocks.vault.getSecret.mockResolvedValueOnce({ secret: { lifecycleState: 'ACTIVE' } });
    const v = new VaultSecrets(ociCreds, 'v', 'c', 'ocid1.key.oc1..k');
    await v.put('foo', 'bar', { description: 'd' });
    expect(ociMocks.vault.createSecret).toHaveBeenCalledWith({
      createSecretDetails: {
        compartmentId: 'c',
        secretName: 'foo',
        vaultId: 'v',
        secretContent: { contentType: 'BASE64', content: Buffer.from('bar').toString('base64') },
        keyId: 'ocid1.key.oc1..k',
        description: 'd',
      },
    });
  });

  it('put without a key OCID throws a clear error when creating', async () => {
    ociMocks.vault.listSecrets.mockResolvedValueOnce({ items: [] });
    const v = new VaultSecrets(ociCreds, 'v', 'c');
    await expect(v.put('foo', 'bar')).rejects.toThrow(/keyOcid/);
    expect(ociMocks.vault.createSecret).not.toHaveBeenCalled();
  });

  it('put updates an existing secret without requiring a key OCID', async () => {
    ociMocks.vault.listSecrets.mockResolvedValueOnce({ items: [{ id: 'ocid1.secret.oc1..existing' }] });
    ociMocks.vault.updateSecret.mockResolvedValueOnce({});
    ociMocks.vault.getSecret.mockResolvedValueOnce({ secret: { lifecycleState: 'ACTIVE' } });
    const v = new VaultSecrets(ociCreds, 'v', 'c');
    await v.put('foo', 'bar');
    expect(ociMocks.vault.updateSecret).toHaveBeenCalledWith({
      secretId: 'ocid1.secret.oc1..existing',
      updateSecretDetails: { secretContent: { contentType: 'BASE64', content: Buffer.from('bar').toString('base64') } },
    });
  });

  it('putBinary/getBinary round-trip arbitrary bytes through base64', async () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    ociMocks.vault.listSecrets.mockResolvedValueOnce({ items: [{ id: 'ocid1.secret.oc1..existing' }] });
    ociMocks.vault.updateSecret.mockResolvedValueOnce({});
    ociMocks.vault.getSecret.mockResolvedValueOnce({ secret: { lifecycleState: 'ACTIVE' } });
    const v = new VaultSecrets(ociCreds, 'v', 'c');
    await v.putBinary('foo', bytes);
    expect(ociMocks.vault.updateSecret).toHaveBeenCalledWith({
      secretId: 'ocid1.secret.oc1..existing',
      updateSecretDetails: { secretContent: { contentType: 'BASE64', content: bytes.toString('base64') } },
    });

    ociMocks.secrets.getSecretBundleByName.mockResolvedValueOnce({
      secretBundle: { secretBundleContent: { content: bytes.toString('base64') } },
    });
    await expect(v.getBinary('foo')).resolves.toEqual(bytes);
  });

  it('delete schedules deletion and waits for PENDING_DELETION', async () => {
    ociMocks.vault.listSecrets.mockResolvedValueOnce({ items: [{ id: 'ocid1.secret.oc1..existing' }] });
    ociMocks.vault.scheduleSecretDeletion.mockResolvedValueOnce({});
    ociMocks.vault.getSecret.mockResolvedValueOnce({ secret: { lifecycleState: 'PENDING_DELETION' } });
    const v = new VaultSecrets(ociCreds, 'v', 'c');
    await v.delete('foo');
    expect(ociMocks.vault.scheduleSecretDeletion).toHaveBeenCalledWith({
      secretId: 'ocid1.secret.oc1..existing',
      scheduleSecretDeletionDetails: {},
    });
  });

  it('restore cancels a scheduled deletion', async () => {
    ociMocks.vault.listSecrets.mockResolvedValueOnce({ items: [{ id: 'ocid1.secret.oc1..existing' }] });
    ociMocks.vault.cancelSecretDeletion.mockResolvedValueOnce({});
    const v = new VaultSecrets(ociCreds, 'v', 'c');
    await v.restore('foo');
    expect(ociMocks.vault.cancelSecretDeletion).toHaveBeenCalledWith({ secretId: 'ocid1.secret.oc1..existing' });
  });

  it('listVersions maps stages to current/previous/deprecated', async () => {
    ociMocks.vault.listSecrets.mockResolvedValueOnce({ items: [{ id: 'ocid1.secret.oc1..existing' }] });
    ociMocks.secrets.listSecretBundleVersions.mockResolvedValueOnce({
      items: [
        { versionNumber: 1, stages: ['CURRENT'] },
        { versionNumber: 2, stages: ['PREVIOUS'] },
        { versionNumber: 3, stages: [] },
      ],
    });
    const v = new VaultSecrets(ociCreds, 'v', 'c');
    const versions = await v.listVersions('foo');
    expect(versions.map((x) => x.status)).toEqual(['current', 'previous', 'unknown']);
  });

  it('supports every operation and reports its provider name', () => {
    const v = new VaultSecrets(ociCreds, 'v', 'c');
    expect(v.supports('restore')).toBe(true);
    expect(v.supports('rotate')).toBe(true);
    expect(v.provider()).toBe('oci');
  });
});
