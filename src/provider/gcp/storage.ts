import type { Readable } from 'node:stream';

import { type File, Storage as GcsClient } from '@google-cloud/storage';

import type { GcpCredentials } from '../../credentials/index.js';
import { UnsupportedError, wrapProviderError } from '../../errors.js';
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
import { gcpClientConfig } from './auth.js';

async function readAll(reader: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of reader) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function objectFromMetadata(key: string, meta: Record<string, unknown>): StorageObject {
  return {
    key,
    size: meta.size !== undefined ? Number(meta.size) : 0,
    lastModified: meta.updated ? new Date(meta.updated as string) : new Date(0),
    etag: (meta.etag as string) ?? '',
    contentType: (meta.contentType as string) ?? '',
  };
}

function multipartUnsupported(op: string): never {
  throw new UnsupportedError(
    'gcp',
    op,
    'GCS has no S3-style multipart upload.',
    'Use Upload/PutStream (resumable uploads are automatic).',
  );
}

function tagsUnsupported(op: string): never {
  throw new UnsupportedError(
    'gcp',
    op,
    'GCS has no object tags.',
    'Use object metadata (GetMetadata/SetMetadata) instead.',
  );
}

/** Google Cloud Storage. */
export class GcsStorage implements Storage {
  private readonly client: GcsClient;
  private readonly projectId: string;

  constructor(creds: GcpCredentials) {
    const cfg = gcpClientConfig(creds);
    this.client = new GcsClient(cfg);
    this.projectId = cfg.projectId;
  }

  private obj(bucket: string, key: string): File {
    return this.client.bucket(bucket).file(key);
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    try {
      const stream = await this.getStream(bucket, key);
      return await readAll(stream);
    } catch (err) {
      wrapProviderError('gcp', 'GetObject', err);
    }
  }

  async getStream(bucket: string, key: string): Promise<Readable> {
    return this.obj(bucket, key).createReadStream();
  }

  async put(bucket: string, key: string, data: Buffer | Uint8Array | string, opts?: StoragePutOptions): Promise<void> {
    try {
      const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
      await this.obj(bucket, key).save(buffer, {
        contentType: opts?.contentType,
        metadata: opts?.metadata ? { metadata: opts.metadata } : undefined,
      });
    } catch (err) {
      wrapProviderError('gcp', 'PutObject', err);
    }
  }

