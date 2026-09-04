import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnsupportedError } from '../src/errors.js';
import type { AwsCredentials, AzureCredentials, GcpCredentials, OciCredentials } from '../src/credentials/index.js';
import type { StorageOperation } from '../src/provider/types/storage.js';

const awsSend = vi.fn();
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return { ...actual, S3Client: vi.fn().mockImplementation(function () { return { send: awsSend }; }) };
});
const awsGetSignedUrl = vi.fn().mockResolvedValue('https://signed.example/aws');
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: awsGetSignedUrl }));

const azureBlobClient = {
  download: vi.fn(),
  getProperties: vi.fn(),
  setMetadata: vi.fn(),
  getTags: vi.fn(),
  setTags: vi.fn(),
  beginCopyFromURL: vi.fn(),
};
const azureBlockBlobClient = {
  uploadData: vi.fn(),
  stageBlock: vi.fn(),
  commitBlockList: vi.fn(),
  uploadStream: vi.fn(),
};
const azureContainerClient = {
  getBlobClient: vi.fn(() => azureBlobClient),
  getBlockBlobClient: vi.fn(() => azureBlockBlobClient),
  deleteBlob: vi.fn(),
  listBlobsFlat: vi.fn(),
};
const azureServiceClient = {
  getContainerClient: vi.fn(() => azureContainerClient),
  createContainer: vi.fn(),
  deleteContainer: vi.fn(),
  listContainers: vi.fn(),
  getUserDelegationKey: vi.fn(),
};
vi.mock('@azure/storage-blob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@azure/storage-blob')>();
  return {
    ...actual,
    BlobServiceClient: vi.fn().mockImplementation(function () { return azureServiceClient; }),
    StorageSharedKeyCredential: vi.fn().mockImplementation(function (account: string, key: string) { return { account, key }; }),
    generateBlobSASQueryParameters: vi.fn().mockReturnValue({ toString: () => 'sig=abc' }),
  };
});

const gcpFile = {
  createReadStream: vi.fn(),
  save: vi.fn(),
  createWriteStream: vi.fn(),
  delete: vi.fn(),
  getMetadata: vi.fn(),
  exists: vi.fn(),
  download: vi.fn(),
  copy: vi.fn(),
  setMetadata: vi.fn(),
  getSignedUrl: vi.fn(),
  name: 'key.txt',
};
const gcpBucket = {
  file: vi.fn(() => gcpFile),
  getFiles: vi.fn(),
  exists: vi.fn(),
  delete: vi.fn(),
};
const gcpClient = {
  bucket: vi.fn(() => gcpBucket),
  createBucket: vi.fn(),
  getBuckets: vi.fn(),
};
vi.mock('@google-cloud/storage', () => ({ Storage: vi.fn().mockImplementation(function () { return gcpClient; }) }));

const ociClient: Record<string, ReturnType<typeof vi.fn>> & { regionId?: string; endpoint?: string } = {
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  listObjects: vi.fn(),
  headObject: vi.fn(),
  copyObject: vi.fn(),
  renameObject: vi.fn(),
  createMultipartUpload: vi.fn(),
  uploadPart: vi.fn(),
  commitMultipartUpload: vi.fn(),
  abortMultipartUpload: vi.fn(),
  createPreauthenticatedRequest: vi.fn(),
  createBucket: vi.fn(),
  deleteBucket: vi.fn(),
  headBucket: vi.fn(),
  listBuckets: vi.fn(),
  getWorkRequest: vi.fn(),
};
vi.mock('oci-objectstorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('oci-objectstorage')>();
  return { ...actual, ObjectStorageClient: vi.fn().mockImplementation(function () { return ociClient; }) };
});
vi.mock('oci-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('oci-common')>();
  return { ...actual, SimpleAuthenticationDetailsProvider: vi.fn().mockImplementation(function () { return {}; }) };
});

const { S3Storage } = await import('../src/provider/aws/storage.js');
const { BlobStorage } = await import('../src/provider/azure/storage.js');
const { GcsStorage } = await import('../src/provider/gcp/storage.js');
const { ObjectStorage } = await import('../src/provider/oci/storage.js');
const s3 = await import('@aws-sdk/client-s3');

function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) yield item;
    },
  };
}

function makeBlobsFlatResult(items: unknown[]) {
  return {
    ...makeAsyncIterable(items),
    byPage: () => makeAsyncIterable([{ segment: { blobItems: items } }]),
  };
}

