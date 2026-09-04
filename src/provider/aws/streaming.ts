import { randomUUID } from 'node:crypto';

import {
  CreateStreamCommand,
  DeleteStreamCommand,
  DescribeStreamSummaryCommand,
  GetRecordsCommand,
  GetShardIteratorCommand,
  IncreaseStreamRetentionPeriodCommand,
  KinesisClient,
  ListShardsCommand,
  ListStreamsCommand,
  PutRecordsCommand,
  ShardIteratorType,
  waitUntilStreamExists,
  type Shard,
} from '@aws-sdk/client-kinesis';
import { Kafka } from 'kafkajs';

import type { AwsCredentials } from '../../credentials/index.js';
import { InvalidCredentialsError, wrapProviderError } from '../../errors.js';
import type {
  GetRecordsOptions,
  StreamCreateOptions,
  StreamInfo,
  StreamRecord,
  Streaming,
} from '../types/streaming.js';
import { awsClientConfig } from './auth.js';

function bufferOf(v: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

function checkpointKey(streamId: string, group: string, partition: number): string {
  return `${streamId}|${group}|${partition}`;
}

/**
 * AWS Kinesis Data Streams streaming, the default AWS backing for Streaming (MSK is
 * opt-in via bootstrap servers). Positions are opaque Kinesis sequence numbers, not
 * numeric offsets, so consumer groups and commitOffset are emulated: getRecords with
 * a consumerGroup resumes after that group's last committed sequence number, and
 * commitOffset persists the most recently read sequence number in memory.
 */
export class KinesisStreaming implements Streaming {
  private readonly client: KinesisClient;
  private readonly committed = new Map<string, string>();
  private readonly pending = new Map<string, string>();

  constructor(creds: AwsCredentials, region?: string) {
    this.client = new KinesisClient(awsClientConfig(creds, region));
  }

  /** Creates a Kinesis data stream; partitions maps to shard count. */
  async createStream(name: string, opts?: StreamCreateOptions): Promise<string> {
    const shardCount = opts?.partitions && opts.partitions > 0 ? opts.partitions : 1;
    const retentionMs = opts?.retentionMs ?? 0;
    try {
      await this.client.send(new CreateStreamCommand({ StreamName: name, ShardCount: shardCount }));
    } catch (err) {
      wrapProviderError('aws', 'CreateStream', err);
    }

    const retentionHours = Math.floor(retentionMs / (60 * 60 * 1000));
    if (retentionHours > 24) {
      try {
        await waitUntilStreamExists({ client: this.client, maxWaitTime: 120 }, { StreamName: name });
        await this.client.send(
          new IncreaseStreamRetentionPeriodCommand({ StreamName: name, RetentionPeriodHours: retentionHours }),
        );
      } catch (err) {
        wrapProviderError('aws', 'IncreaseStreamRetentionPeriod', err);
      }
    }
    return name;
  }

  /** Deletes a Kinesis data stream. */
  async deleteStream(streamId: string): Promise<void> {
    try {
      await this.client.send(new DeleteStreamCommand({ StreamName: streamId }));
    } catch (err) {
      wrapProviderError('aws', 'DeleteStream', err);
    }
  }

  /** Lists Kinesis data streams in the region. */
  async listStreams(): Promise<StreamInfo[]> {
    const streams: StreamInfo[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.client.send(new ListStreamsCommand({ NextToken: nextToken }));
        for (const summary of out.StreamSummaries ?? []) {
          streams.push({
            id: summary.StreamName ?? '',
            name: summary.StreamName ?? '',
            partitions: 0,
            status: summary.StreamStatus ?? '',
            retentionMs: 0,
          });
        }
        nextToken = out.NextToken || undefined;
      } while (nextToken);
    } catch (err) {
      wrapProviderError('aws', 'ListStreams', err);
    }
    return streams;
  }

  /** Reads details for a specific Kinesis data stream. */
  async getStream(streamId: string): Promise<StreamInfo> {
    try {
      const out = await this.client.send(new DescribeStreamSummaryCommand({ StreamName: streamId }));
      const d = out.StreamDescriptionSummary;
      return {
        id: d?.StreamName ?? '',
        name: d?.StreamName ?? '',
        status: d?.StreamStatus ?? '',
        partitions: d?.OpenShardCount ?? 0,
        retentionMs: d?.RetentionPeriodHours ? d.RetentionPeriodHours * 60 * 60 * 1000 : 0,
      };
    } catch (err) {
      return wrapProviderError('aws', 'DescribeStreamSummary', err);
    }
  }

  /** Produces records to a Kinesis data stream. */
  async putRecords(streamId: string, records: StreamRecord[]): Promise<void> {
    if (records.length === 0) return;
    const entries = records.map((r, i) => ({
      Data: bufferOf(r.value),
      PartitionKey: r.key && r.key.length > 0 ? bufferOf(r.key).toString() : `pk-${i}`,
    }));
    try {
      const out = await this.client.send(new PutRecordsCommand({ StreamName: streamId, Records: entries }));
      if (out.FailedRecordCount && out.FailedRecordCount > 0) {
        wrapProviderError(
          'aws',
          'PutRecords',
          new Error(`${out.FailedRecordCount} of ${records.length} records failed`),
        );
      }
    } catch (err) {
      wrapProviderError('aws', 'PutRecords', err);
    }
  }

  private async shardIdAt(streamId: string, index: number): Promise<string> {
    const shards: Shard[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.client.send(
          nextToken
            ? new ListShardsCommand({ NextToken: nextToken })
            : new ListShardsCommand({ StreamName: streamId }),
        );
        shards.push(...(out.Shards ?? []));
        nextToken = out.NextToken || undefined;
      } while (nextToken);
    } catch (err) {
      return wrapProviderError('aws', 'ListShards', err);
    }
    if (shards.length === 0) {
      return wrapProviderError('aws', 'ListShards', new Error(`stream "${streamId}" has no shards`));
    }
    shards.sort((a, b) => (a.ShardId ?? '').localeCompare(b.ShardId ?? ''));
    if (index < 0 || index >= shards.length) {
      return wrapProviderError(
        'aws',
        'ListShards',
        new Error(`partition ${index} out of range (stream has ${shards.length} shards)`),
      );
    }
    return shards[index]?.ShardId ?? '';
  }

  /**
   * Consumes records from a shard. When opts.consumerGroup is set, consumption
   * resumes after that group's last committed sequence number (emulated
   * checkpointing); otherwise it starts from the trim horizon. opts.offset is not
   * used as a Kinesis position.
   */
  async getRecords(streamId: string, opts: GetRecordsOptions): Promise<StreamRecord[]> {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
    const partition = opts.partition ?? 0;
    const shardId = await this.shardIdAt(streamId, partition);

    let iteratorType: ShardIteratorType = ShardIteratorType.TRIM_HORIZON;
    let startingSequenceNumber: string | undefined;
    if (opts.consumerGroup) {
      const seq = this.committed.get(checkpointKey(streamId, opts.consumerGroup, partition));
      if (seq) {
        iteratorType = ShardIteratorType.AFTER_SEQUENCE_NUMBER;
        startingSequenceNumber = seq;
      }
    }

    let shardIterator: string | undefined;
    try {
      const iterOut = await this.client.send(
        new GetShardIteratorCommand({
          StreamName: streamId,
          ShardId: shardId,
          ShardIteratorType: iteratorType,
          StartingSequenceNumber: startingSequenceNumber,
        }),
      );
      shardIterator = iterOut.ShardIterator;
    } catch (err) {
      return wrapProviderError('aws', 'GetShardIterator', err);
    }

    let recordsOut;
    try {
      recordsOut = await this.client.send(new GetRecordsCommand({ ShardIterator: shardIterator, Limit: limit }));
    } catch (err) {
      return wrapProviderError('aws', 'GetRecords', err);
    }

    const records: StreamRecord[] = [];
    let lastSeq: string | undefined;
    for (const r of recordsOut.Records ?? []) {
      records.push({
        key: Buffer.from(r.PartitionKey ?? ''),
        value: r.Data ? Buffer.from(r.Data) : Buffer.alloc(0),
        partition,
        timestamp: r.ApproximateArrivalTimestamp,
      });
      lastSeq = r.SequenceNumber;
    }

    if (opts.consumerGroup && lastSeq) {
      this.pending.set(checkpointKey(streamId, opts.consumerGroup, partition), lastSeq);
    }

    return records;
  }

  /** No-op: consumer groups are tracked implicitly on first read/commit. */
  async createConsumerGroup(_streamId: string, _groupName: string): Promise<void> {}

  /** Clears the emulated checkpoint state for the group. */
  async deleteConsumerGroup(streamId: string, groupName: string): Promise<void> {
    const prefix = `${streamId}|${groupName}|`;
    for (const key of this.committed.keys()) {
      if (key.startsWith(prefix)) this.committed.delete(key);
    }
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) this.pending.delete(key);
    }
  }

  /** Checkpoints the most recently read sequence number for the group on the given partition. */
  async commitOffset(streamId: string, groupName: string, partition: number, _offset: number): Promise<void> {
    const key = checkpointKey(streamId, groupName, partition);
    const seq = this.pending.get(key);
    if (!seq) return;
    this.committed.set(key, seq);
  }
}

