/** Desired state of a CDN distribution. */
export interface CdnDistributionOptions {
  /** Backend origin host the CDN pulls from. Required on create. */
  originDomain: string;
  comment?: string;
  /** Whether the distribution serves traffic. */
  enabled?: boolean;
  /** e.g. "index.html". */
  defaultRootObject?: string;
}

/** Provider-agnostic view of a distribution. */
export interface CdnDistribution {
  id: string;
  /** CDN-provided hostname clients use. */
  domainName: string;
  originDomain: string;
  status: string;
  enabled: boolean;
  comment: string;
}

/** Provider-agnostic view of a cache invalidation/purge. */
export interface CdnInvalidation {
  id: string;
  status: string;
  paths: string[];
  createdAt: Date;
}

/**
 * Unified content delivery network. Maps to AWS CloudFront and Azure Front Door.
 * OCI has no native CDN, so its implementation throws UnsupportedError.
 */
export interface Cdn {
  /** Creates a distribution. */
  createDistribution(opts: CdnDistributionOptions): Promise<CdnDistribution>;

  /** Reads a distribution. */
  getDistribution(id: string): Promise<CdnDistribution>;

  /** Lists distributions. */
  listDistributions(): Promise<CdnDistribution[]>;

  /** Updates a distribution. */
  updateDistribution(id: string, opts: CdnDistributionOptions): Promise<CdnDistribution>;

  /** Deletes a distribution. */
  deleteDistribution(id: string): Promise<void>;

  /** Enables a distribution. */
  enableDistribution(id: string): Promise<void>;

  /** Disables a distribution. */
  disableDistribution(id: string): Promise<void>;

  /** Starts a cache invalidation and returns its id. */
  createInvalidation(id: string, paths: string[]): Promise<string>;

  /** Reads one invalidation. */
  getInvalidation(id: string, invalidationId: string): Promise<CdnInvalidation>;

  /** Lists invalidations for a distribution. */
  listInvalidations(id: string): Promise<CdnInvalidation[]>;
}