const awsCreds: AwsCredentials = { accessKey: 'ak', secretAccessKey: 'sk', region: 'us-east-1' };
const azureCreds: AzureCredentials = {
  tenantId: 't',
  clientId: 'c',
  clientSecret: 's',
  subscriptionId: 'sub',
  storageAccountName: 'acct',
  storageAccountKey: 'a2V5',
};
const gcpCreds: GcpCredentials = {
  projectId: 'proj',
  serviceAccountJson: JSON.stringify({ client_email: 'x@y.z', private_key: 'pk' }),
};
const ociCreds: OciCredentials = {
  tenancyOcid: 'ocid1.tenancy.oc1..a',
  userOcid: 'ocid1.user.oc1..a',
  fingerprint: 'fp',
  privateKey: 'pk',
  region: 'us-phoenix-1',
};

describe('S3Storage (AWS)', () => {
  let storage: InstanceType<typeof S3Storage>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new S3Storage(awsCreds);
  });

  it('put() sends a PutObjectCommand with body, content type and metadata', async () => {
    awsSend.mockResolvedValueOnce({});
    await storage.put('bucket', 'key.txt', Buffer.from('hi'), { contentType: 'text/plain', metadata: { a: 'b' } });

    expect(awsSend).toHaveBeenCalledTimes(1);
    const command = awsSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(s3.PutObjectCommand);
    expect(command.input).toMatchObject({ Bucket: 'bucket', Key: 'key.txt', ContentType: 'text/plain', Metadata: { a: 'b' } });
  });

  it('list() sends a ListObjectsV2Command with prefix and maxKeys', async () => {
    awsSend.mockResolvedValueOnce({ Contents: [{ Key: 'a', Size: 1, ETag: 'e', LastModified: new Date(0) }] });
    const objects = await storage.list('bucket', { prefix: 'p/', maxKeys: 5 });

    const command = awsSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(s3.ListObjectsV2Command);
    expect(command.input).toMatchObject({ Bucket: 'bucket', Prefix: 'p/', MaxKeys: 5 });
    expect(objects).toEqual([{ key: 'a', size: 1, lastModified: new Date(0), etag: 'e', contentType: '' }]);
  });

  it('deleteBulk() sends one DeleteObjectsCommand and returns per-key failures', async () => {
    awsSend.mockResolvedValueOnce({ Errors: [{ Key: 'bad', Code: 'AccessDenied', Message: 'nope' }] });
    const failures = await storage.deleteBulk('bucket', ['ok', 'bad']);

    const command = awsSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(s3.DeleteObjectsCommand);
    expect(command.input.Delete.Objects).toEqual([{ Key: 'ok' }, { Key: 'bad' }]);
    expect(failures).toEqual([{ key: 'bad', code: 'AccessDenied', message: 'nope' }]);
  });

  it('copy() sends a CopyObjectCommand with a combined CopySource', async () => {
    awsSend.mockResolvedValueOnce({});
    await storage.copy('src-bucket', 'src-key', 'dst-bucket', 'dst-key');

    const command = awsSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(s3.CopyObjectCommand);
    expect(command.input).toMatchObject({ Bucket: 'dst-bucket', Key: 'dst-key', CopySource: 'src-bucket/src-key' });
  });

  it('multipartUploadPart() sends an UploadPartCommand and returns the ETag', async () => {
    awsSend.mockResolvedValueOnce({ ETag: 'etag-1' });
    const etag = await storage.multipartUploadPart('bucket', 'key', 'upload-1', 1, Buffer.from('part'));

    const command = awsSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(s3.UploadPartCommand);
    expect(command.input).toMatchObject({ Bucket: 'bucket', Key: 'key', UploadId: 'upload-1', PartNumber: 1 });
    expect(etag).toBe('etag-1');
  });

  it('presignGet() honors opts.filename via ResponseContentDisposition', async () => {
    const url = await storage.presignGet('bucket', 'key', 60, { filename: 'report.pdf' });

    expect(url).toBe('https://signed.example/aws');
    const command = awsGetSignedUrl.mock.calls[0][1];
    expect(command.input.ResponseContentDisposition).toBe('attachment; filename="report.pdf"');
    expect(awsGetSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 60 });
  });

  it('createBucket() omits LocationConstraint for us-east-1', async () => {
    awsSend.mockResolvedValueOnce({});
    await storage.createBucket('bucket');

    const command = awsSend.mock.calls[0][0];
    expect(command.input.CreateBucketConfiguration).toBeUndefined();
  });

  it('createBucket() sets LocationConstraint outside us-east-1', async () => {
    const other = new S3Storage(awsCreds, 'eu-west-1');
    awsSend.mockResolvedValueOnce({});
    await other.createBucket('bucket');

    const command = awsSend.mock.calls[0][0];
    expect(command.input.CreateBucketConfiguration).toEqual({ LocationConstraint: 'eu-west-1' });
  });

  it('setTags() sends a PutObjectTaggingCommand built from the tag map', async () => {
    awsSend.mockResolvedValueOnce({});
    await storage.setTags('bucket', 'key', { env: 'prod' });

    const command = awsSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(s3.PutObjectTaggingCommand);
    expect(command.input.Tagging.TagSet).toEqual([{ Key: 'env', Value: 'prod' }]);
  });

  it('supports() is true for every storage operation', () => {
    const ops: StorageOperation[] = ['get', 'multipart', 'presign_get', 'get_tags', 'list_buckets'];
    for (const op of ops) expect(storage.supports(op)).toBe(true);
  });

  it('provider() returns "aws"', () => {
    expect(storage.provider()).toBe('aws');
  });
});

