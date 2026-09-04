export interface StreamInfo {
  id: string;
  name: string;
  partitions: number;
  status: string;
  retentionMs: number;
}

export interface StreamRecord {
  key?: Buffer | Uint8Array;
  value: Buffer | Uint8Array;
  partition?: number;
  offset?: number;
  timestamp?: Date;
}

export interface StreamCreateOptions {
  partitions?: number;
  retentionMs?: number;
}

export interface GetRecordsOptions {
  partition?: number;
  offset?: number;
  limit?: number;
  consumerGroup?: string;
}

/**
 * Unified event streaming. Native on Azure Event Hubs and OCI Streaming; AWS
 * defaults to Kinesis with MSK opt-in; GCP maps to Pub/Sub, where partitions and
 * offsets do not exist.
 */
export interface Streaming {
  /** Creates a stream and returns its provider id. */
  createStream(name: string, opts?: StreamCreateOptions): Promise<string>;

  /** Deletes a stream. */
  deleteStream(streamId: string): Promise<void>;

  /** Lists streams. */
  listStreams(): Promise<StreamInfo[]>;

  /** Reads one stream. */
  getStream(streamId: string): Promise<StreamInfo>;

  /** Produces records. */
  putRecords(streamId: string, records: StreamRecord[]): Promise<void>;

  /** Consumes records. */
  getRecords(streamId: string, opts: GetRecordsOptions): Promise<StreamRecord[]>;

  /** Creates a consumer group. */
  createConsumerGroup(streamId: string, groupName: string): Promise<void>;

  /** Deletes a consumer group. */
  deleteConsumerGroup(streamId: string, groupName: string): Promise<void>;

  /** Commits a consumer-group offset. Azure is a no-op; GCP is unsupported. */
  commitOffset(streamId: string, groupName: string, partition: number, offset: number): Promise<void>;
}
