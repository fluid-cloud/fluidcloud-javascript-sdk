export interface AuditEvent {
  id: string;
  name: string;
  time: Date;
  username: string;
  resourceId: string;
  resourceType: string;
  region: string;
  raw: Record<string, unknown>;
}

export interface LookupEventsOptions {
  startTime?: Date;
  endTime?: Date;
  maxResults?: number;
  resourceName?: string;
  resourceType?: string;
}

export interface TrailOptions {
  s3BucketName: string;
  isMultiRegion?: boolean;
}

export interface TrailInfo {
  name: string;
  s3BucketName: string;
  isMultiRegion: boolean;
}

export interface TrailStatus {
  isLogging: boolean;
  latestDeliveryTime: Date;
}

/** Unified control-plane audit logging. */
export interface Audit {
  /** Looks up audit events in a time window. */
  lookupEvents(opts?: LookupEventsOptions): Promise<AuditEvent[]>;

  /** Creates an audit trail. */
  createTrail(name: string, opts: TrailOptions): Promise<void>;

  /** Deletes an audit trail. */
  deleteTrail(name: string): Promise<void>;

  /** Lists audit trails. */
  listTrails(): Promise<TrailInfo[]>;

  /** Reads delivery status for a trail. */
  getTrailStatus(name: string): Promise<TrailStatus>;
}