describe('BlobStorage (Azure)', () => {
  let storage: InstanceType<typeof BlobStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new BlobStorage(azureCreds, 'acct');
  });

  it('put() uploads a buffer through the block blob client', async () => {
    azureBlockBlobClient.uploadData.mockResolvedValueOnce({});
    await storage.put('container', 'blob.txt', Buffer.from('hi'));

    expect(azureContainerClient.getBlockBlobClient).toHaveBeenCalledWith('blob.txt');
    expect(azureBlockBlobClient.uploadData).toHaveBeenCalledWith(Buffer.from('hi'));
  });

  it('multipartUploadPart() stages a block keyed by uploadId and part number', async () => {
    azureBlockBlobClient.stageBlock.mockResolvedValueOnce({});
    const blockId = await storage.multipartUploadPart('container', 'blob.txt', 'upload-1', 1, Buffer.from('part'));

    expect(blockId).toBe(Buffer.from('upload-1-000001').toString('base64'));
    expect(azureBlockBlobClient.stageBlock).toHaveBeenCalledWith(blockId, Buffer.from('part'), 4);
  });

  it('multipartComplete() commits the block list in ETag (blockId) order', async () => {
    azureBlockBlobClient.commitBlockList.mockResolvedValueOnce({});
    await storage.multipartComplete('container', 'blob.txt', 'upload-1', [
      { partNumber: 1, etag: 'block-a' },
      { partNumber: 2, etag: 'block-b' },
    ]);

    expect(azureBlockBlobClient.commitBlockList).toHaveBeenCalledWith(['block-a', 'block-b']);
  });

  it('multipartAbort() is a no-op that never throws', async () => {
    await expect(storage.multipartAbort('container', 'blob.txt', 'upload-1')).resolves.toBeUndefined();
  });

  it('presignGet() signs locally when a storage account key is configured', async () => {
    const url = await storage.presignGet('container', 'blob.txt', 60);
    expect(url).toBe('https://acct.blob.core.windows.net/container/blob.txt?sig=abc');
    expect(azureServiceClient.getUserDelegationKey).not.toHaveBeenCalled();
  });

  it('presignGet() falls back to a user delegation key without a storage account key', async () => {
    azureServiceClient.getUserDelegationKey.mockResolvedValueOnce({ value: 'udk' });
    const spOnly = new BlobStorage({ ...azureCreds, storageAccountKey: undefined }, 'acct');
    const url = await spOnly.presignGet('container', 'blob.txt', 60);

    expect(azureServiceClient.getUserDelegationKey).toHaveBeenCalled();
    expect(url).toBe('https://acct.blob.core.windows.net/container/blob.txt?sig=abc');
  });

  it('bucketExists() returns false when no container name matches', async () => {
    azureServiceClient.listContainers.mockReturnValueOnce(makeAsyncIterable([{ name: 'other' }]));
    expect(await storage.bucketExists('container')).toBe(false);
  });

  it('bucketExists() returns true on an exact name match', async () => {
    azureServiceClient.listContainers.mockReturnValueOnce(makeAsyncIterable([{ name: 'container' }]));
    expect(await storage.bucketExists('container')).toBe(true);
  });

  it('list() reads blob items off every page', async () => {
    azureContainerClient.listBlobsFlat.mockReturnValueOnce(
      makeBlobsFlatResult([{ name: 'a', properties: { contentLength: 3, etag: 'e', contentType: 'text/plain', lastModified: new Date(0) } }]),
    );
    const objects = await storage.list('container');
    expect(objects).toEqual([{ key: 'a', size: 3, lastModified: new Date(0), etag: 'e', contentType: 'text/plain' }]);
  });

  it('supports() is true for every storage operation', () => {
    expect(storage.supports('presign_get')).toBe(true);
    expect(storage.supports('multipart')).toBe(true);
  });

  it('provider() returns "azure"', () => {
    expect(storage.provider()).toBe('azure');
  });
});

