import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnsupportedError } from '../src/errors.js';
import type { AwsCredentials, AzureCredentials, GcpCredentials, OciCredentials } from '../src/credentials/index.js';

const kinesisSend = vi.fn();
vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kinesis')>();
  return { ...actual, KinesisClient: vi.fn().mockImplementation(function () { return { send: kinesisSend }; }) };
});

const kafkaAdmin = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  createTopics: vi.fn(),
  deleteTopics: vi.fn(),
  fetchTopicMetadata: vi.fn(),
  deleteGroups: vi.fn(),
  setOffsets: vi.fn(),
};
const kafkaProducer = { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() };
const kafkaConsumer = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  subscribe: vi.fn(),
  run: vi.fn(),
  seek: vi.fn(),
  stop: vi.fn(),
};
vi.mock('kafkajs', () => ({
  Kafka: vi.fn().mockImplementation(function () {
    return { admin: () => kafkaAdmin, producer: () => kafkaProducer, consumer: () => kafkaConsumer };
  }),
}));

const ehClient = {
  eventHubs: { createOrUpdate: vi.fn(), delete: vi.fn(), listByNamespace: vi.fn(), get: vi.fn() },
  consumerGroups: { createOrUpdate: vi.fn(), delete: vi.fn() },
};
vi.mock('@azure/arm-eventhub', () => ({
  EventHubManagementClient: vi.fn().mockImplementation(function () { return ehClient; }),
}));

const ehProducer = { createBatch: vi.fn(), sendBatch: vi.fn(), close: vi.fn() };
const ehSubscription = { close: vi.fn() };
const ehConsumer = { subscribe: vi.fn(), close: vi.fn() };
vi.mock('@azure/event-hubs', () => ({
  EventHubProducerClient: vi.fn().mockImplementation(function () { return ehProducer; }),
  EventHubConsumerClient: Object.assign(
    vi.fn().mockImplementation(function () { return ehConsumer; }),
    { defaultConsumerGroupName: '$Default' },
  ),
  earliestEventPosition: { isInclusive: true },
}));

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: vi.fn().mockImplementation(function () { return {}; }),
}));

const pubsubTopic = { delete: vi.fn(), publishMessage: vi.fn(), exists: vi.fn() };
const pubsub = {
  createTopic: vi.fn(),
  getTopics: vi.fn(),
  topic: vi.fn(() => pubsubTopic),
  createSubscription: vi.fn(),
  subscription: vi.fn(() => ({ delete: vi.fn() })),
};
const subscriberClient = {
  pull: vi.fn(),
  acknowledge: vi.fn(),
  subscriptionPath: (project: string, sub: string) => `projects/${project}/subscriptions/${sub}`,
};
vi.mock('@google-cloud/pubsub', () => ({
  PubSub: vi.fn().mockImplementation(function () { return pubsub; }),
  v1: { SubscriberClient: vi.fn().mockImplementation(function () { return subscriberClient; }) },
}));

const ociAdmin = {
  createStream: vi.fn(),
  deleteStream: vi.fn(),
  listStreams: vi.fn(),
  getStream: vi.fn(),
  regionId: '',
};
const ociData = {
  putMessages: vi.fn(),
  getMessages: vi.fn(),
  createCursor: vi.fn(),
  createGroupCursor: vi.fn(),
  consumerCommit: vi.fn(),
  close: vi.fn(),
  endpoint: '',
};
vi.mock('oci-streaming', () => ({
  StreamAdminClient: vi.fn().mockImplementation(function () { return ociAdmin; }),
  StreamClient: vi.fn().mockImplementation(function () { return ociData; }),
  models: {
    CreateCursorDetails: { Type: { TrimHorizon: 'TRIM_HORIZON', AfterOffset: 'AFTER_OFFSET' } },
    CreateGroupCursorDetails: { Type: { TrimHorizon: 'TRIM_HORIZON' } },
  },
}));

