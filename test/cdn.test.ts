import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotFoundError, UnsupportedError } from '../src/errors.js';
import type { AwsCredentials, AzureCredentials, GcpCredentials } from '../src/credentials/index.js';

const awsSend = vi.fn();
vi.mock('@aws-sdk/client-cloudfront', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudfront')>();
  return {
    ...actual,
    CloudFrontClient: class {
      send = awsSend;
    },
  };
});

const azureCreate = vi.fn();
const azureGet = vi.fn();
const azureListByProfile = vi.fn();
const azureUpdate = vi.fn();
const azureDelete = vi.fn();
const azurePurgeContent = vi.fn();
vi.mock('@azure/arm-cdn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@azure/arm-cdn')>();
  return {
    ...actual,
    CdnManagementClient: class {
      afdEndpoints = {
        create: azureCreate,
        get: azureGet,
        listByProfile: azureListByProfile,
        update: azureUpdate,
        delete: azureDelete,
        purgeContent: azurePurgeContent,
      };
    },
  };
});
vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class {},
}));

const gcpInsert = vi.fn();
const gcpGet = vi.fn();
const gcpListAsync = vi.fn();
const gcpPatch = vi.fn();
const gcpDelete = vi.fn();
const gcpWait = vi.fn();
vi.mock('@google-cloud/compute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google-cloud/compute')>();
  return {
    ...actual,
    BackendBucketsClient: class {
      insert = gcpInsert;
      get = gcpGet;
      listAsync = gcpListAsync;
      patch = gcpPatch;
      delete = gcpDelete;
    },
    GlobalOperationsClient: class {
      wait = gcpWait;
    },
  };
});

const { CloudFrontCdn } = await import('../src/provider/aws/cdn.js');
const { FrontDoorCdn } = await import('../src/provider/azure/cdn.js');
const { CloudCdn } = await import('../src/provider/gcp/cdn.js');
const { OciCdn } = await import('../src/provider/oci/cdn.js');

const awsCreds: AwsCredentials = { accessKey: 'ak', secretAccessKey: 'sk', region: 'us-east-1' };
const azureCreds: AzureCredentials = {
  tenantId: 't',
  clientId: 'c',
  clientSecret: 's',
  subscriptionId: 'sub',
};
const gcpCreds: GcpCredentials = { projectId: 'p', serviceAccountJson: '{}' };

function poller<T>(result: T) {
  return { pollUntilDone: vi.fn().mockResolvedValue(result) };
}