/**
 * AWS MSK (Managed Streaming for Kafka) streaming, reached over the standard Kafka
 * protocol against the given bootstrap brokers. Opt into this instead of the
 * default Kinesis backing by supplying bootstrapServers.
 */
export class MskStreaming implements Streaming {
  private readonly kafka: Kafka;

  constructor(_creds: AwsCredentials, bootstrapServers: string) {
    if (!bootstrapServers) throw new InvalidCredentialsError('bootstrapServers is required for AWS MSK streaming');
    const brokers = bootstrapServers.split(',').map((b) => b.trim());
    this.kafka = new Kafka({ clientId: 'fluidcloud-js-sdk', brokers, connectionTimeout: 10_000 });
  }

  /** Creates a Kafka topic. */
  async createStream(name: string, opts?: StreamCreateOptions): Promise<string> {
    const numPartitions = opts?.partitions && opts.partitions > 0 ? opts.partitions : 1;
    const retentionMs = opts?.retentionMs ?? -1;
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.createTopics({
        topics: [
          {
            topic: name,
            numPartitions,
            replicationFactor: 1,
            configEntries: retentionMs > 0 ? [{ name: 'retention.ms', value: String(retentionMs) }] : undefined,
          },
        ],
      });
    } catch (err) {
      wrapProviderError('aws', 'CreateTopic', err);
    } finally {
      await admin.disconnect();
    }
    return name;
  }

  /** Deletes a Kafka topic. */
  async deleteStream(streamId: string): Promise<void> {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.deleteTopics({ topics: [streamId] });
    } catch (err) {
      wrapProviderError('aws', 'DeleteTopic', err);
    } finally {
      await admin.disconnect();
    }
  }

  /** Lists all Kafka topics visible from the bootstrap brokers. */
  async listStreams(): Promise<StreamInfo[]> {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      const { topics } = await admin.fetchTopicMetadata();
      return topics.map((t) => ({
        id: t.name,
        name: t.name,
        partitions: t.partitions.length,
        status: '',
        retentionMs: 0,
      }));
    } catch (err) {
      return wrapProviderError('aws', 'ReadPartitions', err);
    } finally {
      await admin.disconnect();
    }
  }

  /** Reads details for a specific Kafka topic. */
  async getStream(streamId: string): Promise<StreamInfo> {
    const streams = await this.listStreams();
    const stream = streams.find((s) => s.name === streamId);
    if (!stream) return wrapProviderError('aws', 'GetStream', new Error(`stream "${streamId}" not found`));
    return stream;
  }

  /** Produces messages to a Kafka topic. */
  async putRecords(streamId: string, records: StreamRecord[]): Promise<void> {
    const producer = this.kafka.producer();
    try {
      await producer.connect();
      await producer.send({
        topic: streamId,
        messages: records.map((r) => ({ key: r.key ? bufferOf(r.key) : undefined, value: bufferOf(r.value) })),
      });
    } catch (err) {
      wrapProviderError('aws', 'WriteMessages', err);
    } finally {
      await producer.disconnect();
    }
  }

  /**
   * Consumes messages from a Kafka topic partition. Kafka has no groupless direct
   * partition read, so an ephemeral consumer group is used when opts.consumerGroup
   * is empty. The consumer is always stopped and disconnected before returning.
   */
  async getRecords(streamId: string, opts: GetRecordsOptions): Promise<StreamRecord[]> {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
    const partition = opts.partition ?? 0;
    const groupId = opts.consumerGroup || `fluidcloud-js-sdk-${randomUUID()}`;
    const consumer = this.kafka.consumer({ groupId });
    const records: StreamRecord[] = [];
    let resolveWait: () => void;
    const wait = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: streamId, fromBeginning: !(opts.offset && opts.offset > 0) });
      await consumer.run({
        eachMessage: async ({ partition: p, message }) => {
          if (p !== partition || records.length >= limit) return;
          records.push({
            key: message.key ?? undefined,
            value: message.value ?? Buffer.alloc(0),
            partition: p,
            offset: Number(message.offset),
            timestamp: new Date(Number(message.timestamp)),
          });
          if (records.length >= limit) resolveWait();
        },
      });
      if (opts.offset && opts.offset > 0) {
        consumer.seek({ topic: streamId, partition, offset: String(opts.offset) });
      }
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000 * limit));
      await Promise.race([wait, timeout]);
    } catch (err) {
      wrapProviderError('aws', 'ReadMessage', err);
    } finally {
      await consumer.stop();
      await consumer.disconnect();
    }
    return records;
  }

  /** No-op: Kafka consumer groups are created implicitly on first use. */
  async createConsumerGroup(_streamId: string, _groupName: string): Promise<void> {}

  /** Deletes a Kafka consumer group. */
  async deleteConsumerGroup(_streamId: string, groupName: string): Promise<void> {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.deleteGroups([groupName]);
    } catch (err) {
      wrapProviderError('aws', 'DeleteConsumerGroup', err);
    } finally {
      await admin.disconnect();
    }
  }

  /** Commits an offset for a consumer group on a specific partition. */
  async commitOffset(streamId: string, groupName: string, partition: number, offset: number): Promise<void> {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.setOffsets({ groupId: groupName, topic: streamId, partitions: [{ partition, offset: String(offset) }] });
    } catch (err) {
      wrapProviderError('aws', 'CommitOffset', err);
    } finally {
      await admin.disconnect();
    }
  }
}