const { KinesisStreaming, MskStreaming } = await import('../src/provider/aws/streaming.js');
const { EventHubsStreaming } = await import('../src/provider/azure/streaming.js');
const { PubSubStreaming } = await import('../src/provider/gcp/streaming.js');
const { OciStreaming } = await import('../src/provider/oci/streaming.js');

const awsCreds: AwsCredentials = { accessKey: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1' };
const azureCreds: AzureCredentials = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
  clientSecret: 'secret',
  subscriptionId: '33333333-3333-3333-3333-333333333333',
};
const gcpCreds: GcpCredentials = {
  projectId: 'proj-1',
  serviceAccountJson: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'x' }),
};
const ociCreds: OciCredentials = {
  tenancyOcid: 'ocid1.tenancy.oc1..a',
  userOcid: 'ocid1.user.oc1..a',
  fingerprint: 'aa:bb',
  privateKey: 'key',
  region: 'us-ashburn-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KinesisStreaming (aws)', () => {
  it('maps createStream/putRecords/getRecords to the right Kinesis calls, and emulates checkpointing via commitOffset', async () => {
    kinesisSend
      .mockResolvedValueOnce({}) // CreateStream
      .mockResolvedValueOnce({ FailedRecordCount: 0, Records: [] }) // PutRecords
      .mockResolvedValueOnce({ Shards: [{ ShardId: 'shardId-000000000000' }] }) // ListShards (1st getRecords)
      .mockResolvedValueOnce({ ShardIterator: 'iter-1' }) // GetShardIterator (1st)
      .mockResolvedValueOnce({ Records: [{ Data: Buffer.from('hi'), PartitionKey: 'pk-1', SequenceNumber: 'seq-1' }] }) // GetRecords (1st)
      .mockResolvedValueOnce({ Shards: [{ ShardId: 'shardId-000000000000' }] }) // ListShards (2nd getRecords)
      .mockResolvedValueOnce({ ShardIterator: 'iter-2' }) // GetShardIterator (2nd)
      .mockResolvedValueOnce({ Records: [] }); // GetRecords (2nd)

    const s = new KinesisStreaming(awsCreds);
    const id = await s.createStream('s1', { partitions: 2 });
    expect(id).toBe('s1');
    expect(kinesisSend.mock.calls[0][0].input).toMatchObject({ StreamName: 's1', ShardCount: 2 });

    await s.putRecords('s1', [{ value: Buffer.from('hi') }]);
    expect(kinesisSend.mock.calls[1][0].input.StreamName).toBe('s1');

    const records = await s.getRecords('s1', { partition: 0, consumerGroup: 'g1' });
    expect(records).toEqual([{ key: Buffer.from('pk-1'), value: Buffer.from('hi'), partition: 0, timestamp: undefined }]);
    expect(kinesisSend.mock.calls[3][0].input).toMatchObject({ ShardIteratorType: 'TRIM_HORIZON' });

    await s.commitOffset('s1', 'g1', 0, 0);
    await s.getRecords('s1', { partition: 0, consumerGroup: 'g1' });
    expect(kinesisSend.mock.calls[6][0].input).toMatchObject({
      ShardIteratorType: 'AFTER_SEQUENCE_NUMBER',
      StartingSequenceNumber: 'seq-1',
    });
  });

  it('wraps SDK failures as ProviderError', async () => {
    kinesisSend.mockRejectedValueOnce(new Error('boom'));
    const s = new KinesisStreaming(awsCreds);
    await expect(s.createStream('s1')).rejects.toThrow(/aws: CreateStream failed/);
  });
});

