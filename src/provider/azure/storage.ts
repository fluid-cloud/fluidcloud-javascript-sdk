import type { Readable } from 'node:stream';

import {
  BlobSASPermissions,
  type BlobSASSignatureValues,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  type SASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

import type { AzureCredentials } from '../../credentials/index.js';
import { wrapProviderError } from '../../errors.js';
import type {
  BucketInfo,
  MultipartCreateOptions,
  MultipartPart,
  PresignGetOptions,
  Storage,
  StorageDeleteError,
  StorageListOptions,
  StorageObject,
  StorageOperation,
  StoragePutOptions,
  UploadOptions,
} from '../types/storage.js';
import { azureCredential } from './auth.js';

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_MULTIPART_THRESHOLD = 64 * 1024 * 1024;

async function readAll(reader: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of reader) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Azure Blob Storage. */
export class BlobStorage implements Storage {
  private readonly client: BlobServiceClient;
  private readonly storageAccount: string;
  private readonly sharedKeyCred?: StorageSharedKeyCredential;

  constructor(creds: AzureCredentials, storageAccount: string) {
    const accountName = creds.storageAccountName || storageAccount;
    const serviceUrl = `https://${accountName}.blob.core.windows.net/`;

    if (creds.storageAccountKey) {
      this.sharedKeyCred = new StorageSharedKeyCredential(accountName, creds.storageAccountKey);
      this.client = new BlobServiceClient(serviceUrl, this.sharedKeyCred);
    } else {
      this.client = new BlobServiceClient(serviceUrl, azureCredential(creds));
    }
    this.storageAccount = accountName;
  }

  async get(container: string, blobName: string): Promise<Buffer> {
    const stream = await this.getStream(container, blobName);
    return readAll(stream);
  }

  async getStream(container: string, blobName: string): Promise<Readable> {
    try {
      const resp = await this.client.getContainerClient(container).getBlobClient(blobName).download();
      return resp.readableStreamBody as unknown as Readable;
    } catch (err) {
      wrapProviderError('azure', 'DownloadStream', err);
    }
  }

  async put(
    container: string,
    blobName: string,
    data: Buffer | Uint8Array | string,
    _opts?: StoragePutOptions,
  ): Promise<void> {
    try {
      const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
      await this.client.getContainerClient(container).getBlockBlobClient(blobName).uploadData(buffer);
    } catch (err) {
      wrapProviderError('azure', 'UploadBuffer', err);
    }
  }

  async putStream(
    container: string,
    blobName: string,
    reader: Readable,
    _size: number,
    opts?: StoragePutOptions,
  ): Promise<void> {
    const data = await readAll(reader);
    await this.put(container, blobName, data, opts);
  }

  async delete(container: string, blobName: string): Promise<void> {
    try {
      await this.client.getContainerClient(container).deleteBlob(blobName);
    } catch (err) {
      wrapProviderError('azure', 'DeleteBlob', err);
    }
  }

  async list(container: string, opts?: StorageListOptions): Promise<StorageObject[]> {
    try {
      const pager = this.client
        .getContainerClient(container)
        .listBlobsFlat({ prefix: opts?.prefix })
        .byPage({ maxPageSize: opts?.maxKeys && opts.maxKeys > 0 ? opts.maxKeys : undefined });

      const objects: StorageObject[] = [];
      for await (const page of pager) {
        for (const blob of page.segment.blobItems) {
          objects.push({
            key: blob.name,
            size: blob.properties.contentLength ?? 0,
            lastModified: blob.properties.lastModified ?? new Date(0),
            etag: blob.properties.etag ?? '',
            contentType: blob.properties.contentType ?? '',
          });
        }
      }
      return objects;
    } catch (err) {
      wrapProviderError('azure', 'ListBlobs', err);
    }
  }

  async head(container: string, blobName: string): Promise<StorageObject> {
    try {
      const props = await this.client.getContainerClient(container).getBlobClient(blobName).getProperties();
      return {
        key: blobName,
        size: props.contentLength ?? 0,
        lastModified: props.lastModified ?? new Date(0),
        etag: props.etag ?? '',
        contentType: props.contentType ?? '',
      };
    } catch (err) {
      wrapProviderError('azure', 'GetBlobProperties', err);
    }
  }

  async exists(container: string, blobName: string): Promise<boolean> {
    try {
      await this.head(container, blobName);
      return true;
    } catch {
      return false;
    }
  }

  async getRange(container: string, blobName: string, offset: number, length: number): Promise<Buffer> {
    try {
      const resp = await this.client.getContainerClient(container).getBlobClient(blobName).download(offset, length);
      return readAll(resp.readableStreamBody as unknown as Readable);
    } catch (err) {
      wrapProviderError('azure', 'DownloadStream(Range)', err);
    }
  }

  async deleteBulk(container: string, keys: string[]): Promise<StorageDeleteError[]> {
    if (keys.length === 0) return [];
    const containerClient = this.client.getContainerClient(container);
    const concurrency = 10;
    const errors: StorageDeleteError[] = [];
    let index = 0;

    const worker = async (): Promise<void> => {
      while (index < keys.length) {
        const key = keys[index++];
        try {
          await containerClient.deleteBlob(key);
        } catch (err) {
          errors.push({ key, code: '', message: err instanceof Error ? err.message : String(err) });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()));
    return errors;
  }

  async copy(srcContainer: string, srcBlob: string, dstContainer: string, dstBlob: string): Promise<void> {
    try {
      const srcUrl = `https://${this.storageAccount}.blob.core.windows.net/${srcContainer}/${srcBlob}`;
      await this.client.getContainerClient(dstContainer).getBlobClient(dstBlob).beginCopyFromURL(srcUrl);
    } catch (err) {
      wrapProviderError('azure', 'StartCopyFromURL', err);
    }
  }

  async move(srcContainer: string, srcBlob: string, dstContainer: string, dstBlob: string): Promise<void> {
    await this.copy(srcContainer, srcBlob, dstContainer, dstBlob);
    await this.delete(srcContainer, srcBlob);
  }

  async multipartCreate(_container: string, _blobName: string, _opts?: MultipartCreateOptions): Promise<string> {
    return process.hrtime.bigint().toString();
  }

  async multipartUploadPart(
    container: string,
    blobName: string,
    uploadId: string,
    partNumber: number,
    data: Buffer | Uint8Array,
  ): Promise<string> {
    try {
      const blockId = Buffer.from(`${uploadId}-${String(partNumber).padStart(6, '0')}`).toString('base64');
      const blockBlobClient = this.client.getContainerClient(container).getBlockBlobClient(blobName);
      await blockBlobClient.stageBlock(blockId, Buffer.from(data), data.length);
      return blockId;
    } catch (err) {
      wrapProviderError('azure', 'StageBlock', err);
    }
  }

  async multipartComplete(
    container: string,
    blobName: string,
    _uploadId: string,
    parts: MultipartPart[],
  ): Promise<void> {
    try {
      const blockBlobClient = this.client.getContainerClient(container).getBlockBlobClient(blobName);
      await blockBlobClient.commitBlockList(parts.map((p) => p.etag));
    } catch (err) {
      wrapProviderError('azure', 'CommitBlockList', err);
    }
  }

  /** No-op: Azure has no abort; uncommitted blocks expire automatically. */
  async multipartAbort(_container: string, _blobName: string, _uploadId: string): Promise<void> {}

  async upload(
    container: string,
    blobName: string,
    reader: Readable,
    size: number,
    opts?: UploadOptions,
  ): Promise<void> {
    const threshold =
      opts?.multipartThreshold && opts.multipartThreshold > 0 ? opts.multipartThreshold : DEFAULT_MULTIPART_THRESHOLD;

    if (size > 0 && size < threshold) {
      const data = await readAll(reader);
      await this.put(container, blobName, data);
      return;
    }

    try {
      const blockBlobClient = this.client.getContainerClient(container).getBlockBlobClient(blobName);
      await blockBlobClient.uploadStream(reader);
    } catch (err) {
      wrapProviderError('azure', 'UploadStream', err);
    }
  }

  async listAll(container: string, opts?: StorageListOptions): Promise<StorageObject[]> {
    try {
      const objects: StorageObject[] = [];
      for await (const blob of this.client.getContainerClient(container).listBlobsFlat({ prefix: opts?.prefix })) {
        objects.push({
          key: blob.name,
          size: blob.properties.contentLength ?? 0,
          lastModified: blob.properties.lastModified ?? new Date(0),
          etag: blob.properties.etag ?? '',
          contentType: blob.properties.contentType ?? '',
        });
      }
      return objects;
    } catch (err) {
      wrapProviderError('azure', 'ListBlobs(All)', err);
    }
  }

  async presignGet(
    container: string,
    blobName: string,
    expiresInSeconds: number,
    opts?: PresignGetOptions,
  ): Promise<string> {
    const disposition = opts?.filename ? `attachment; filename="${opts.filename}"` : undefined;
    return this.signSAS(
      'PresignGet',
      container,
      blobName,
      expiresInSeconds,
      BlobSASPermissions.parse('r'),
      disposition,
    );
  }

  async presignPut(container: string, blobName: string, expiresInSeconds: number): Promise<string> {
    return this.signSAS('PresignPut', container, blobName, expiresInSeconds, BlobSASPermissions.parse('cw'), undefined);
  }

  private async signSAS(
    op: string,
    container: string,
    blobName: string,
    expiresInSeconds: number,
    permissions: BlobSASPermissions,
    contentDisposition?: string,
  ): Promise<string> {
    if (expiresInSeconds <= 0) {
      wrapProviderError('azure', op, new Error(`expiry must be positive, got ${expiresInSeconds}s`));
    }

    const now = new Date();
    const values: BlobSASSignatureValues = {
      protocol: SASProtocol.Https,
      startsOn: new Date(now.getTime() - CLOCK_SKEW_MS),
      expiresOn: new Date(now.getTime() + expiresInSeconds * 1000),
      permissions,
      containerName: container,
      blobName,
      contentDisposition,
    };

    try {
      let sas: SASQueryParameters;
      if (this.sharedKeyCred) {
        sas = generateBlobSASQueryParameters(values, this.sharedKeyCred);
      } else {
        const udk = await this.client.getUserDelegationKey(values.startsOn as Date, values.expiresOn as Date);
        sas = generateBlobSASQueryParameters(values, udk, this.storageAccount);
      }
      return `https://${this.storageAccount}.blob.core.windows.net/${container}/${blobName}?${sas.toString()}`;
    } catch (err) {
      wrapProviderError('azure', op, err);
    }
  }

  async getMetadata(container: string, blobName: string): Promise<Record<string, string>> {
    try {
      const props = await this.client.getContainerClient(container).getBlobClient(blobName).getProperties();
      return props.metadata ?? {};
    } catch (err) {
      wrapProviderError('azure', 'GetBlobProperties(Metadata)', err);
    }
  }

  async setMetadata(container: string, blobName: string, metadata: Record<string, string>): Promise<void> {
    try {
      await this.client.getContainerClient(container).getBlobClient(blobName).setMetadata(metadata);
    } catch (err) {
      wrapProviderError('azure', 'SetBlobMetadata', err);
    }
  }

  async getTags(container: string, blobName: string): Promise<Record<string, string>> {
    try {
      const resp = await this.client.getContainerClient(container).getBlobClient(blobName).getTags();
      return resp.tags ?? {};
    } catch (err) {
      wrapProviderError('azure', 'GetBlobTags', err);
    }
  }

  async setTags(container: string, blobName: string, tags: Record<string, string>): Promise<void> {
    try {
      await this.client.getContainerClient(container).getBlobClient(blobName).setTags(tags);
    } catch (err) {
      wrapProviderError('azure', 'SetBlobTags', err);
    }
  }

  async deleteTags(container: string, blobName: string): Promise<void> {
    await this.setTags(container, blobName, {});
  }

  async createBucket(container: string): Promise<void> {
    try {
      await this.client.createContainer(container);
    } catch (err) {
      wrapProviderError('azure', 'CreateContainer', err);
    }
  }

  async deleteBucket(container: string): Promise<void> {
    try {
      await this.client.deleteContainer(container);
    } catch (err) {
      wrapProviderError('azure', 'DeleteContainer', err);
    }
  }

  async bucketExists(container: string): Promise<boolean> {
    try {
      for await (const c of this.client.listContainers({ prefix: container })) {
        if (c.name === container) return true;
      }
      return false;
    } catch (err) {
      wrapProviderError('azure', 'ListContainers', err);
    }
  }

  async listBuckets(): Promise<BucketInfo[]> {
    try {
      const buckets: BucketInfo[] = [];
      for await (const c of this.client.listContainers()) {
        buckets.push({ name: c.name, createdAt: c.properties.lastModified ?? new Date(0), region: '' });
      }
      return buckets;
    } catch (err) {
      wrapProviderError('azure', 'ListContainers', err);
    }
  }

  supports(_op: StorageOperation): boolean {
    return true;
  }

  provider(): string {
    return 'azure';
  }
}