describe('GcsStorage (GCP) — unsupported operations', () => {
  let storage: InstanceType<typeof GcsStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new GcsStorage(gcpCreds);
  });

  const multipartCases: Array<[string, () => Promise<unknown>]> = [
    ['multipartCreate', () => storage.multipartCreate('bucket', 'key')],
    ['multipartUploadPart', () => storage.multipartUploadPart('bucket', 'key', 'id', 1, Buffer.from('x'))],
    ['multipartComplete', () => storage.multipartComplete('bucket', 'key', 'id', [])],
    ['multipartAbort', () => storage.multipartAbort('bucket', 'key', 'id')],
  ];
  it.each(multipartCases)('%s() throws UnsupportedError', async (_name, call) => {
    await expect(call()).rejects.toThrow(UnsupportedError);
  });

  const tagCases: Array<[string, () => Promise<unknown>]> = [
    ['getTags', () => storage.getTags('bucket', 'key')],
    ['setTags', () => storage.setTags('bucket', 'key', {})],
    ['deleteTags', () => storage.deleteTags('bucket', 'key')],
  ];
  it.each(tagCases)('%s() throws UnsupportedError', async (_name, call) => {
    await expect(call()).rejects.toThrow(UnsupportedError);
  });

  it('exists() returns false when the file does not exist', async () => {
    gcpFile.exists.mockResolvedValueOnce([false]);
    expect(await storage.exists('bucket', 'key')).toBe(false);
  });

  it('bucketExists() returns true when the bucket exists', async () => {
    gcpBucket.exists.mockResolvedValueOnce([true]);
    expect(await storage.bucketExists('bucket')).toBe(true);
  });

  it('put() saves a buffer with contentType and nested custom metadata', async () => {
    gcpFile.save.mockResolvedValueOnce(undefined);
    await storage.put('bucket', 'key', Buffer.from('hi'), { contentType: 'text/plain', metadata: { a: 'b' } });

    expect(gcpFile.save).toHaveBeenCalledWith(Buffer.from('hi'), {
      contentType: 'text/plain',
      metadata: { metadata: { a: 'b' } },
    });
  });

  it('supports() is false only for multipart and tag operations', () => {
    const unsupported: StorageOperation[] = ['multipart', 'get_tags', 'set_tags', 'delete_tags'];
    const supported: StorageOperation[] = ['get', 'put', 'copy', 'presign_get', 'list_buckets'];
    for (const op of unsupported) expect(storage.supports(op)).toBe(false);
    for (const op of supported) expect(storage.supports(op)).toBe(true);
  });

  it('provider() returns "gcp"', () => {
    expect(storage.provider()).toBe('gcp');
  });
});

