import { PubSub, v1 } from '@google-cloud/pubsub';

import type { GcpCredentials } from '../../credentials/index.js';
import { InvalidCredentialsError, NotFoundError, UnsupportedError, wrapProviderError } from '../../errors.js';
import type {
  GetRecordsOptions,
  StreamCreateOptions,
  StreamInfo,
  StreamRecord,
  Streaming,
} from '../types/streaming.js';
import { gcpClientConfig } from './auth.js';

function bufferOf(v: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

function shortId(fullName: string): string {
  return fullName.split('/').pop() ?? fullName;
}

/**
 * GCP Pub/Sub streaming. A stream is a topic; a consumer group is a subscription.
 * Pub/Sub has no partitions or offsets, so StreamRecord.partition/offset are left
 * unpopulated and commitOffset is unsupported: consumption is ack-based via getRecords.
 */
export class PubSubStreaming implements Streaming {
  private readonly client: PubSub;
  private readonly subClient: v1.SubscriberClient;
  private readonly projectId: string;

  constructor(creds: GcpCredentials) {
    const cfg = gcpClientConfig(creds);
    this.client = new PubSub(cfg);
    this.subClient = new v1.SubscriberClient({ projectId: cfg.projectId, credentials: cfg.credentials });
    this.projectId = creds.projectId;
  }

  /** Creates a Pub/Sub topic. */
  async createStream(name: string, _opts?: StreamCreateOptions): Promise<string> {
    try {
      const [topic] = await this.client.createTopic(name);
      return shortId(topic.name);
    } catch (err) {
      return wrapProviderError('gcp', 'CreateStream', err);
    }
  }

  /** Deletes a Pub/Sub topic. */
  async deleteStream(streamId: string): Promise<void> {
    try {
      await this.client.topic(streamId).delete();
    } catch (err) {
      wrapProviderError('gcp', 'DeleteStream', err);
    }
  }

  /** Lists Pub/Sub topics in the project. */
  async listStreams(): Promise<StreamInfo[]> {
    try {
      const [topics] = await this.client.getTopics();
      return topics.map((t) => {
        const id = shortId(t.name);
        return { id, name: id, partitions: 0, status: 'active', retentionMs: 0 };
      });
    } catch (err) {
      return wrapProviderError('gcp', 'ListStreams', err);
    }
  }

  /** Reads a Pub/Sub topic, throwing NotFoundError if it does not exist. */
  async getStream(streamId: string): Promise<StreamInfo> {
    try {
      const [exists] = await this.client.topic(streamId).exists();
      if (!exists) throw new NotFoundError(`stream "${streamId}" not found`);
      return { id: streamId, name: streamId, partitions: 0, status: 'active', retentionMs: 0 };
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('gcp', 'GetStream', err);
    }
  }

  /** Publishes records to a Pub/Sub topic. */
  async putRecords(streamId: string, records: StreamRecord[]): Promise<void> {
    const topic = this.client.topic(streamId);
    try {
      for (const r of records) {
        const attributes = r.key && r.key.length > 0 ? { key: bufferOf(r.key).toString() } : undefined;
        await topic.publishMessage({ data: bufferOf(r.value), attributes });
      }
    } catch (err) {
      wrapProviderError('gcp', 'PutRecords', err);
    }
  }

  /** Pulls and acknowledges records from the consumer-group subscription. */
  async getRecords(streamId: string, opts: GetRecordsOptions): Promise<StreamRecord[]> {
    if (!opts.consumerGroup) {
      throw new InvalidCredentialsError('ConsumerGroup (subscription) is required for GCP GetRecords');
    }
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
    const subscription = this.subClient.subscriptionPath(this.projectId, opts.consumerGroup);
    try {
      const [resp] = await this.subClient.pull({ subscription, maxMessages: limit });
      const ackIds: string[] = [];
      const records: StreamRecord[] = [];
      for (const rm of resp.receivedMessages ?? []) {
        if (rm.ackId) ackIds.push(rm.ackId);
        const msg = rm.message;
        const record: StreamRecord = { value: msg?.data ? bufferOf(msg.data as Buffer | Uint8Array) : Buffer.alloc(0) };
        const key = msg?.attributes?.key;
        if (typeof key === 'string') record.key = Buffer.from(key);
        if (msg?.publishTime) {
          const seconds = Number(msg.publishTime.seconds ?? 0);
          const nanos = Number(msg.publishTime.nanos ?? 0);
          record.timestamp = new Date(seconds * 1000 + nanos / 1e6);
        }
        records.push(record);
      }
      if (ackIds.length > 0) {
        try {
          await this.subClient.acknowledge({ subscription, ackIds });
        } catch {}
      }
      return records;
    } catch (err) {
      return wrapProviderError('gcp', 'GetRecords', err);
    }
  }

  /** Creates a subscription on a Pub/Sub topic as the consumer group. */
  async createConsumerGroup(streamId: string, groupName: string): Promise<void> {
    try {
      await this.client.createSubscription(streamId, groupName);
    } catch (err) {
      wrapProviderError('gcp', 'CreateConsumerGroup', err);
    }
  }

  /** Deletes a Pub/Sub subscription. */
  async deleteConsumerGroup(_streamId: string, groupName: string): Promise<void> {
    try {
      await this.client.subscription(groupName).delete();
    } catch (err) {
      wrapProviderError('gcp', 'DeleteConsumerGroup', err);
    }
  }

  /** Unsupported: Pub/Sub has no partition offsets, only acknowledgement. */
  async commitOffset(_streamId: string, _groupName: string, _partition: number, _offset: number): Promise<void> {
    throw new UnsupportedError(
      'gcp',
      'commitOffset',
      'Pub/Sub has no partition offsets.',
      'Messages are acknowledged on consumption via getRecords.',
    );
  }
}
