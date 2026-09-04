import type { Readable } from 'node:stream';

import * as common from 'oci-common';
import { ObjectStorageClient, models } from 'oci-objectstorage';

import type { OciCredentials } from '../../credentials/index.js';
import { NotFoundError, wrapProviderError } from '../../errors.js';
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
import { ociAuthProvider } from './auth.js';

const DEFAULT_MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const TAG_PREFIX = 'tag_';

async function readAll(reader: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of reader) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** OCI Object Storage. */
export class ObjectStorage implements Storage {
  private readonly client: ObjectStorageClient;
  private readonly namespace: string;
  private readonly compartment: string;
  private readonly region: string;

  constructor(creds: OciCredentials, namespace: string, compartment?: string) {
    const provider = ociAuthProvider(creds);
    this.client = new ObjectStorageClient({ authenticationDetailsProvider: provider });
    if (creds.region) this.client.regionId = creds.region;
    this.namespace = namespace;
    this.compartment = compartment ?? creds.compartmentOcid ?? '';
    this.region = creds.region;
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    const stream = await this.getStream(bucket, key);
    return readAll(stream);
  }

  async getStream(bucket: string, key: string): Promise<Readable> {
    try {
      const resp = await this.client.getObject({ namespaceName: this.namespace, bucketName: bucket, objectName: key });
      return resp.value as unknown as Readable;
    } catch (err) {
      wrapProviderError('oci', 'GetObject', err);
    }
  }

  async put(bucket: string, key: string, data: Buffer | Uint8Array | string, opts?: StoragePutOptions): Promise<void> {
    try {
      const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
      await this.client.putObject({
        namespaceName: this.namespace,
        bucketName: bucket,
        objectName: key,
        contentLength: buffer.length,
        putObjectBody: buffer,
        contentType: opts?.contentType || 'application/octet-stream',
      });
    } catch (err) {
      wrapProviderError('oci', 'PutObject', err);
    }
  }

