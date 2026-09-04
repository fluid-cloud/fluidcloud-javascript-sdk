import type { Readable } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  type BucketLocationConstraint,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectTaggingCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  MetadataDirective,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { AwsCredentials } from '../../credentials/index.js';
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
  StoragePutOptions,
  StorageOperation,
  UploadOptions,
} from '../types/storage.js';
import { awsClientConfig } from './auth.js';

const DEFAULT_MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

async function readAll(reader: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of reader) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** AWS S3 storage. */
export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly region: string;

  constructor(creds: AwsCredentials, region?: string) {
    const cfg = awsClientConfig(creds, region);
    this.client = new S3Client(cfg);
    this.region = cfg.region;
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    const stream = await this.getStream(bucket, key);
    return readAll(stream);
  }

  async getStream(bucket: string, key: string): Promise<Readable> {
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return output.Body as Readable;
    } catch (err) {
      wrapProviderError('aws', 'GetObject', err);
    }
  }

  async put(bucket: string, key: string, data: Buffer | Uint8Array | string, opts?: StoragePutOptions): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: opts?.contentType,
          Metadata: opts?.metadata,
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'PutObject', err);
    }
  }

  async putStream(bucket: string, key: string, reader: Readable, size: number, opts?: StoragePutOptions): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: reader,
          ContentLength: size,
          ContentType: opts?.contentType,
          Metadata: opts?.metadata,
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'PutObject', err);
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      wrapProviderError('aws', 'DeleteObject', err);
    }
  }

  async list(bucket: string, opts?: StorageListOptions): Promise<StorageObject[]> {
    try {
      const output = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: opts?.prefix,
          MaxKeys: opts?.maxKeys,
          StartAfter: opts?.startAfter,
        }),
      );
      return (output.Contents ?? []).map((obj) => ({
        key: obj.Key ?? '',
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(0),
        etag: obj.ETag ?? '',
        contentType: '',
      }));
    } catch (err) {
      wrapProviderError('aws', 'ListObjectsV2', err);
    }
  }

  async head(bucket: string, key: string): Promise<StorageObject> {
    try {
      const output = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        key,
        size: output.ContentLength ?? 0,
        lastModified: output.LastModified ?? new Date(0),
        etag: output.ETag ?? '',
        contentType: output.ContentType ?? '',
      };
    } catch (err) {
      wrapProviderError('aws', 'HeadObject', err);
    }
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.head(bucket, key);
      return true;
    } catch {
      return false;
    }
  }

  async getRange(bucket: string, key: string, offset: number, length: number): Promise<Buffer> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${offset}-${offset + length - 1}` }),
      );
      return readAll(output.Body as Readable);
    } catch (err) {
      wrapProviderError('aws', 'GetObject(Range)', err);
    }
  }

  async deleteBulk(bucket: string, keys: string[]): Promise<StorageDeleteError[]> {
    if (keys.length === 0) return [];
    try {
      const output = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
      return (output.Errors ?? []).map((e) => ({ key: e.Key ?? '', code: e.Code ?? '', message: e.Message ?? '' }));
    } catch (err) {
      wrapProviderError('aws', 'DeleteObjects', err);
    }
  }

  async copy(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({ Bucket: dstBucket, Key: dstKey, CopySource: `${srcBucket}/${srcKey}` }),
      );
    } catch (err) {
      wrapProviderError('aws', 'CopyObject', err);
    }
  }

  async move(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<void> {
    await this.copy(srcBucket, srcKey, dstBucket, dstKey);
    await this.delete(srcBucket, srcKey);
  }

  async multipartCreate(bucket: string, key: string, opts?: MultipartCreateOptions): Promise<string> {
    try {
      const output = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: opts?.contentType,
          Metadata: opts?.metadata,
        }),
      );
      return output.UploadId ?? '';
    } catch (err) {
      wrapProviderError('aws', 'CreateMultipartUpload', err);
    }
  }

  async multipartUploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    data: Buffer | Uint8Array,
  ): Promise<string> {
    try {
      const output = await this.client.send(
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: data }),
      );
      return output.ETag ?? '';
    } catch (err) {
      wrapProviderError('aws', 'UploadPart', err);
    }
  }

  async multipartComplete(bucket: string, key: string, uploadId: string, parts: MultipartPart[]): Promise<void> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'CompleteMultipartUpload', err);
    }
  }

  async multipartAbort(bucket: string, key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    } catch (err) {
      wrapProviderError('aws', 'AbortMultipartUpload', err);
    }
  }

  async upload(bucket: string, key: string, reader: Readable, size: number, opts?: UploadOptions): Promise<void> {
    const threshold = opts?.multipartThreshold && opts.multipartThreshold > 0 ? opts.multipartThreshold : DEFAULT_MULTIPART_THRESHOLD;
    const partSize = opts?.partSize && opts.partSize > 0 ? opts.partSize : DEFAULT_PART_SIZE;
    const putOpts: StoragePutOptions = { contentType: opts?.contentType, metadata: opts?.metadata };

    if (size > 0 && size < threshold) {
      const data = await readAll(reader);
      await this.put(bucket, key, data, putOpts);
      return;
    }

    const uploadId = await this.multipartCreate(bucket, key, putOpts);
    const parts: MultipartPart[] = [];
    let partNumber = 1;
    let buffered = Buffer.alloc(0);

    try {
      for await (const chunk of reader) {
        buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        while (buffered.length >= partSize) {
          const part = buffered.subarray(0, partSize);
          buffered = buffered.subarray(partSize);
          const etag = await this.multipartUploadPart(bucket, key, uploadId, partNumber, part);
          parts.push({ partNumber, etag });
          partNumber++;
        }
      }
      if (buffered.length > 0) {
        const etag = await this.multipartUploadPart(bucket, key, uploadId, partNumber, buffered);
        parts.push({ partNumber, etag });
      }
    } catch (err) {
      await this.multipartAbort(bucket, key, uploadId).catch(() => undefined);
      throw err;
    }

    await this.multipartComplete(bucket, key, uploadId, parts);
  }

  async listAll(bucket: string, opts?: StorageListOptions): Promise<StorageObject[]> {
    const allObjects: StorageObject[] = [];
    let continuationToken: string | undefined;
    try {
      do {
        const output = await this.client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: opts?.prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of output.Contents ?? []) {
          allObjects.push({
            key: obj.Key ?? '',
            size: obj.Size ?? 0,
            lastModified: obj.LastModified ?? new Date(0),
            etag: obj.ETag ?? '',
            contentType: '',
          });
        }
        continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (err) {
      wrapProviderError('aws', 'ListObjectsV2(Paginated)', err);
    }
    return allObjects;
  }

  async presignGet(bucket: string, key: string, expiresInSeconds: number, opts?: PresignGetOptions): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: opts?.filename ? `attachment; filename="${opts.filename}"` : undefined,
      });
      return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    } catch (err) {
      wrapProviderError('aws', 'PresignGetObject', err);
    }
  }

  async presignPut(bucket: string, key: string, expiresInSeconds: number): Promise<string> {
    try {
      const command = new PutObjectCommand({ Bucket: bucket, Key: key });
      return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    } catch (err) {
      wrapProviderError('aws', 'PresignPutObject', err);
    }
  }

  async getMetadata(bucket: string, key: string): Promise<Record<string, string>> {
    try {
      const output = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return output.Metadata ?? {};
    } catch (err) {
      wrapProviderError('aws', 'HeadObject(Metadata)', err);
    }
  }

  async setMetadata(bucket: string, key: string, metadata: Record<string, string>): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: key,
          CopySource: `${bucket}/${key}`,
          Metadata: metadata,
          MetadataDirective: MetadataDirective.REPLACE,
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'CopyObject(SetMetadata)', err);
    }
  }

  async getTags(bucket: string, key: string): Promise<Record<string, string>> {
    try {
      const output = await this.client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      const tags: Record<string, string> = {};
      for (const tag of output.TagSet ?? []) {
        if (tag.Key) tags[tag.Key] = tag.Value ?? '';
      }
      return tags;
    } catch (err) {
      wrapProviderError('aws', 'GetObjectTagging', err);
    }
  }

  async setTags(bucket: string, key: string, tags: Record<string, string>): Promise<void> {
    try {
      await this.client.send(
        new PutObjectTaggingCommand({
          Bucket: bucket,
          Key: key,
          Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'PutObjectTagging', err);
    }
  }

  async deleteTags(bucket: string, key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectTaggingCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      wrapProviderError('aws', 'DeleteObjectTagging', err);
    }
  }

  async createBucket(bucket: string): Promise<void> {
    try {
      await this.client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          CreateBucketConfiguration:
            this.region !== 'us-east-1' ? { LocationConstraint: this.region as BucketLocationConstraint } : undefined,
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'CreateBucket', err);
    }
  }

  async deleteBucket(bucket: string): Promise<void> {
    try {
      await this.client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch (err) {
      wrapProviderError('aws', 'DeleteBucket', err);
    }
  }

  async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async listBuckets(): Promise<BucketInfo[]> {
    try {
      const output = await this.client.send(new ListBucketsCommand({}));
      return (output.Buckets ?? []).map((b) => ({
        name: b.Name ?? '',
        createdAt: b.CreationDate ?? new Date(0),
        region: '',
      }));
    } catch (err) {
      wrapProviderError('aws', 'ListBuckets', err);
    }
  }

  supports(_op: StorageOperation): boolean {
    return true;
  }

  provider(): string {
    return 'aws';
  }
}