  async putStream(
    bucket: string,
    key: string,
    reader: Readable,
    _size: number,
    opts?: StoragePutOptions,
  ): Promise<void> {
    try {
      const writeStream = this.obj(bucket, key).createWriteStream({
        contentType: opts?.contentType,
        metadata: opts?.metadata ? { metadata: opts.metadata } : undefined,
      });
      await new Promise<void>((resolve, reject) => {
        reader.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        reader.pipe(writeStream);
      });
    } catch (err) {
      wrapProviderError('gcp', 'PutObject', err);
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    try {
      await this.obj(bucket, key).delete();
    } catch (err) {
      wrapProviderError('gcp', 'DeleteObject', err);
    }
  }

  async list(bucket: string, opts?: StorageListOptions): Promise<StorageObject[]> {
    try {
      const [files] = await this.client
        .bucket(bucket)
        .getFiles({ prefix: opts?.prefix, startOffset: opts?.startAfter });
      const objects = files.map((f) => objectFromMetadata(f.name, f.metadata as Record<string, unknown>));
      return opts?.maxKeys && opts.maxKeys > 0 ? objects.slice(0, opts.maxKeys) : objects;
    } catch (err) {
      wrapProviderError('gcp', 'ListObjects', err);
    }
  }

  async head(bucket: string, key: string): Promise<StorageObject> {
    try {
      const [meta] = await this.obj(bucket, key).getMetadata();
      return objectFromMetadata(key, meta as Record<string, unknown>);
    } catch (err) {
      wrapProviderError('gcp', 'HeadObject', err);
    }
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    try {
      const [exists] = await this.obj(bucket, key).exists();
      return exists;
    } catch (err) {
      wrapProviderError('gcp', 'HeadObject', err);
    }
  }

  async getRange(bucket: string, key: string, offset: number, length: number): Promise<Buffer> {
    try {
      const [data] = await this.obj(bucket, key).download({ start: offset, end: offset + length - 1 });
      return data;
    } catch (err) {
      wrapProviderError('gcp', 'GetObjectRange', err);
    }
  }

  async deleteBulk(bucket: string, keys: string[]): Promise<StorageDeleteError[]> {
    const failures: StorageDeleteError[] = [];
    for (const key of keys) {
      try {
        await this.obj(bucket, key).delete();
      } catch (err) {
        failures.push({ key, code: '', message: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }

  async copy(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<void> {
    try {
      await this.obj(srcBucket, srcKey).copy(this.obj(dstBucket, dstKey));
    } catch (err) {
      wrapProviderError('gcp', 'CopyObject', err);
    }
  }

  async move(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<void> {
    await this.copy(srcBucket, srcKey, dstBucket, dstKey);
    await this.delete(srcBucket, srcKey);
  }

  async multipartCreate(_bucket: string, _key: string, _opts?: MultipartCreateOptions): Promise<string> {
    multipartUnsupported('MultipartCreate');
  }

  async multipartUploadPart(
    _bucket: string,
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _data: Buffer | Uint8Array,
  ): Promise<string> {
    multipartUnsupported('MultipartUploadPart');
  }

  async multipartComplete(_bucket: string, _key: string, _uploadId: string, _parts: MultipartPart[]): Promise<void> {
    multipartUnsupported('MultipartComplete');
  }

  async multipartAbort(_bucket: string, _key: string, _uploadId: string): Promise<void> {
    multipartUnsupported('MultipartAbort');
  }

  async upload(bucket: string, key: string, reader: Readable, size: number, opts?: UploadOptions): Promise<void> {
    await this.putStream(bucket, key, reader, size, { contentType: opts?.contentType, metadata: opts?.metadata });
  }

  async listAll(bucket: string, opts?: StorageListOptions): Promise<StorageObject[]> {
    return this.list(bucket, { prefix: opts?.prefix, startAfter: opts?.startAfter });
  }

  async presignGet(bucket: string, key: string, expiresInSeconds: number, opts?: PresignGetOptions): Promise<string> {
    try {
      const [url] = await this.obj(bucket, key).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expiresInSeconds * 1000,
        responseDisposition: opts?.filename ? `attachment; filename="${opts.filename}"` : undefined,
      });
      return url;
    } catch (err) {
      wrapProviderError('gcp', 'SignedURL(Get)', err);
    }
  }

  async presignPut(bucket: string, key: string, expiresInSeconds: number): Promise<string> {
    try {
      const [url] = await this.obj(bucket, key).getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + expiresInSeconds * 1000,
      });
      return url;
    } catch (err) {
      wrapProviderError('gcp', 'SignedURL(Put)', err);
    }
  }

  async getMetadata(bucket: string, key: string): Promise<Record<string, string>> {
    try {
      const [meta] = await this.obj(bucket, key).getMetadata();
      return (meta.metadata as Record<string, string>) ?? {};
    } catch (err) {
      wrapProviderError('gcp', 'GetMetadata', err);
    }
  }

  async setMetadata(bucket: string, key: string, metadata: Record<string, string>): Promise<void> {
    try {
      await this.obj(bucket, key).setMetadata({ metadata });
    } catch (err) {
      wrapProviderError('gcp', 'SetMetadata', err);
    }
  }

  async getTags(_bucket: string, _key: string): Promise<Record<string, string>> {
    tagsUnsupported('GetTags');
  }

  async setTags(_bucket: string, _key: string, _tags: Record<string, string>): Promise<void> {
    tagsUnsupported('SetTags');
  }

  async deleteTags(_bucket: string, _key: string): Promise<void> {
    tagsUnsupported('DeleteTags');
  }

  async createBucket(bucket: string): Promise<void> {
    try {
      await this.client.createBucket(bucket);
    } catch (err) {
      wrapProviderError('gcp', 'CreateBucket', err);
    }
  }

  async deleteBucket(bucket: string): Promise<void> {
    try {
      await this.client.bucket(bucket).delete();
    } catch (err) {
      wrapProviderError('gcp', 'DeleteBucket', err);
    }
  }

  async bucketExists(bucket: string): Promise<boolean> {
    try {
      const [exists] = await this.client.bucket(bucket).exists();
      return exists;
    } catch (err) {
      wrapProviderError('gcp', 'BucketExists', err);
    }
  }

  async listBuckets(): Promise<BucketInfo[]> {
    try {
      const [buckets] = await this.client.getBuckets({ project: this.projectId });
      return buckets.map((b) => {
        const meta = b.metadata as Record<string, unknown>;
        return {
          name: b.name,
          createdAt: meta.timeCreated ? new Date(meta.timeCreated as string) : new Date(0),
          region: (meta.location as string) ?? '',
        };
      });
    } catch (err) {
      wrapProviderError('gcp', 'ListBuckets', err);
    }
  }

  supports(op: StorageOperation): boolean {
    return op !== 'multipart' && op !== 'get_tags' && op !== 'set_tags' && op !== 'delete_tags';
  }

  provider(): string {
    return 'gcp';
  }
}
