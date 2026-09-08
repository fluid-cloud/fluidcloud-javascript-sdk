import { EventHubManagementClient } from '@azure/arm-eventhub';
import {
  type EventData,
  EventHubConsumerClient,
  EventHubProducerClient,
  type EventPosition,
  earliestEventPosition,
} from '@azure/event-hubs';

import type { AzureCredentials } from '../../credentials/index.js';
import { InvalidCredentialsError, wrapProviderError } from '../../errors.js';
import type {
  GetRecordsOptions,
  StreamCreateOptions,
  StreamInfo,
  Streaming,
  StreamRecord,
} from '../types/streaming.js';
import { azureCredential } from './auth.js';

function bufferOf(v: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

/**
 * Azure Event Hubs streaming. Stream and consumer-group management goes through
 * the ARM management client; produce/consume go through the Event Hubs data-plane
 * SDK. commitOffset is a no-op: Event Hubs manages offsets via a checkpoint store
 * (e.g. Blob Storage), which is not wired in here.
 */
export class EventHubsStreaming implements Streaming {
  private readonly mgmtClient: EventHubManagementClient;
  private readonly credential: ReturnType<typeof azureCredential>;
  private readonly resourceGroup: string;
  private readonly namespace: string;

  constructor(creds: AzureCredentials, resourceGroup: string, namespace: string) {
    if (!namespace) throw new InvalidCredentialsError('EventHubsNamespace is required for Azure streaming');
    if (!resourceGroup) throw new InvalidCredentialsError('ResourceGroup is required for Azure streaming');
    this.credential = azureCredential(creds);
    this.mgmtClient = new EventHubManagementClient(this.credential, creds.subscriptionId);
    this.resourceGroup = resourceGroup;
    this.namespace = namespace;
  }

  private get fqns(): string {
    return `${this.namespace}.servicebus.windows.net`;
  }

  /** Creates a new Event Hub with the given name. */
  async createStream(name: string, opts?: StreamCreateOptions): Promise<string> {
    let retentionDays = 1;
    if (opts?.retentionMs && opts.retentionMs > 0) {
      retentionDays = Math.floor(opts.retentionMs / (24 * 60 * 60 * 1000));
      if (retentionDays < 1) retentionDays = 1;
    }
    try {
      await this.mgmtClient.eventHubs.createOrUpdate(this.resourceGroup, this.namespace, name, {
        partitionCount: opts?.partitions && opts.partitions > 0 ? opts.partitions : 4,
        messageRetentionInDays: retentionDays,
      });
    } catch (err) {
      wrapProviderError('azure', 'CreateEventHub', err);
    }
    return name;
  }

  /** Deletes an Event Hub by name. */
  async deleteStream(streamId: string): Promise<void> {
    try {
      await this.mgmtClient.eventHubs.delete(this.resourceGroup, this.namespace, streamId);
    } catch (err) {
      wrapProviderError('azure', 'DeleteEventHub', err);
    }
  }

  /** Lists all Event Hubs in the namespace. */
  async listStreams(): Promise<StreamInfo[]> {
    const streams: StreamInfo[] = [];
    try {
      for await (const eh of this.mgmtClient.eventHubs.listByNamespace(this.resourceGroup, this.namespace)) {
        streams.push({
          id: eh.name ?? '',
          name: eh.name ?? '',
          partitions: eh.partitionCount ?? 0,
          status: eh.status ?? '',
          retentionMs: eh.messageRetentionInDays ? eh.messageRetentionInDays * 24 * 60 * 60 * 1000 : 0,
        });
      }
    } catch (err) {
      wrapProviderError('azure', 'ListEventHubs', err);
    }
    return streams;
  }

  /** Reads metadata for a single Event Hub. */
  async getStream(streamId: string): Promise<StreamInfo> {
    try {
      const eh = await this.mgmtClient.eventHubs.get(this.resourceGroup, this.namespace, streamId);
      return {
        id: eh.name ?? '',
        name: eh.name ?? '',
        partitions: eh.partitionCount ?? 0,
        status: eh.status ?? '',
        retentionMs: eh.messageRetentionInDays ? eh.messageRetentionInDays * 24 * 60 * 60 * 1000 : 0,
      };
    } catch (err) {
      return wrapProviderError('azure', 'GetEventHub', err);
    }
  }

  /** Sends a batch of records to an Event Hub. */
  async putRecords(streamId: string, records: StreamRecord[]): Promise<void> {
    const producer = new EventHubProducerClient(this.fqns, streamId, this.credential);
    try {
      const batch = await producer.createBatch();
      for (const r of records) {
        const ev: EventData = { body: bufferOf(r.value) };
        if (r.key && r.key.length > 0) ev.properties = { key: bufferOf(r.key).toString() };
        if (!batch.tryAdd(ev)) {
          throw new Error('event does not fit in a single batch');
        }
      }
      await producer.sendBatch(batch);
    } catch (err) {
      wrapProviderError('azure', 'SendEventDataBatch', err);
    } finally {
      await producer.close();
    }
  }

  /** Receives events from a specific partition of an Event Hub. */
  async getRecords(streamId: string, opts: GetRecordsOptions): Promise<StreamRecord[]> {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
    const groupName = opts.consumerGroup || EventHubConsumerClient.defaultConsumerGroupName;
    const partition = opts.partition ?? 0;
    const consumer = new EventHubConsumerClient(groupName, this.fqns, streamId, this.credential);
    const startPosition: EventPosition =
      opts.offset && opts.offset > 0 ? { sequenceNumber: opts.offset } : earliestEventPosition;
    try {
      const records = await new Promise<StreamRecord[]>((resolve, reject) => {
        const subscription = consumer.subscribe(
          String(partition),
          {
            processEvents: async (events) => {
              const recs: StreamRecord[] = events.map((ev) => ({
                key: typeof ev.properties?.key === 'string' ? Buffer.from(ev.properties.key) : undefined,
                value: Buffer.isBuffer(ev.body) ? ev.body : Buffer.from(ev.body),
                partition,
                offset: ev.sequenceNumber,
                timestamp: ev.enqueuedTimeUtc,
              }));
              await subscription.close();
              resolve(recs);
            },
            processError: async (err) => {
              await subscription.close();
              reject(err);
            },
          },
          { startPosition, maxBatchSize: limit, maxWaitTimeInSeconds: 5, skipParsingBodyAsJson: true },
        );
      });
      return records;
    } catch (err) {
      return wrapProviderError('azure', 'ReceiveEvents', err);
    } finally {
      await consumer.close();
    }
  }

  /** Creates a new consumer group on an Event Hub. */
  async createConsumerGroup(streamId: string, groupName: string): Promise<void> {
    try {
      await this.mgmtClient.consumerGroups.createOrUpdate(this.resourceGroup, this.namespace, streamId, groupName, {});
    } catch (err) {
      wrapProviderError('azure', 'CreateConsumerGroup', err);
    }
  }

  /** Deletes a consumer group from an Event Hub. */
  async deleteConsumerGroup(streamId: string, groupName: string): Promise<void> {
    try {
      await this.mgmtClient.consumerGroups.delete(this.resourceGroup, this.namespace, streamId, groupName);
    } catch (err) {
      wrapProviderError('azure', 'DeleteConsumerGroup', err);
    }
  }

  /** No-op: Azure Event Hubs manages offsets via a checkpoint store, not wired in here. */
  async commitOffset(_streamId: string, _groupName: string, _partition: number, _offset: number): Promise<void> {}
}