describe('MskStreaming (aws)', () => {
  it('creates/deletes topics via the admin client and disconnects', async () => {
    kafkaAdmin.createTopics.mockResolvedValueOnce(true);
    const s = new MskStreaming(awsCreds, 'b1:9092,b2:9092');
    await s.createStream('t1', { partitions: 3 });
    expect(kafkaAdmin.createTopics).toHaveBeenCalledWith({
      topics: [{ topic: 't1', numPartitions: 3, replicationFactor: 1, configEntries: undefined }],
    });
    expect(kafkaAdmin.disconnect).toHaveBeenCalled();

    await s.deleteStream('t1');
    expect(kafkaAdmin.deleteTopics).toHaveBeenCalledWith({ topics: ['t1'] });
  });

  it('always stops and disconnects the consumer after getRecords, even on a fast batch', async () => {
    kafkaConsumer.run.mockImplementationOnce(async ({ eachMessage }) => {
      await eachMessage({
        partition: 0,
        message: { key: Buffer.from('k'), value: Buffer.from('v'), offset: '5', timestamp: '1700000000000' },
      });
    });
    const s = new MskStreaming(awsCreds, 'b1:9092');
    const records = await s.getRecords('t1', { partition: 0, limit: 1 });
    expect(records).toEqual([
      { key: Buffer.from('k'), value: Buffer.from('v'), partition: 0, offset: 5, timestamp: new Date(1700000000000) },
    ]);
    expect(kafkaConsumer.stop).toHaveBeenCalled();
    expect(kafkaConsumer.disconnect).toHaveBeenCalled();
  });

  it('requires bootstrapServers', () => {
    expect(() => new MskStreaming(awsCreds, '')).toThrow(/bootstrapServers is required/);
  });
});

describe('EventHubsStreaming (azure)', () => {
  it('maps createStream to CreateOrUpdate with the right partition/retention shape', async () => {
    const s = new EventHubsStreaming(azureCreds, 'rg1', 'ns1');
    await s.createStream('eh1', { partitions: 8, retentionMs: 2 * 24 * 60 * 60 * 1000 });
    expect(ehClient.eventHubs.createOrUpdate).toHaveBeenCalledWith('rg1', 'ns1', 'eh1', {
      partitionCount: 8,
      messageRetentionInDays: 2,
    });
  });

  it('commitOffset is a no-op', async () => {
    const s = new EventHubsStreaming(azureCreds, 'rg1', 'ns1');
    await expect(s.commitOffset('eh1', 'g1', 0, 5)).resolves.toBeUndefined();
  });

  it('resolves getRecords from the first processEvents batch and closes the subscription', async () => {
    ehConsumer.subscribe.mockImplementationOnce((_partitionId, handlers) => {
      setTimeout(() => {
        void handlers.processEvents(
          [{ body: Buffer.from('hi'), sequenceNumber: 42, enqueuedTimeUtc: new Date(0), properties: { key: 'k1' } }],
          {},
        );
      }, 0);
      return ehSubscription;
    });
    const s = new EventHubsStreaming(azureCreds, 'rg1', 'ns1');
    const records = await s.getRecords('eh1', { partition: 0, limit: 5 });
    expect(records).toEqual([{ key: Buffer.from('k1'), value: Buffer.from('hi'), partition: 0, offset: 42, timestamp: new Date(0) }]);
    expect(ehSubscription.close).toHaveBeenCalled();
    expect(ehConsumer.close).toHaveBeenCalled();
  });
});

describe('PubSubStreaming (gcp)', () => {
  it('createStream maps to CreateTopic and returns the short id', async () => {
    pubsub.createTopic.mockResolvedValueOnce([{ name: 'projects/proj-1/topics/t1' }]);
    const s = new PubSubStreaming(gcpCreds);
    const id = await s.createStream('t1');
    expect(id).toBe('t1');
    expect(pubsub.createTopic).toHaveBeenCalledWith('t1');
  });

  it('getStream throws NotFoundError when the topic does not exist', async () => {
    pubsubTopic.exists.mockResolvedValueOnce([false]);
    const s = new PubSubStreaming(gcpCreds);
    await expect(s.getStream('missing')).rejects.toThrow(/not found/);
  });

  it('getRecords pulls and acknowledges via the low-level SubscriberClient', async () => {
    subscriberClient.pull.mockResolvedValueOnce([
      {
        receivedMessages: [
          { ackId: 'ack-1', message: { data: Buffer.from('hi'), attributes: { key: 'k1' } } },
        ],
      },
    ]);
    const s = new PubSubStreaming(gcpCreds);
    const records = await s.getRecords('t1', { consumerGroup: 'sub1', limit: 5 });
    expect(records).toEqual([{ key: Buffer.from('k1'), value: Buffer.from('hi') }]);
    expect(subscriberClient.pull).toHaveBeenCalledWith({
      subscription: 'projects/proj-1/subscriptions/sub1',
      maxMessages: 5,
    });
    expect(subscriberClient.acknowledge).toHaveBeenCalledWith({
      subscription: 'projects/proj-1/subscriptions/sub1',
      ackIds: ['ack-1'],
    });
  });

  it('commitOffset throws UnsupportedError — Pub/Sub is ack-based, not offset-based', async () => {
    const s = new PubSubStreaming(gcpCreds);
    await expect(s.commitOffset('t1', 'g1', 0, 0)).rejects.toThrow(UnsupportedError);
  });
});

