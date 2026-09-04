/** A parameters operation, for capability introspection via supports(). */
export type ParametersOperation =
  | 'get'
  | 'get_metadata'
  | 'get_version'
  | 'put'
  | 'delete'
  | 'list'
  | 'list_versions'
  | 'exists';

export interface Parameter {
  name: string;
  value: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
  description: string;
  tags: Record<string, string>;
}

export interface ParameterMetadata {
  name: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
  description: string;
  tags: Record<string, string>;
}

export interface ParameterVersionMetadata {
  version: string;
  /** "current", "previous", "enabled" or "disabled". */
  status: string;
  createdAt: Date;
}

export interface ParametersPutOptions {
  description?: string;
  tags?: Record<string, string>;
  /**
   * Stores the value encrypted at rest where the provider distinguishes secure
   * values (AWS writes a SecureString). Providers without the concept ignore it.
   */
  secure?: boolean;
}

/**
 * Unified configuration store. AWS backs it with SSM Parameter Store, Azure with
 * App Configuration, GCP with Parameter Manager; OCI has no native equivalent and
 * serves parameters from Vault secrets.
 */
export interface Parameters {
  /** Retrieves a parameter value by name. */
  get(name: string): Promise<string>;

  /** Retrieves a parameter with its metadata. */
  getWithMetadata(name: string): Promise<Parameter>;

  /** Creates or updates a parameter. */
  put(name: string, value: string, opts?: ParametersPutOptions): Promise<void>;

  /** Removes a parameter. */
  delete(name: string): Promise<void>;

  /** Lists all parameters, metadata only. */
  list(): Promise<ParameterMetadata[]>;

  /** Reports whether a parameter exists. */
  exists(name: string): Promise<boolean>;

  /** Retrieves a specific version of a parameter. */
  getVersion(name: string, version: string): Promise<string>;

  /** Lists all versions of a parameter. */
  listVersions(name: string): Promise<ParameterVersionMetadata[]>;

  /** Reports whether this provider implements the operation. */
  supports(op: ParametersOperation): boolean;

  /** Returns the provider name, e.g. "aws". */
  provider(): string;
}
