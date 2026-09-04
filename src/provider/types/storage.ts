import type { Readable } from 'node:stream';

/** A storage operation, for capability introspection via supports(). */
export type StorageOperation =
  | 'get'
  | 'get_range'
  | 'put'
  | 'delete'
  | 'delete_bulk'
  | 'list'
  | 'list_all'
  | 'head'
  | 'copy'
  | 'move'
  | 'multipart'
  | 'upload'
  | 'presign_get'
  | 'presign_put'
  | 'get_metadata'
  | 'set_metadata'
  | 'get_tags'
  | 'set_tags'
  | 'delete_tags'
  | 'create_bucket'
  | 'delete_bucket'
  | 'bucket_exists'
  | 'list_buckets';

export interface StorageObject {
  key: string;
  size: number;
  lastModified: Date;
  etag: string;
  contentType: string;
}

export interface StorageListOptions {
  prefix?: string;
  maxKeys?: number;
  startAfter?: string;
}

export interface StoragePutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface StorageDeleteError {
  key: string;
  code: string;
  message: string;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface MultipartCreateOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  /** Bytes above which multipart is used. Default 64 MiB. */
  multipartThreshold?: number;
  /** Part size in bytes. Default 8 MiB. */
  partSize?: number;
}

export interface PresignGetOptions {
  /**
   * When set, the download saves under this name via Content-Disposition.
   * Honored by AWS S3; ignored where the presign mechanism has no
   * response-header override.
   */
  filename?: string;
}

export interface BucketInfo {
  name: string;
  createdAt: Date;
  region: string;
}

/** Unified cloud object storage. All durations are in seconds. */
export interface Storage {
  // --- Object operations ---

  /** Retrieves an object in full. */
  get(bucket: string, key: string): Promise<Buffer>;

  /** Retrieves an object as a stream. The caller destroys the stream. */
  getStream(bucket: string, key: string): Promise<Readable>;

  /** Stores an object. */
  put(bucket: string, key: string, data: Buffer | Uint8Array | string, opts?: StoragePutOptions): Promise<void>;

  /** Stores an object from a stream of known length. */
  putStream(bucket: string, key: string, reader: Readable, size: number, opts?: StoragePutOptions): Promise<void>;

  /** Removes an object. */
  delete(bucket: string, key: string): Promise<void>;

  /** Lists objects under a prefix, one page. */
  list(bucket: string, opts?: StorageListOptions): Promise<StorageObject[]>;

  /** Retrieves object metadata without downloading the body. */
  head(bucket: string, key: string): Promise<StorageObject>;

  /** Reports whether an object exists. */
  exists(bucket: string, key: string): Promise<boolean>;

  /** Retrieves a byte range of an object. */
  getRange(bucket: string, key: string, offset: number, length: number): Promise<Buffer>;

  /** Deletes many objects, returning per-key failures. */
  deleteBulk(bucket: string, keys: string[]): Promise<StorageDeleteError[]>;

  /** Server-side copy. */
  copy(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<void>;

  /** Moves an object (native rename on OCI, copy + delete elsewhere). */
  move(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<void>;

  // --- Multipart upload ---

  /** Initiates a multipart upload and returns the upload ID. */
  multipartCreate(bucket: string, key: string, opts?: MultipartCreateOptions): Promise<string>;

  /** Uploads one part and returns its ETag. */
  multipartUploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    data: Buffer | Uint8Array,
  ): Promise<string>;

  /** Completes a multipart upload. */
  multipartComplete(bucket: string, key: string, uploadId: string, parts: MultipartPart[]): Promise<void>;

  /** Aborts a multipart upload. Azure is a no-op; uncommitted blocks expire. */
  multipartAbort(bucket: string, key: string, uploadId: string): Promise<void>;

  /** High-level upload that picks single PUT or multipart by size. */
  upload(bucket: string, key: string, reader: Readable, size: number, opts?: UploadOptions): Promise<void>;

  // --- Listing ---

  /** Auto-paginates and returns every matching object. */
  listAll(bucket: string, opts?: StorageListOptions): Promise<StorageObject[]>;

  // --- Presigned URLs ---

  /** Generates a presigned/SAS download URL valid for expiresInSeconds. */
  presignGet(bucket: string, key: string, expiresInSeconds: number, opts?: PresignGetOptions): Promise<string>;

  /** Generates a presigned/SAS upload URL valid for expiresInSeconds. */
  presignPut(bucket: string, key: string, expiresInSeconds: number): Promise<string>;

  // --- Metadata and tagging ---

  /** Retrieves user-defined metadata. */
  getMetadata(bucket: string, key: string): Promise<Record<string, string>>;

  /** Sets user-defined metadata. AWS copies to self with REPLACE. */
  setMetadata(bucket: string, key: string, metadata: Record<string, string>): Promise<void>;

  /** Retrieves object tags. OCI emulates them with 'tag_' prefixed metadata. */
  getTags(bucket: string, key: string): Promise<Record<string, string>>;

  /** Sets object tags. OCI emulates them with 'tag_' prefixed metadata. */
  setTags(bucket: string, key: string, tags: Record<string, string>): Promise<void>;

  /** Removes all object tags. */
  deleteTags(bucket: string, key: string): Promise<void>;

  // --- Bucket operations ---

  /** Creates a bucket/container. */
  createBucket(bucket: string): Promise<void>;

  /** Deletes an empty bucket/container. */
  deleteBucket(bucket: string): Promise<void>;

  /** Reports whether a bucket/container exists. */
  bucketExists(bucket: string): Promise<boolean>;

  /** Lists all buckets/containers. */
  listBuckets(): Promise<BucketInfo[]>;

  // --- Introspection ---

  /** Reports whether this provider implements the operation. */
  supports(op: StorageOperation): boolean;

  /** Returns the provider name, e.g. "aws". */
  provider(): string;
}