describe('ObjectStorage (OCI)', () => {
  let storage: InstanceType<typeof ObjectStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new ObjectStorage(ociCreds, 'ns', 'compartment-1');
  });

  it('put() sends a PutObjectRequest with a default content type', async () => {
    ociClient.putObject.mockResolvedValueOnce({});
    await storage.put('bucket', 'key', Buffer.from('hi'));

    expect(ociClient.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespaceName: 'ns', bucketName: 'bucket', objectName: 'key', contentType: 'application/octet-stream' }),
    );
  });

  it('move() renames within the same bucket instead of copy+delete', async () => {
    ociClient.renameObject.mockResolvedValueOnce({});
    await storage.move('bucket', 'src', 'bucket', 'dst');

    expect(ociClient.renameObject).toHaveBeenCalledWith({
      namespaceName: 'ns',
      bucketName: 'bucket',
      renameObjectDetails: { sourceName: 'src', newName: 'dst' },
    });
    expect(ociClient.copyObject).not.toHaveBeenCalled();
  });

  it('move() copies then deletes across buckets', async () => {
    ociClient.copyObject.mockResolvedValueOnce({});
    ociClient.deleteObject.mockResolvedValueOnce({});
    await storage.move('src-bucket', 'src', 'dst-bucket', 'dst');

    expect(ociClient.copyObject).toHaveBeenCalled();
    expect(ociClient.deleteObject).toHaveBeenCalled();
  });

  it('getTags()/setTags() emulate tags with a tag_ metadata prefix', async () => {
    ociClient.headObject.mockResolvedValueOnce({ opcMeta: { 'tag_env': 'prod', other: 'x' } });
    expect(await storage.getTags('bucket', 'key')).toEqual({ env: 'prod' });

    ociClient.headObject.mockResolvedValueOnce({ opcMeta: { other: 'x' } });
    ociClient.copyObject.mockResolvedValueOnce({});
    await storage.setTags('bucket', 'key', { team: 'infra' });

    const call = ociClient.copyObject.mock.calls[0][0];
    expect(call.copyObjectDetails.destinationObjectMetadata).toEqual({ 'opc-meta-other': 'x', 'opc-meta-tag_team': 'infra' });
  });

  it('exists() returns false when headObject rejects', async () => {
    ociClient.headObject.mockRejectedValueOnce(new Error('not found'));
    expect(await storage.exists('bucket', 'key')).toBe(false);
  });

  it('bucketExists() returns false when headBucket rejects', async () => {
    ociClient.headBucket.mockRejectedValueOnce(new Error('not found'));
    expect(await storage.bucketExists('bucket')).toBe(false);
  });

  it('supports() is true for every storage operation', () => {
    expect(storage.supports('multipart')).toBe(true);
    expect(storage.supports('get_tags')).toBe(true);
  });

  it('provider() returns "oci"', () => {
    expect(storage.provider()).toBe('oci');
  });

  // The PAR access URI comes back as a relative path; returning it verbatim gave
  // callers a URL they could not fetch.
  it.each([
    ['presignGet', (st: InstanceType<typeof ObjectStorage>) => st.presignGet('bucket', 'key', 60)],
    ['presignPut', (st: InstanceType<typeof ObjectStorage>) => st.presignPut('bucket', 'key', 60)],
  ])('%s returns an absolute URL built from the client endpoint', async (_name, call) => {
    ociClient.endpoint = 'https://objectstorage.us-ashburn-1.oraclecloud.com';
    ociClient.createPreauthenticatedRequest.mockResolvedValueOnce({
      preauthenticatedRequest: { accessUri: '/p/tok/n/ns/b/bucket/o/key' },
    });
    await expect(call(storage)).resolves.toBe(
      'https://objectstorage.us-ashburn-1.oraclecloud.com/p/tok/n/ns/b/bucket/o/key',
    );
  });

  it('presignGet falls back to the region endpoint when the client has none', async () => {
    ociClient.endpoint = undefined;
    ociClient.createPreauthenticatedRequest.mockResolvedValueOnce({
      preauthenticatedRequest: { accessUri: '/p/tok' },
    });
    await expect(storage.presignGet('bucket', 'key', 60)).resolves.toBe(
      `https://objectstorage.${ociCreds.region}.oraclecloud.com/p/tok`,
    );
  });

  it('presignGet leaves an already absolute access URI untouched', async () => {
    ociClient.endpoint = 'https://objectstorage.us-ashburn-1.oraclecloud.com';
    ociClient.createPreauthenticatedRequest.mockResolvedValueOnce({
      preauthenticatedRequest: { accessUri: 'https://elsewhere.example.com/p/tok' },
    });
    await expect(storage.presignGet('bucket', 'key', 60)).resolves.toBe('https://elsewhere.example.com/p/tok');
  });

  it('presignGet fails cleanly when the service returns no access URI', async () => {
    ociClient.createPreauthenticatedRequest.mockResolvedValueOnce({ preauthenticatedRequest: {} });
    await expect(storage.presignGet('bucket', 'key', 60)).rejects.toThrow();
  });
});

describe('exists()-style methods return false rather than throwing', () => {
  it('S3Storage.exists() swallows the head error', async () => {
    vi.clearAllMocks();
    const storage = new S3Storage(awsCreds);
    awsSend.mockRejectedValueOnce(new Error('boom'));
    expect(await storage.exists('bucket', 'key')).toBe(false);
  });

  it('S3Storage.bucketExists() swallows the head error', async () => {
    vi.clearAllMocks();
    const storage = new S3Storage(awsCreds);
    awsSend.mockRejectedValueOnce(new Error('boom'));
    expect(await storage.bucketExists('bucket')).toBe(false);
  });

  it('BlobStorage.exists() swallows the getProperties error', async () => {
    vi.clearAllMocks();
    const storage = new BlobStorage(azureCreds, 'acct');
    azureBlobClient.getProperties.mockRejectedValueOnce(new Error('boom'));
    expect(await storage.exists('container', 'blob.txt')).toBe(false);
  });
});
