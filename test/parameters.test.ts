import { describe, expect, it, vi } from 'vitest';

import { NotFoundError } from '../src/errors.js';
import type { Parameters, ParametersOperation, Secrets } from '../src/provider/types/index.js';

const awsSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-ssm', () => {
  class FakeCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class ParameterNotFound extends Error {
    override name = 'ParameterNotFound';
  }
  return {
    SSMClient: vi.fn().mockImplementation(function () {
      return { send: awsSend };
    }),
    GetParameterCommand: class extends FakeCommand {},
    PutParameterCommand: class extends FakeCommand {},
    DeleteParameterCommand: class extends FakeCommand {},
    AddTagsToResourceCommand: class extends FakeCommand {},
    ParameterNotFound,
    ParameterType: { STRING: 'String', SECURE_STRING: 'SecureString' },
    ResourceTypeForTagging: { PARAMETER: 'Parameter' },
    paginateDescribeParameters: vi.fn().mockImplementation(async function* () {
      yield { Parameters: [] };
    }),
    paginateGetParameterHistory: vi.fn().mockImplementation(async function* () {
      yield { Parameters: [] };
    }),
  };
});

const azureCalls = vi.hoisted(() => ({
  getConfigurationSetting: vi.fn(),
  setConfigurationSetting: vi.fn(),
  deleteConfigurationSetting: vi.fn(),
  listConfigurationSettings: vi.fn(),
  listRevisions: vi.fn(),
}));
vi.mock('@azure/app-configuration', () => ({
  AppConfigurationClient: vi.fn().mockImplementation(function () {
    return azureCalls;
  }),
}));
vi.mock('@azure/identity', () => ({
  ClientSecretCredential: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

const gcpCalls = vi.hoisted(() => ({
  getParameter: vi.fn(),
  createParameter: vi.fn(),
  deleteParameter: vi.fn(),
  getParameterVersion: vi.fn(),
  createParameterVersion: vi.fn(),
  deleteParameterVersion: vi.fn(),
  listParametersAsync: vi.fn(),
  listParameterVersionsAsync: vi.fn(),
}));
vi.mock('@google-cloud/parametermanager', () => ({
  ParameterManagerClient: vi.fn().mockImplementation(function () {
    return gcpCalls;
  }),
  protos: {},
}));

const { ParameterStore } = await import('../src/provider/aws/parameters.js');
const { AppConfigurationParameters } = await import('../src/provider/azure/parameters.js');
const { ParameterManagerParameters } = await import('../src/provider/gcp/parameters.js');
const { VaultParameters } = await import('../src/provider/oci/parameters.js');

async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

const awsCreds = { accessKey: 'ak', secretAccessKey: 'sk', region: 'us-east-1' };
const azureCreds = { tenantId: 't', clientId: 'c', clientSecret: 's', subscriptionId: 'sub' };
const gcpCreds = { projectId: 'proj', serviceAccountJson: '{"client_email":"a@b.com","private_key":"k"}' };

describe('AWS ParameterStore', () => {
  it('get decrypts and returns the value', async () => {
    awsSend.mockResolvedValueOnce({ Parameter: { Value: 'v1' } });
    const store = new ParameterStore(awsCreds);
    await expect(store.get('/app/db')).resolves.toBe('v1');
    const cmd = awsSend.mock.calls[0][0];
    expect(cmd.input).toEqual({ Name: '/app/db', WithDecryption: true });
  });

  it('get throws NotFoundError when the SDK returns no value', async () => {
    awsSend.mockResolvedValueOnce({});
    const store = new ParameterStore(awsCreds);
    await expect(store.get('/missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('put writes a SecureString then tags in a follow-up call', async () => {
    awsSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const store = new ParameterStore(awsCreds);
    await store.put('/app/db', 'secret', { secure: true, description: 'desc', tags: { env: 'prod' } });

    expect(awsSend).toHaveBeenCalledTimes(2);
    const putCmd = awsSend.mock.calls[0][0];
    expect(putCmd.input).toEqual({
      Name: '/app/db',
      Value: 'secret',
      Overwrite: true,
      Type: 'SecureString',
      Description: 'desc',
    });
    const tagCmd = awsSend.mock.calls[1][0];
    expect(tagCmd.input).toEqual({
      ResourceId: '/app/db',
      ResourceType: 'Parameter',
      Tags: [{ Key: 'env', Value: 'prod' }],
    });
  });

  it('put skips the tagging call when no tags are given', async () => {
    awsSend.mockResolvedValueOnce({});
    const store = new ParameterStore(awsCreds);
    await store.put('/app/db', 'plain');
    expect(awsSend).toHaveBeenCalledTimes(1);
  });

  it('getVersion addresses "name:version"', async () => {
    awsSend.mockResolvedValueOnce({ Parameter: { Value: 'v2' } });
    const store = new ParameterStore(awsCreds);
    await expect(store.getVersion('/app/db', '3')).resolves.toBe('v2');
    expect(awsSend.mock.calls[0][0].input).toEqual({ Name: '/app/db:3', WithDecryption: true });
  });

  it.each([
    ['not found -> false', true, false],
    ['found -> true', false, true],
  ])('exists: %s', async (_label, throwsNotFound, expected) => {
    const store = new ParameterStore(awsCreds);
    if (throwsNotFound) {
      const { ParameterNotFound } = await import('@aws-sdk/client-ssm');
      awsSend.mockRejectedValueOnce(new ParameterNotFound({ message: 'nope', $metadata: {} }));
    } else {
      awsSend.mockResolvedValueOnce({ Parameter: { Value: 'v' } });
    }
    await expect(store.exists('/app/db')).resolves.toBe(expected);
  });

  it('exists rethrows non-not-found errors as ProviderError', async () => {
    awsSend.mockRejectedValueOnce(new Error('boom'));
    const store = new ParameterStore(awsCreds);
    await expect(store.exists('/app/db')).rejects.toThrow(/aws: GetParameter failed/);
  });
});

describe('Azure AppConfigurationParameters', () => {
  it('get returns the setting value', async () => {
    azureCalls.getConfigurationSetting.mockResolvedValueOnce({ value: 'v1' });
    const params = new AppConfigurationParameters(azureCreds, 'https://x.azconfig.io');
    await expect(params.get('AppKey')).resolves.toBe('v1');
    expect(azureCalls.getConfigurationSetting).toHaveBeenCalledWith({ key: 'AppKey' });
  });

  it('put ignores description and tags (azappconfig gap)', async () => {
    azureCalls.setConfigurationSetting.mockResolvedValueOnce({});
    const params = new AppConfigurationParameters(azureCreds, 'https://x.azconfig.io');
    await params.put('AppKey', 'v', { description: 'ignored', tags: { a: 'b' } });
    expect(azureCalls.setConfigurationSetting).toHaveBeenCalledWith({ key: 'AppKey', value: 'v' });
  });

  it('getVersion matches a revision by ETag', async () => {
    azureCalls.listRevisions.mockReturnValueOnce(
      asyncGen([
        { etag: 'e1', value: 'old' },
        { etag: 'e2', value: 'new' },
      ]),
    );
    const params = new AppConfigurationParameters(azureCreds, 'https://x.azconfig.io');
    await expect(params.getVersion('AppKey', 'e2')).resolves.toBe('new');
  });

  it('getVersion throws NotFoundError when no revision matches', async () => {
    azureCalls.listRevisions.mockReturnValueOnce(asyncGen([{ etag: 'e1', value: 'old' }]));
    const params = new AppConfigurationParameters(azureCreds, 'https://x.azconfig.io');
    await expect(params.getVersion('AppKey', 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ['resolves -> true', false, true],
    ['any error -> false', true, false],
  ])('exists: %s', async (_label, shouldThrow, expected) => {
    const params = new AppConfigurationParameters(azureCreds, 'https://x.azconfig.io');
    if (shouldThrow) azureCalls.getConfigurationSetting.mockRejectedValueOnce(new Error('network blip'));
    else azureCalls.getConfigurationSetting.mockResolvedValueOnce({ value: 'v' });
    await expect(params.exists('AppKey')).resolves.toBe(expected);
  });
});

describe('GCP ParameterManagerParameters', () => {
  it('get resolves the newest enabled version', async () => {
    gcpCalls.listParameterVersionsAsync.mockReturnValueOnce(
      asyncGen([
        { name: '.../versions/v1', disabled: false, createTime: { seconds: 100, nanos: 0 } },
        { name: '.../versions/v2', disabled: false, createTime: { seconds: 200, nanos: 0 } },
        { name: '.../versions/v3', disabled: true, createTime: { seconds: 300, nanos: 0 } },
      ]),
    );
    gcpCalls.getParameterVersion.mockResolvedValueOnce([{ payload: { data: Buffer.from('hello') } }]);
    const params = new ParameterManagerParameters(gcpCreds);
    await expect(params.get('db-host')).resolves.toBe('hello');
    expect(gcpCalls.getParameterVersion).toHaveBeenCalledWith({ name: '.../versions/v2' });
  });

  it('get throws NotFoundError when every version is disabled', async () => {
    gcpCalls.listParameterVersionsAsync.mockReturnValueOnce(
      asyncGen([{ name: '.../versions/v1', disabled: true, createTime: { seconds: 1, nanos: 0 } }]),
    );
    const params = new ParameterManagerParameters(gcpCreds);
    await expect(params.get('db-host')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete removes every version before the parameter', async () => {
    gcpCalls.listParameterVersionsAsync.mockReturnValueOnce(
      asyncGen([{ name: 'p/versions/v1' }, { name: 'p/versions/v2' }]),
    );
    gcpCalls.deleteParameterVersion.mockResolvedValue({});
    gcpCalls.deleteParameter.mockResolvedValueOnce({});
    const params = new ParameterManagerParameters(gcpCreds);
    await params.delete('db-host');
    expect(gcpCalls.deleteParameterVersion).toHaveBeenCalledTimes(2);
    expect(gcpCalls.deleteParameterVersion).toHaveBeenNthCalledWith(1, { name: 'p/versions/v1' });
    expect(gcpCalls.deleteParameter).toHaveBeenCalledTimes(1);
    const deleteOrder = gcpCalls.deleteParameterVersion.mock.invocationCallOrder[1];
    const parameterOrder = gcpCalls.deleteParameter.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(parameterOrder);
  });

  it.each([
    ['NotFound code -> false', { code: 5 }, false],
    ['found -> true', undefined, true],
  ])('exists: %s', async (_label, rejection, expected) => {
    const params = new ParameterManagerParameters(gcpCreds);
    if (rejection) gcpCalls.getParameter.mockRejectedValueOnce(rejection);
    else gcpCalls.getParameter.mockResolvedValueOnce([{ name: 'p' }]);
    await expect(params.exists('db-host')).resolves.toBe(expected);
  });
});

describe('OCI VaultParameters', () => {
  function fakeVault(overrides: Partial<Secrets> = {}): Secrets {
    return {
      get: vi.fn().mockResolvedValue('v1'),
      getWithMetadata: vi.fn().mockResolvedValue({
        name: 'n',
        value: 'v1',
        version: '1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        description: 'd',
        tags: { a: 'b' },
      }),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      exists: vi.fn().mockResolvedValue(true),
      getVersion: vi.fn().mockResolvedValue('v1'),
      listVersions: vi.fn().mockResolvedValue([]),
      putBinary: vi.fn(),
      getBinary: vi.fn(),
      restore: vi.fn(),
      rotateSecret: vi.fn(),
      supports: vi.fn().mockReturnValue(true),
      provider: vi.fn().mockReturnValue('oci'),
      ...overrides,
    };
  }

  it('get/getVersion/exists/delete delegate to the vault', async () => {
    const vault = fakeVault();
    const params = new VaultParameters(vault);
    await expect(params.get('n')).resolves.toBe('v1');
    await expect(params.getVersion('n', '1')).resolves.toBe('v1');
    await expect(params.exists('n')).resolves.toBe(true);
    await params.delete('n');
    expect(vault.delete).toHaveBeenCalledWith('n');
  });

  it('getWithMetadata converts a Secret into a Parameter', async () => {
    const vault = fakeVault();
    const params = new VaultParameters(vault);
    await expect(params.getWithMetadata('n')).resolves.toEqual({
      name: 'n',
      value: 'v1',
      version: '1',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      description: 'd',
      tags: { a: 'b' },
    });
  });

  it('put forwards description and tags, dropping secure', async () => {
    const vault = fakeVault();
    const params = new VaultParameters(vault);
    await params.put('n', 'v', { description: 'd', tags: { a: 'b' }, secure: true });
    expect(vault.put).toHaveBeenCalledWith('n', 'v', { description: 'd', tags: { a: 'b' } });
  });

  const supportsCases: [ParametersOperation, string][] = [
    ['get', 'get'],
    ['get_metadata', 'get'],
    ['exists', 'get'],
    ['get_version', 'get_version'],
    ['put', 'put'],
    ['delete', 'delete'],
    ['list', 'list'],
    ['list_versions', 'list_versions'],
  ];

  it.each(supportsCases)('supports(%s) delegates to vault.supports(%s)', async (op, vaultOp) => {
    const vault = fakeVault({ supports: vi.fn().mockReturnValue(true) });
    const params = new VaultParameters(vault);
    expect(params.supports(op)).toBe(true);
    expect(vault.supports).toHaveBeenCalledWith(vaultOp);
  });
});

describe('provider() identity', () => {
  it.each([
    ['aws', () => new ParameterStore(awsCreds)],
    ['azure', () => new AppConfigurationParameters(azureCreds, 'https://x.azconfig.io')],
    ['gcp', () => new ParameterManagerParameters(gcpCreds)],
  ])('%s provider() and supports() agree with the implementation', (name, build) => {
    const params = build() as unknown as Parameters;
    expect(params.provider()).toBe(name);
    const ops: ParametersOperation[] = [
      'get',
      'get_metadata',
      'get_version',
      'put',
      'delete',
      'list',
      'list_versions',
      'exists',
    ];
    for (const op of ops) expect(params.supports(op)).toBe(true);
  });
});
