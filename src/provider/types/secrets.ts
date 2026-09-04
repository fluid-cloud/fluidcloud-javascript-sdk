/** A secrets operation, for capability introspection via supports(). */
export type SecretsOperation =
  | 'get'
  | 'get_version'
  | 'get_binary'
  | 'put'
  | 'put_binary'
  | 'delete'
  | 'list'
  | 'list_versions'
  | 'restore'
  | 'rotate';

export interface Secret {
  name: string;
  value: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
  description: string;
  tags: Record<string, string>;
}

export interface SecretMetadata {
  name: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
  description: string;
  tags: Record<string, string>;
}

export interface SecretVersionMetadata {
  version: string;
  /** "current", "previous", "deprecated" or "pending_deletion". */
  status: string;
  createdAt: Date;
}

export interface SecretsPutOptions {
  description?: string;
  tags?: Record<string, string>;
}

/** Unified cloud secrets management. */
export interface Secrets {
  /** Retrieves a secret value by name. */
  get(name: string): Promise<string>;

  /** Retrieves a secret with its metadata. */
  getWithMetadata(name: string): Promise<Secret>;

  /** Creates or updates a secret. */
  put(name: string, value: string, opts?: SecretsPutOptions): Promise<void>;

  /** Removes a secret. */
  delete(name: string): Promise<void>;

  /** Lists all secrets, metadata only. */
  list(): Promise<SecretMetadata[]>;

  /** Reports whether a secret exists. */
  exists(name: string): Promise<boolean>;

  /** Retrieves a specific version of a secret. */
  getVersion(name: string, version: string): Promise<string>;

  /** Lists all versions of a secret. */
  listVersions(name: string): Promise<SecretVersionMetadata[]>;

  /** Creates or updates a secret holding binary data. */
  putBinary(name: string, data: Buffer | Uint8Array, opts?: SecretsPutOptions): Promise<void>;

  /** Retrieves a secret as binary data. */
  getBinary(name: string): Promise<Buffer>;

  /** Recovers a soft-deleted secret. OCI requires PENDING_DELETION state. */
  restore(name: string): Promise<void>;

  /** Triggers rotation. AWS is native; others write a new version. */
  rotateSecret(name: string): Promise<void>;

  /** Reports whether this provider implements the operation. */
  supports(op: SecretsOperation): boolean;

  /** Returns the provider name, e.g. "aws". */
  provider(): string;
}