describe('OciStreaming (oci)', () => {
  it('resolves the messages endpoint before producing, then base64-encodes the payload', async () => {
    ociAdmin.getStream.mockResolvedValue({ stream: { messagesEndpoint: 'https://stream-endpoint' } });
    ociData.putMessages.mockResolvedValueOnce({});

    const s = new OciStreaming(ociCreds, 'ocid1.compartment.oc1..a');
    await s.putRecords('stream1', [{ value: Buffer.from('hi'), key: Buffer.from('k1') }]);

    expect(ociAdmin.getStream).toHaveBeenCalledWith({ streamId: 'stream1' });
    expect(ociData.putMessages).toHaveBeenCalledWith({
      streamId: 'stream1',
      putMessagesDetails: {
        messages: [{ value: Buffer.from('hi').toString('base64'), key: Buffer.from('k1').toString('base64') }],
      },
    });
    expect(ociData.close).toHaveBeenCalled();
  });

  it('getRecords creates a cursor then reads messages, base64-decoding the payload', async () => {
    ociAdmin.getStream.mockResolvedValue({ stream: { messagesEndpoint: 'https://stream-endpoint' } });
    ociData.createCursor.mockResolvedValueOnce({ cursor: { value: 'cursor-1' } });
    ociData.getMessages.mockResolvedValueOnce({
      items: [{ key: Buffer.from('k1').toString('base64'), value: Buffer.from('hi').toString('base64'), partition: '0', offset: 7 }],
    });

    const s = new OciStreaming(ociCreds, 'ocid1.compartment.oc1..a');
    const records = await s.getRecords('stream1', { partition: 0, limit: 5 });
    expect(records).toEqual([{ key: Buffer.from('k1'), value: Buffer.from('hi'), partition: 0, offset: 7, timestamp: undefined }]);
    expect(ociData.createCursor).toHaveBeenCalledWith({
      streamId: 'stream1',
      createCursorDetails: { partition: '0', type: 'TRIM_HORIZON' },
    });
  });

  it('createConsumerGroup is a no-op; groups are created implicitly', async () => {
    const s = new OciStreaming(ociCreds, 'ocid1.compartment.oc1..a');
    await expect(s.createConsumerGroup('stream1', 'g1')).resolves.toBeUndefined();
  });

  // commitOffset used to ignore its partition/offset and commit a TRIM_HORIZON
  // group cursor, which rewound the group to the start of the stream.
  it('commitOffset records a checkpoint per group and per partition', async () => {
    ociAdmin.getStream.mockResolvedValue({ stream: { messagesEndpoint: 'https://stream-endpoint' } });
    const s = new OciStreaming(ociCreds, 'ocid1.compartment.oc1..a');

    await s.commitOffset('stream1', 'group-a', 0, 100);
    await s.commitOffset('stream1', 'group-a', 1, 250);
    await s.commitOffset('stream1', 'group-b', 0, 7);

    // It must not reach for a group cursor at all any more.
    expect(ociData.createGroupCursor).not.toHaveBeenCalled();
    expect(ociData.consumerCommit).not.toHaveBeenCalled();

    for (const [group, partition, want] of [
      ['group-a', 0, 100],
      ['group-a', 1, 250],
      ['group-b', 0, 7],
    ] as const) {
      ociData.createCursor.mockResolvedValueOnce({ cursor: { value: 'c' } });
      ociData.getMessages.mockResolvedValueOnce({ items: [] });
      await s.getRecords('stream1', { partition, consumerGroup: group });
      expect(ociData.createCursor).toHaveBeenLastCalledWith({
        streamId: 'stream1',
        createCursorDetails: { partition: String(partition), type: 'AFTER_OFFSET', offset: want },
      });
    }
  });

  it('commitOffset moves the checkpoint forward and rejects an empty group', async () => {
    ociAdmin.getStream.mockResolvedValue({ stream: { messagesEndpoint: 'https://stream-endpoint' } });
    const s = new OciStreaming(ociCreds, 'ocid1.compartment.oc1..a');

    await s.commitOffset('stream1', 'group-a', 0, 100);
    await s.commitOffset('stream1', 'group-a', 0, 400);

    ociData.createCursor.mockResolvedValueOnce({ cursor: { value: 'c' } });
    ociData.getMessages.mockResolvedValueOnce({ items: [] });
    await s.getRecords('stream1', { partition: 0, consumerGroup: 'group-a' });
    expect(ociData.createCursor).toHaveBeenLastCalledWith({
      streamId: 'stream1',
      createCursorDetails: { partition: '0', type: 'AFTER_OFFSET', offset: 400 },
    });

    await expect(s.commitOffset('stream1', '', 0, 1)).rejects.toThrow();
  });

  it('an explicit offset still wins over the group checkpoint', async () => {
    ociAdmin.getStream.mockResolvedValue({ stream: { messagesEndpoint: 'https://stream-endpoint' } });
    const s = new OciStreaming(ociCreds, 'ocid1.compartment.oc1..a');
    await s.commitOffset('stream1', 'group-a', 0, 100);

    ociData.createCursor.mockResolvedValueOnce({ cursor: { value: 'c' } });
    ociData.getMessages.mockResolvedValueOnce({ items: [] });
    await s.getRecords('stream1', { partition: 0, consumerGroup: 'group-a', offset: 999 });
    expect(ociData.createCursor).toHaveBeenLastCalledWith({
      streamId: 'stream1',
      createCursorDetails: { partition: '0', type: 'AFTER_OFFSET', offset: 999 },
    });
  });

  it('deleteConsumerGroup clears only that group checkpoints', async () => {
    ociAdmin.getStream.mockResolvedValue({ stream: { messagesEndpoint: 'https://stream-endpoint' } });
    const s = new OciStreaming(ociCreds, 'ocid1.compartment.oc1..a');
    await s.commitOffset('stream1', 'group-a', 0, 100);
    await s.commitOffset('stream1', 'group-b', 0, 7);

    await s.deleteConsumerGroup('stream1', 'group-a');

    // group-a falls back to trim horizon, group-b keeps its checkpoint.
    ociData.createCursor.mockResolvedValueOnce({ cursor: { value: 'c' } });
    ociData.getMessages.mockResolvedValueOnce({ items: [] });
    await s.getRecords('stream1', { partition: 0, consumerGroup: 'group-a' });
    expect(ociData.createCursor).toHaveBeenLastCalledWith({
      streamId: 'stream1',
      createCursorDetails: { partition: '0', type: 'TRIM_HORIZON' },
    });

    ociData.createCursor.mockResolvedValueOnce({ cursor: { value: 'c' } });
    ociData.getMessages.mockResolvedValueOnce({ items: [] });
    await s.getRecords('stream1', { partition: 0, consumerGroup: 'group-b' });
    expect(ociData.createCursor).toHaveBeenLastCalledWith({
      streamId: 'stream1',
      createCursorDetails: { partition: '0', type: 'AFTER_OFFSET', offset: 7 },
    });
  });
});