describe('CloudFrontCdn (aws)', () => {
  beforeEach(() => awsSend.mockReset());

  it('createDistribution builds a distribution config and returns the mapped result', async () => {
    awsSend.mockResolvedValueOnce({
      Distribution: {
        Id: 'DIST1',
        DomainName: 'd1.cloudfront.net',
        Status: 'InProgress',
        DistributionConfig: { Enabled: true, Comment: 'hi', Origins: { Items: [{ DomainName: 'origin.example.com' }] } },
      },
    });
    const cdn = new CloudFrontCdn(awsCreds);
    const result = await cdn.createDistribution({ originDomain: 'origin.example.com', enabled: true, comment: 'hi' });

    expect(result).toEqual({
      id: 'DIST1',
      domainName: 'd1.cloudfront.net',
      originDomain: 'origin.example.com',
      status: 'InProgress',
      enabled: true,
      comment: 'hi',
    });
    const input = awsSend.mock.calls[0][0].input;
    expect(input.DistributionConfig.Origins.Items[0].DomainName).toBe('origin.example.com');
    expect(input.DistributionConfig.DefaultCacheBehavior.TargetOriginId).toBe('fc-default-origin');
    expect(input.DistributionConfig.Enabled).toBe(true);
  });

  it('updateDistribution reuses the existing CallerReference and sends the ETag as IfMatch', async () => {
    awsSend
      .mockResolvedValueOnce({ DistributionConfig: { CallerReference: 'existing-ref' }, ETag: 'etag-1' })
      .mockResolvedValueOnce({
        Distribution: { Id: 'DIST1', DomainName: 'd1.cloudfront.net', Status: 'Deployed', DistributionConfig: {} },
      });
    const cdn = new CloudFrontCdn(awsCreds);
    await cdn.updateDistribution('DIST1', { originDomain: 'o.example.com', enabled: false });

    const updateInput = awsSend.mock.calls[1][0].input;
    expect(updateInput.IfMatch).toBe('etag-1');
    expect(updateInput.DistributionConfig.CallerReference).toBe('existing-ref');
  });

  it('deleteDistribution fetches the config first for the ETag, then deletes', async () => {
    awsSend.mockResolvedValueOnce({ ETag: 'etag-2' }).mockResolvedValueOnce({});
    const cdn = new CloudFrontCdn(awsCreds);
    await cdn.deleteDistribution('DIST1');

    expect(awsSend.mock.calls[0][0].constructor.name).toBe('GetDistributionConfigCommand');
    expect(awsSend.mock.calls[1][0].constructor.name).toBe('DeleteDistributionCommand');
    expect(awsSend.mock.calls[1][0].input.IfMatch).toBe('etag-2');
  });

  it('enableDistribution/disableDistribution flip Enabled via get-config-then-update', async () => {
    awsSend.mockResolvedValueOnce({ DistributionConfig: { Enabled: false }, ETag: 'e' }).mockResolvedValueOnce({});
    const cdn = new CloudFrontCdn(awsCreds);
    await cdn.enableDistribution('DIST1');
    expect(awsSend.mock.calls[1][0].input.DistributionConfig.Enabled).toBe(true);

    awsSend.mockReset();
    awsSend.mockResolvedValueOnce({ DistributionConfig: { Enabled: true }, ETag: 'e' }).mockResolvedValueOnce({});
    await cdn.disableDistribution('DIST1');
    expect(awsSend.mock.calls[1][0].input.DistributionConfig.Enabled).toBe(false);
  });

  it('setEnabled throws NotFoundError when the distribution config is missing', async () => {
    awsSend.mockResolvedValueOnce({ ETag: 'e' });
    const cdn = new CloudFrontCdn(awsCreds);
    await expect(cdn.enableDistribution('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('createInvalidation throws NotFoundError when the SDK omits the invalidation', async () => {
    awsSend.mockResolvedValueOnce({});
    const cdn = new CloudFrontCdn(awsCreds);
    await expect(cdn.createInvalidation('DIST1', ['/*'])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getInvalidation throws NotFoundError when the SDK omits the invalidation', async () => {
    awsSend.mockResolvedValueOnce({});
    const cdn = new CloudFrontCdn(awsCreds);
    await expect(cdn.getInvalidation('DIST1', 'INV1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listDistributions and listInvalidations page through Marker/NextMarker', async () => {
    awsSend
      .mockResolvedValueOnce({
        DistributionList: { IsTruncated: true, NextMarker: 'm2', Items: [{ Id: 'D1', DomainName: 'd1', Status: 's', Enabled: true, Comment: '' }] },
      })
      .mockResolvedValueOnce({ DistributionList: { IsTruncated: false, Items: [{ Id: 'D2', DomainName: 'd2', Status: 's', Enabled: false, Comment: '' }] } });
    const cdn = new CloudFrontCdn(awsCreds);
    const dists = await cdn.listDistributions();
    expect(dists.map((d) => d.id)).toEqual(['D1', 'D2']);
    expect(awsSend.mock.calls[1][0].input.Marker).toBe('m2');
  });
});

describe('FrontDoorCdn (azure)', () => {
  beforeEach(() => {
    azureCreate.mockReset();
    azureGet.mockReset();
    azureListByProfile.mockReset();
    azureUpdate.mockReset();
    azureDelete.mockReset();
    azurePurgeContent.mockReset();
  });

  it('createDistribution creates an AFD endpoint tagged with the origin domain', async () => {
    azureCreate.mockReturnValue(
      poller({ name: 'fc-1', hostName: 'ep.azurefd.net', deploymentStatus: 'Succeeded', enabledState: 'Enabled', tags: { 'fc-origin-domain': 'origin.example.com' } }),
    );
    const cdn = new FrontDoorCdn(azureCreds, 'rg', 'profile');
    const result = await cdn.createDistribution({ originDomain: 'origin.example.com', enabled: true });

    expect(result).toEqual({
      id: 'fc-1',
      domainName: 'ep.azurefd.net',
      originDomain: 'origin.example.com',
      status: 'Succeeded',
      enabled: true,
      comment: '',
    });
    const [rg, profile, , endpoint] = azureCreate.mock.calls[0];
    expect(rg).toBe('rg');
    expect(profile).toBe('profile');
    expect(endpoint.tags['fc-origin-domain']).toBe('origin.example.com');
    expect(endpoint.enabledState).toBe('Enabled');
  });

  it('createInvalidation purges content and returns the distribution id as the reference', async () => {
    azurePurgeContent.mockReturnValue(poller(undefined));
    const cdn = new FrontDoorCdn(azureCreds, 'rg', 'profile');
    const id = await cdn.createInvalidation('fc-1', ['/*']);
    expect(id).toBe('fc-1');
    expect(azurePurgeContent.mock.calls[0]).toEqual(['rg', 'profile', 'fc-1', { contentPaths: ['/*'] }]);
  });

  it('getInvalidation and listInvalidations throw UnsupportedError', async () => {
    const cdn = new FrontDoorCdn(azureCreds, 'rg', 'profile');
    await expect(cdn.getInvalidation('fc-1', 'anything')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.listInvalidations('fc-1')).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('enableDistribution/disableDistribution toggle enabledState', async () => {
    azureUpdate.mockReturnValue(poller(undefined));
    const cdn = new FrontDoorCdn(azureCreds, 'rg', 'profile');
    await cdn.enableDistribution('fc-1');
    expect(azureUpdate.mock.calls[0][3]).toEqual({ enabledState: 'Enabled' });

    await cdn.disableDistribution('fc-1');
    expect(azureUpdate.mock.calls[1][3]).toEqual({ enabledState: 'Disabled' });
  });

  it('listDistributions iterates the profile pager', async () => {
    azureListByProfile.mockReturnValue(
      (async function* () {
        yield { name: 'a', hostName: 'a.azurefd.net', enabledState: 'Enabled' };
        yield { name: 'b', hostName: 'b.azurefd.net', enabledState: 'Disabled' };
      })(),
    );
    const cdn = new FrontDoorCdn(azureCreds, 'rg', 'profile');
    const dists = await cdn.listDistributions();
    expect(dists.map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('CloudCdn (gcp)', () => {
  beforeEach(() => {
    gcpInsert.mockReset();
    gcpGet.mockReset();
    gcpListAsync.mockReset();
    gcpPatch.mockReset();
    gcpDelete.mockReset();
    gcpWait.mockReset();
  });

  it('createDistribution inserts a CDN-enabled backend bucket named from the origin domain, then re-fetches it', async () => {
    gcpInsert.mockResolvedValue([undefined, { name: 'op-1', status: 'DONE' }]);
    gcpGet.mockResolvedValue([
      { name: 'cdn-abcdef012345', bucketName: 'origin.example.com', enableCdn: true, description: 'hi' },
    ]);
    const cdn = new CloudCdn(gcpCreds);
    const result = await cdn.createDistribution({ originDomain: 'origin.example.com', enabled: true, comment: 'hi' });

    expect(result).toEqual({
      id: 'cdn-abcdef012345',
      domainName: '',
      originDomain: 'origin.example.com',
      status: 'active',
      enabled: true,
      comment: 'hi',
    });
    const insertArgs = gcpInsert.mock.calls[0][0];
    expect(insertArgs.project).toBe('p');
    expect(insertArgs.backendBucketResource).toMatchObject({ bucketName: 'origin.example.com', enableCdn: true, description: 'hi' });
    expect(gcpGet.mock.calls[0][0]).toEqual({ project: 'p', backendBucket: insertArgs.backendBucketResource.name });
  });

  it('getDistribution throws NotFoundError when the backend bucket does not exist', async () => {
    gcpGet.mockRejectedValue(Object.assign(new Error('not found'), { code: 5 }));
    const cdn = new CloudCdn(gcpCreds);
    await expect(cdn.getDistribution('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updateDistribution/enableDistribution/disableDistribution patch EnableCdn and re-fetch', async () => {
    gcpPatch.mockResolvedValue([undefined, { name: 'op-2', status: 'DONE' }]);
    gcpGet.mockResolvedValue([{ name: 'cdn-1', bucketName: 'o', enableCdn: false, description: '' }]);
    const cdn = new CloudCdn(gcpCreds);

    await cdn.enableDistribution('cdn-1');
    expect(gcpPatch.mock.calls[0][0]).toEqual({
      project: 'p',
      backendBucket: 'cdn-1',
      backendBucketResource: { enableCdn: true },
    });

    await cdn.disableDistribution('cdn-1');
    expect(gcpPatch.mock.calls[1][0].backendBucketResource).toEqual({ enableCdn: false });

    await cdn.updateDistribution('cdn-1', { originDomain: 'o', enabled: true, comment: 'c' });
    expect(gcpPatch.mock.calls[2][0].backendBucketResource).toEqual({ enableCdn: true, description: 'c' });
  });

  it('deleteDistribution deletes the backend bucket and waits for the operation', async () => {
    gcpDelete.mockResolvedValue([undefined, { name: 'op-3', status: 'RUNNING' }]);
    gcpWait.mockResolvedValue([{ name: 'op-3', status: 'DONE' }]);
    const cdn = new CloudCdn(gcpCreds);
    await cdn.deleteDistribution('cdn-1');

    expect(gcpDelete.mock.calls[0][0]).toEqual({ project: 'p', backendBucket: 'cdn-1' });
    expect(gcpWait.mock.calls[0][0]).toEqual({ operation: 'op-3', project: 'p' });
  });

  it('listDistributions iterates the async list', async () => {
    gcpListAsync.mockReturnValue(
      (async function* () {
        yield { name: 'cdn-a', bucketName: 'a.example.com', enableCdn: true, description: '' };
        yield { name: 'cdn-b', bucketName: 'b.example.com', enableCdn: false, description: '' };
      })(),
    );
    const cdn = new CloudCdn(gcpCreds);
    const dists = await cdn.listDistributions();
    expect(dists.map((d) => d.id)).toEqual(['cdn-a', 'cdn-b']);
  });

  it('invalidation methods throw UnsupportedError', async () => {
    const cdn = new CloudCdn(gcpCreds);
    await expect(cdn.createInvalidation('id', ['/*'])).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.getInvalidation('id', 'inv')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.listInvalidations('id')).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('OciCdn', () => {
  it('every method throws UnsupportedError', async () => {
    const cdn = new OciCdn();
    await expect(cdn.createDistribution({ originDomain: 'o' })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.getDistribution('id')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.listDistributions()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.updateDistribution('id', { originDomain: 'o' })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.deleteDistribution('id')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.enableDistribution('id')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.disableDistribution('id')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.createInvalidation('id', ['/*'])).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.getInvalidation('id', 'inv')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cdn.listInvalidations('id')).rejects.toBeInstanceOf(UnsupportedError);
  });
});