  async putStream(bucket: string, key: string, reader: Readable, size: number, opts?: StoragePutOptions): Promise<void> {
    try {
      await this.client.putObject({
        namespaceName: this.namespace,
        bucketName: bucket,
        objectName: key,
        contentLength: size,
        putObjectBody: reader,
        contentType: opts?.contentType || 'application/octet-stream',
      });
    } catch (err) {
      wrapProviderError('oci', 'PutObject', err);
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    try {
      await this.client.deleteObject({ namespaceName: this.namespace, bucketName: bucket, objectName: key });
    } catch (err) {
      wrapProviderError('oci', 'DeleteObject', err);
    }
  }

  async list(bucket: string, opts?: StorageListOptions): Promise<StorageObject[]> {
    try {
      const resp = await this.client.listObjects({
        namespaceName: this.namespace,
        bucketName: bucket,
        prefix: opts?.prefix,
        limit: opts?.maxKeys && opts.maxKeys > 0 ? opts.maxKeys : undefined,
        start: opts?.startAfter,
      });
      return (resp.listObjects.objects ?? []).map((obj) => ({
        key: obj.name,
        size: obj.size ?? 0,
        lastModified: obj.timeModified ?? new Date(0),
        etag: obj.etag ?? '',
        contentType: '',
      }));
    } catch (err) {
      wrapProviderError('oci', 'ListObjects', err);
    }
  }

  async head(bucket: string, key: string): Promise<StorageObject> {
    try {
      const resp = await this.client.headObject({ namespaceName: this.namespace, bucketName: bucket, objectName: key });
      return {
        key,
        size: resp.contentLength ?? 0,
        lastModified: resp.lastModified ?? new Date(0),
        etag: resp.eTag ?? '',
        contentType: resp.contentType ?? '',
      };
    } catch (err) {
      wrapProviderError('oci', 'HeadObject', err);
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
      const resp = await this.client.getObject({
        namespaceName: this.namespace,
        bucketName: bucket,
        objectName: key,
        range: new common.Range(offset, offset + length - 1, null),
      });
      return readAll(resp.value as unknown as Readable);
    } catch (err) {
      wrapProviderError('oci', 'GetObject(Range)', err);
    }
  }

  async deleteBulk(bucket: string, keys: string[]): Promise<StorageDeleteError[]> {
    if (keys.length === 0) return [];
    const concurrency = 10;
    const errors: StorageDeleteError[] = [];
    let index = 0;

    const worker = async (): Promise<void> => {
      while (index < keys.length) {
        const key = keys[index++];
        try {
          await this.delete(bucket, key);
        } catch (err) {
          errors.push({ key, code: '', message: err instanceof Error ? err.message : String(err) });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()));
    return errors;
  }

  async copy(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<void> {
    try {
      const resp = await this.client.copyObject({
        namespaceName: this.namespace,
        bucketName: srcBucket,
        copyObjectDetails: {
          sourceObjectName: srcKey,
          destinationRegion: this.region,
          destinationNamespace: this.namespace,
          destinationBucket: dstBucket,
          destinationObjectName: dstKey,
        },
      });
      if (resp.opcWorkRequestId) await this.waitForWorkRequest(resp.opcWorkRequestId);
    } catch (err) {
      wrapProviderError('oci', 'CopyObject', err);
    }
  }

  async move(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<void> {
    if (srcBucket === dstBucket) {
      try {
        await this.client.renameObject({
          namespaceName: this.namespace,
          bucketName: srcBucket,
          renameObjectDetails: { sourceName: srcKey, newName: dstKey },
        });
        return;
      } catch (err) {
        wrapProviderError('oci', 'RenameObject', err);
      }
    }
    await this.copy(srcBucket, srcKey, dstBucket, dstKey);
    await this.delete(srcBucket, srcKey);
  }

  async multipartCreate(bucket: string, key: string, opts?: MultipartCreateOptions): Promise<string> {
    try {
      const resp = await this.client.createMultipartUpload({
        namespaceName: this.namespace,
        bucketName: bucket,
        createMultipartUploadDetails: { object: key, contentType: opts?.contentType },
      });
      return resp.multipartUpload.uploadId;
    } catch (err) {
      wrapProviderError('oci', 'CreateMultipartUpload', err);
    }
  }

  async multipartUploadPart(bucket: string, key: string, uploadId: string, partNumber: number, data: Buffer | Uint8Array): Promise<string> {
    try {
      const buffer = Buffer.from(data);
      const resp = await this.client.uploadPart({
        namespaceName: this.namespace,
        bucketName: bucket,
        objectName: key,
        uploadId,
        uploadPartNum: partNumber,
        uploadPartBody: buffer,
        contentLength: buffer.length,
      });
      return resp.eTag ?? '';
    } catch (err) {
      wrapProviderError('oci', 'UploadPart', err);
    }
  }

  async multipartComplete(bucket: string, key: string, uploadId: string, parts: MultipartPart[]): Promise<void> {
    try {
      await this.client.commitMultipartUpload({
        namespaceName: this.namespace,
        bucketName: bucket,
        objectName: key,
        uploadId,
        commitMultipartUploadDetails: {
          partsToCommit: parts.map((p) => ({ partNum: p.partNumber, etag: p.etag })),
        },
      });
    } catch (err) {
      wrapProviderError('oci', 'CommitMultipartUpload', err);
    }
  }

  async multipartAbort(bucket: string, key: string, uploadId: string): Promise<void> {
    try {
      await this.client.abortMultipartUpload({ namespaceName: this.namespace, bucketName: bucket, objectName: key, uploadId });
    } catch (err) {
      wrapProviderError('oci', 'AbortMultipartUpload', err);
    }
  }

  async upload(bucket: string, key: string, reader: Readable, size: number, opts?: UploadOptions): Promise<void> {
    const threshold = opts?.multipartThreshold && opts.multipartThreshold > 0 ? opts.multipartThreshold : DEFAULT_MULTIPART_THRESHOLD;
    const partSize = opts?.partSize && opts.partSize > 0 ? opts.partSize : DEFAULT_PART_SIZE;

    if (size > 0 && size < threshold) {
      const data = await readAll(reader);
      await this.put(bucket, key, data);
      return;
    }

    const uploadId = await this.multipartCreate(bucket, key);
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
    let startWith: string | undefined;
    try {
      for (;;) {
        const resp = await this.client.listObjects({
          namespaceName: this.namespace,
          bucketName: bucket,
          prefix: opts?.prefix,
          start: startWith,
        });
        for (const obj of resp.listObjects.objects ?? []) {
          allObjects.push({
            key: obj.name,
            size: obj.size ?? 0,
            lastModified: obj.timeModified ?? new Date(0),
            etag: obj.etag ?? '',
            contentType: '',
          });
        }
        if (!resp.listObjects.nextStartWith) break;
        startWith = resp.listObjects.nextStartWith;
      }
    } catch (err) {
      wrapProviderError('oci', 'ListObjects(All)', err);
    }
    return allObjects;
  }

  async presignGet(bucket: string, key: string, expiresInSeconds: number, _opts?: PresignGetOptions): Promise<string> {
    try {
      const resp = await this.client.createPreauthenticatedRequest({
        namespaceName: this.namespace,
        bucketName: bucket,
        createPreauthenticatedRequestDetails: {
          name: `par-get-${key}-${Date.now()}`,
          objectName: key,
          accessType: models.CreatePreauthenticatedRequestDetails.AccessType.ObjectRead,
          timeExpires: new Date(Date.now() + expiresInSeconds * 1000),
        },
      });
      if (!resp.preauthenticatedRequest?.accessUri) {
        throw new NotFoundError('pre-authenticated request returned no access URI');
      }
      return this.parAccessUrl(resp.preauthenticatedRequest.accessUri);
    } catch (err) {
      wrapProviderError('oci', 'CreatePreauthenticatedRequest(Get)', err);
    }
  }

  async presignPut(bucket: string, key: string, expiresInSeconds: number): Promise<string> {
    try {
      const resp = await this.client.createPreauthenticatedRequest({
        namespaceName: this.namespace,
        bucketName: bucket,
        createPreauthenticatedRequestDetails: {
          name: `par-put-${key}-${Date.now()}`,
          objectName: key,
          accessType: models.CreatePreauthenticatedRequestDetails.AccessType.ObjectWrite,
          timeExpires: new Date(Date.now() + expiresInSeconds * 1000),
        },
      });
      if (!resp.preauthenticatedRequest?.accessUri) {
        throw new NotFoundError('pre-authenticated request returned no access URI');
      }
      return this.parAccessUrl(resp.preauthenticatedRequest.accessUri);
    } catch (err) {
      wrapProviderError('oci', 'CreatePreauthenticatedRequest(Put)', err);
    }
  }

  /**
   * Turns the relative access URI a pre-authenticated request returns into an
   * absolute URL against the endpoint this client is talking to.
   */
  private parAccessUrl(accessUri: string): string {
    if (!accessUri) return '';
    if (accessUri.startsWith('http://') || accessUri.startsWith('https://')) return accessUri;

    const endpoint = (this.client as { endpoint?: string }).endpoint ?? '';
    let host = endpoint.replace(/\/+$/, '');
    if (!host) host = `objectstorage.${this.region}.oraclecloud.com`;
    if (!host.startsWith('http://') && !host.startsWith('https://')) host = `https://${host}`;

    const path = accessUri.startsWith('/') ? accessUri : `/${accessUri}`;
    return host + path;
  }

  async getMetadata(bucket: string, key: string): Promise<Record<string, string>> {
    try {
      const resp = await this.client.headObject({ namespaceName: this.namespace, bucketName: bucket, objectName: key });
      return resp.opcMeta ?? {};
    } catch (err) {
      wrapProviderError('oci', 'HeadObject(Metadata)', err);
    }
  }

  async setMetadata(bucket: string, key: string, metadata: Record<string, string>): Promise<void> {
    const prefixed: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) prefixed[`opc-meta-${k}`] = v;

    try {
      const resp = await this.client.copyObject({
        namespaceName: this.namespace,
        bucketName: bucket,
        copyObjectDetails: {
          sourceObjectName: key,
          destinationRegion: this.region,
          destinationNamespace: this.namespace,
          destinationBucket: bucket,
          destinationObjectName: key,
          destinationObjectMetadata: prefixed,
        },
      });
      if (resp.opcWorkRequestId) await this.waitForWorkRequest(resp.opcWorkRequestId);
    } catch (err) {
      wrapProviderError('oci', 'CopyObject(SetMetadata)', err);
    }
  }

  async getTags(bucket: string, key: string): Promise<Record<string, string>> {
    const meta = await this.getMetadata(bucket, key);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k.startsWith(TAG_PREFIX)) tags[k.slice(TAG_PREFIX.length)] = v;
    }
    return tags;
  }

  async setTags(bucket: string, key: string, tags: Record<string, string>): Promise<void> {
    const meta = await this.getMetadata(bucket, key);
    for (const k of Object.keys(meta)) {
      if (k.startsWith(TAG_PREFIX)) delete meta[k];
    }
    for (const [k, v] of Object.entries(tags)) meta[`${TAG_PREFIX}${k}`] = v;
    await this.setMetadata(bucket, key, meta);
  }

  async deleteTags(bucket: string, key: string): Promise<void> {
    await this.setTags(bucket, key, {});
  }

  async createBucket(bucket: string): Promise<void> {
    try {
      await this.client.createBucket({
        namespaceName: this.namespace,
        createBucketDetails: { name: bucket, compartmentId: this.compartment },
      });
    } catch (err) {
      wrapProviderError('oci', 'CreateBucket', err);
    }
  }

  async deleteBucket(bucket: string): Promise<void> {
    try {
      await this.client.deleteBucket({ namespaceName: this.namespace, bucketName: bucket });
    } catch (err) {
      wrapProviderError('oci', 'DeleteBucket', err);
    }
  }

  async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.client.headBucket({ namespaceName: this.namespace, bucketName: bucket });
      return true;
    } catch {
      return false;
    }
  }

  async listBuckets(): Promise<BucketInfo[]> {
    try {
      const resp = await this.client.listBuckets({ namespaceName: this.namespace, compartmentId: this.compartment });
      return resp.items.map((b) => ({ name: b.name, createdAt: b.timeCreated ?? new Date(0), region: '' }));
    } catch (err) {
      wrapProviderError('oci', 'ListBuckets', err);
    }
  }

  supports(_op: StorageOperation): boolean {
    return true;
  }

  provider(): string {
    return 'oci';
  }

  private async waitForWorkRequest(workRequestId: string): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const resp = await this.client.getWorkRequest({ workRequestId });
      if (resp.workRequest.status === models.WorkRequest.Status.Completed) return;
      if (
        resp.workRequest.status === models.WorkRequest.Status.Failed ||
        resp.workRequest.status === models.WorkRequest.Status.Canceled
      ) {
        wrapProviderError('oci', 'WorkRequest', new Error(`work request ${workRequestId} ended with status ${resp.workRequest.status}`));
      }
      await sleep(1000);
    }
    wrapProviderError('oci', 'WorkRequest', new Error(`work request ${workRequestId} did not complete within 30s`));
  }
}
