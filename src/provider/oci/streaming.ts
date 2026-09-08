import type * as common from 'oci-common';
import { models, StreamAdminClient, StreamClient } from 'oci-streaming';

import type { OciCredentials } from '../../credentials/index.js';
import { ValidationError, wrapProviderError } from '../../errors.js';
import type {
  GetRecordsOptions,
  StreamCreateOptions,
  StreamInfo,
  Streaming,
  StreamRecord,
} from '../types/streaming.js';
import { ociAuthProvider } from './auth.js';

function bufferOf(v: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

/**
 * OCI Streaming, using cursor-based consumer groups. Each stream carries its own
 * data-plane messages endpoint, resolved from the admin client before produce or
 * consume can happen.
 */
export class OciStreaming implements Streaming {
  private readonly adminClient: StreamAdminClient;
  private readonly authProvider: common.AuthenticationDetailsProvider;
  private readonly compartment: string;
  /**
   * Committed offsets keyed by stream|group|partition. OCI group cursors can only
   * be created at LATEST, TRIM_HORIZON or a time, so a specific (partition,
   * offset) commit is tracked here and replayed by getRecords — the same
   * emulation the Kinesis provider uses. No lock is needed: JS is single-threaded.
   */
  private readonly committed = new Map<string, number>();

  constructor(creds: OciCredentials, compartment: string) {
    this.authProvider = ociAuthProvider(creds);
    this.adminClient = new StreamAdminClient({ authenticationDetailsProvider: this.authProvider });
    if (creds.region) this.adminClient.regionId = creds.region;
    this.compartment = compartment || creds.compartmentOcid || '';
  }

  private async streamClient(streamId: string): Promise<StreamClient> {
    let messagesEndpoint: string | undefined;
    try {
      const resp = await this.adminClient.getStream({ streamId });
      messagesEndpoint = resp.stream.messagesEndpoint;
    } catch (err) {
      return wrapProviderError('oci', 'GetStream', err);
    }
    const client = new StreamClient({ authenticationDetailsProvider: this.authProvider });
    client.endpoint = messagesEndpoint;
    return client;
  }

  /** Creates a new stream and returns its OCID. */
  async createStream(name: string, opts?: StreamCreateOptions): Promise<string> {
    const partitions = opts?.partitions && opts.partitions > 0 ? opts.partitions : 1;
    let retentionHours = 24;
    if (opts?.retentionMs && opts.retentionMs > 0) {
      retentionHours = Math.floor(opts.retentionMs / (60 * 60 * 1000));
      if (retentionHours < 1) retentionHours = 1;
    }
    try {
      const resp = await this.adminClient.createStream({
        createStreamDetails: {
          compartmentId: this.compartment,
          name,
          partitions,
          retentionInHours: retentionHours,
        },
      });
      return resp.stream.id;
    } catch (err) {
      return wrapProviderError('oci', 'CreateStream', err);
    }
  }

  /** Deletes a stream by OCID. */
  async deleteStream(streamId: string): Promise<void> {
    try {
      await this.adminClient.deleteStream({ streamId });
    } catch (err) {
      wrapProviderError('oci', 'DeleteStream', err);
    }
  }

  /** Lists all streams in the compartment. */
  async listStreams(): Promise<StreamInfo[]> {
    const streams: StreamInfo[] = [];
    let page: string | undefined;
    try {
      do {
        const resp = await this.adminClient.listStreams({ compartmentId: this.compartment, page });
        for (const st of resp.items) {
          streams.push({
            id: st.id,
            name: st.name,
            partitions: st.partitions ?? 0,
            status: st.lifecycleState,
            retentionMs: 0,
          });
        }
        page = resp.opcNextPage;
      } while (page);
    } catch (err) {
      wrapProviderError('oci', 'ListStreams', err);
    }
    return streams;
  }

  /** Reads details for a specific stream. */
  async getStream(streamId: string): Promise<StreamInfo> {
    try {
      const resp = await this.adminClient.getStream({ streamId });
      return {
        id: resp.stream.id,
        name: resp.stream.name,
        partitions: resp.stream.partitions ?? 0,
        status: resp.stream.lifecycleState,
        retentionMs: resp.stream.retentionInHours ? resp.stream.retentionInHours * 60 * 60 * 1000 : 0,
      };
    } catch (err) {
      return wrapProviderError('oci', 'GetStream', err);
    }
  }

  /** Publishes records to a stream. */
  async putRecords(streamId: string, records: StreamRecord[]): Promise<void> {
    const dataClient = await this.streamClient(streamId);
    try {
      const messages = records.map((r) => ({
        value: bufferOf(r.value).toString('base64'),
        key: r.key && r.key.length > 0 ? bufferOf(r.key).toString('base64') : undefined,
      }));
      await dataClient.putMessages({ streamId, putMessagesDetails: { messages } });
    } catch (err) {
      wrapProviderError('oci', 'PutMessages', err);
    } finally {
      dataClient.close();
    }
  }

  /** Consumes records from a stream partition via a cursor. */
  async getRecords(streamId: string, opts: GetRecordsOptions): Promise<StreamRecord[]> {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
    const partition = opts.partition ?? 0;
    const dataClient = await this.streamClient(streamId);
    try {
      let resumeFrom = opts.offset ?? 0;
      if (resumeFrom <= 0 && opts.consumerGroup) {
        resumeFrom = this.committed.get(offsetKey(streamId, opts.consumerGroup, partition)) ?? 0;
      }

      const cursorDetails: models.CreateCursorDetails =
        resumeFrom > 0
          ? {
              partition: String(partition),
              type: models.CreateCursorDetails.Type.AfterOffset,
              offset: resumeFrom,
            }
          : { partition: String(partition), type: models.CreateCursorDetails.Type.TrimHorizon };

      const cursorResp = await dataClient.createCursor({ streamId, createCursorDetails: cursorDetails });
      const getResp = await dataClient.getMessages({ streamId, cursor: cursorResp.cursor.value, limit });

      return (getResp.items ?? []).map((msg) => ({
        key: msg.key ? Buffer.from(msg.key, 'base64') : undefined,
        value: msg.value ? Buffer.from(msg.value, 'base64') : Buffer.alloc(0),
        partition: msg.partition ? Number.parseInt(msg.partition, 10) : partition,
        offset: msg.offset ?? 0,
        timestamp: msg.timestamp,
      }));
    } catch (err) {
      return wrapProviderError('oci', 'GetMessages', err);
    } finally {
      dataClient.close();
    }
  }

  /** No-op: OCI Streaming consumer groups are created implicitly on first cursor use. */
  async createConsumerGroup(_streamId: string, _groupName: string): Promise<void> {}

  /** Clears the emulated checkpoints for a group; OCI groups are not resources. */
  async deleteConsumerGroup(streamId: string, groupName: string): Promise<void> {
    const prefix = `${streamId}|${groupName}|`;
    for (const key of this.committed.keys()) {
      if (key.startsWith(prefix)) this.committed.delete(key);
    }
  }

  /**
   * Records the group's position for a partition. OCI group cursors cannot encode
   * an offset, so the checkpoint is tracked here and applied by getRecords when
   * the same consumer group reads again.
   */
  async commitOffset(streamId: string, groupName: string, partition: number, offset: number): Promise<void> {
    if (!groupName) {
      throw new ValidationError('groupName', 'is required to commit an offset');
    }
    this.committed.set(offsetKey(streamId, groupName, partition), offset);
  }
}

/** Identifies one partition's checkpoint within a consumer group. */
function offsetKey(streamId: string, group: string, partition: number): string {
  return `${streamId}|${group}|${partition}`;
}
