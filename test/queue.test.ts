import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotFoundError } from '../src/errors.js';
import type { AwsCredentials, AzureCredentials, GcpCredentials, OciCredentials } from '../src/credentials/index.js';

const sqsSend = vi.fn();
vi.mock('@aws-sdk/client-sqs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sqs')>();
  return { ...actual, SQSClient: vi.fn().mockImplementation(function () { return { send: sqsSend }; }) };
});

const sbAdmin = {
  createQueue: vi.fn(),
  deleteQueue: vi.fn(),
  listQueues: vi.fn(),
  getQueueRuntimeProperties: vi.fn(),
};
const sbSender = { sendMessages: vi.fn(), close: vi.fn() };
const sbReceiver = { receiveMessages: vi.fn(), completeMessage: vi.fn() };
const sbClient = { createSender: vi.fn(() => sbSender), createReceiver: vi.fn(() => sbReceiver) };
vi.mock('@azure/service-bus', () => ({
  ServiceBusAdministrationClient: vi.fn().mockImplementation(function () { return sbAdmin; }),
  ServiceBusClient: vi.fn().mockImplementation(function () { return sbClient; }),
}));

const pubsubTopic = { delete: vi.fn(), publishMessage: vi.fn() };
const pubsubSubscription = { delete: vi.fn().mockResolvedValue(undefined), getMetadata: vi.fn() };
const pubsub = {
  createTopic: vi.fn(),
  createSubscription: vi.fn(),
  topic: vi.fn(() => pubsubTopic),
  subscription: vi.fn(() => pubsubSubscription),
  getSubscriptions: vi.fn(),
};
const subscriberClient = { pull: vi.fn(), acknowledge: vi.fn() };
vi.mock('@google-cloud/pubsub', () => ({
  PubSub: vi.fn().mockImplementation(function () { return pubsub; }),
  v1: { SubscriberClient: vi.fn().mockImplementation(function () { return subscriberClient; }) },
}));

const ociAdmin = { createQueue: vi.fn(), deleteQueue: vi.fn(), listQueues: vi.fn(), getQueue: vi.fn(), regionId: '' };
const ociData = { putMessages: vi.fn(), getMessages: vi.fn(), deleteMessage: vi.fn(), regionId: '' };
vi.mock('oci-queue', () => ({
  QueueAdminClient: vi.fn().mockImplementation(function () { return ociAdmin; }),
  QueueClient: vi.fn().mockImplementation(function () { return ociData; }),
  models: {},
}));

const { SqsQueue } = await import('../src/provider/aws/queue.js');
const { ServiceBusQueue } = await import('../src/provider/azure/queue.js');
const { PubSubQueue } = await import('../src/provider/gcp/queue.js');
const { OciQueue } = await import('../src/provider/oci/queue.js');

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

describe('SqsQueue (aws)', () => {
  it('maps every method to the right SQS command and arguments', async () => {
    sqsSend
      .mockResolvedValueOnce({ QueueUrl: 'https://sqs/q1' })
      .mockResolvedValueOnce({ MessageId: 'm1' })
      .mockResolvedValueOnce({
        Messages: [
          { MessageId: 'm1', Body: 'hello', ReceiptHandle: 'rh1', MessageAttributes: { k: { StringValue: 'v' } } },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Attributes: { ApproximateNumberOfMessages: '3', VisibilityTimeout: '30', MessageRetentionPeriod: '86400' },
      });

    const q = new SqsQueue(awsCreds);

    const id = await q.createQueue('q1', { visibilityTimeoutSeconds: 30, messageRetentionSeconds: 86400 });
    expect(id).toBe('https://sqs/q1');
    expect(sqsSend.mock.calls[0][0].input).toMatchObject({
      QueueName: 'q1',
      Attributes: { VisibilityTimeout: '30', MessageRetentionPeriod: '86400' },
    });

    const msgId = await q.sendMessage('https://sqs/q1', 'hello', { delaySeconds: 5, attributes: { k: 'v' } });
    expect(msgId).toBe('m1');
    expect(sqsSend.mock.calls[1][0].input).toMatchObject({
      QueueUrl: 'https://sqs/q1',
      MessageBody: 'hello',
      DelaySeconds: 5,
      MessageAttributes: { k: { DataType: 'String', StringValue: 'v' } },
    });

    const msgs = await q.receiveMessages('https://sqs/q1', 5, { visibilityTimeoutSeconds: 10, waitTimeSeconds: 2 });
    expect(msgs).toEqual([{ id: 'm1', body: 'hello', receiptHandle: 'rh1', attributes: { k: 'v' } }]);
    expect(sqsSend.mock.calls[2][0].input).toMatchObject({
      QueueUrl: 'https://sqs/q1',
      MaxNumberOfMessages: 5,
      VisibilityTimeout: 10,
      WaitTimeSeconds: 2,
    });

    await q.deleteMessage('https://sqs/q1', 'rh1');
    expect(sqsSend.mock.calls[3][0].input).toMatchObject({ QueueUrl: 'https://sqs/q1', ReceiptHandle: 'rh1' });

    const attrs = await q.getQueueAttributes('https://sqs/q1');
    expect(attrs).toEqual({
      approximateMessageCount: 3,
      visibilityTimeoutSeconds: 30,
      messageRetentionSeconds: 86400,
    });
  });

  it('wraps SDK failures as ProviderError', async () => {
    sqsSend.mockRejectedValueOnce(new Error('boom'));
    const q = new SqsQueue(awsCreds);
    await expect(q.createQueue('q1')).rejects.toThrow(/aws: createQueue failed/);
  });
});

describe('ServiceBusQueue (azure)', () => {
  it('caches the lock token as the receipt handle and completes it on delete', async () => {
    sbReceiver.receiveMessages.mockResolvedValueOnce([
      { messageId: 'm1', body: 'hello', lockToken: 'lock-1', applicationProperties: {} },
    ]);

    const q = new ServiceBusQueue(azureCreds, 'my-namespace');
    const msgs = await q.receiveMessages('q1', 1);
    expect(msgs).toEqual([{ id: 'm1', body: 'hello', receiptHandle: 'lock-1', attributes: {} }]);

    await q.deleteMessage('q1', 'lock-1');
    expect(sbReceiver.completeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ lockToken: 'lock-1' }),
    );
  });

  it('throws NotFoundError when the receipt handle was never received', async () => {
    const q = new ServiceBusQueue(azureCreds, 'my-namespace');
    await expect(q.deleteMessage('q1', 'unknown')).rejects.toThrow(NotFoundError);
  });

  it('reuses one receiver per queue', async () => {
    sbReceiver.receiveMessages.mockResolvedValue([]);
    const q = new ServiceBusQueue(azureCreds, 'my-namespace');
    await q.receiveMessages('q1', 1);
    await q.receiveMessages('q1', 1);
    expect(sbClient.createReceiver).toHaveBeenCalledTimes(1);
  });

  // Send and receive options used to be accepted and silently dropped.
  it('sendMessage maps delaySeconds and attributes onto the Service Bus message', async () => {
    const q = new ServiceBusQueue(azureCreds, 'my-namespace');
    const before = Date.now();
    await q.sendMessage('q1', 'hello', { delaySeconds: 60, attributes: { tenant: 'acme' } });

    const sent = sbSender.sendMessages.mock.calls.at(-1)![0];
    expect(sent.applicationProperties).toEqual({ tenant: 'acme' });
    expect(sent.scheduledEnqueueTimeUtc.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('receiveMessages passes waitTimeSeconds through as a max wait', async () => {
    sbReceiver.receiveMessages.mockResolvedValueOnce([]);
    const q = new ServiceBusQueue(azureCreds, 'my-namespace');
    await q.receiveMessages('q1', 5, { waitTimeSeconds: 20 });
    expect(sbReceiver.receiveMessages).toHaveBeenLastCalledWith(5, { maxWaitTimeInMs: 20_000 });
  });

  it('receiveMessages round-trips application properties into attributes', async () => {
    sbReceiver.receiveMessages.mockResolvedValueOnce([
      { messageId: 'm1', body: 'hello', lockToken: 'lock-9', applicationProperties: { tenant: 'acme', retries: 2 } },
    ]);
    const q = new ServiceBusQueue(azureCreds, 'my-namespace');
    const [msg] = await q.receiveMessages('q1', 1);
    expect(msg.attributes).toEqual({ tenant: 'acme', retries: '2' });
  });
});

describe('PubSubQueue (gcp)', () => {
  it('pulls via the low-level SubscriberClient using the ack id as the receipt handle', async () => {
    subscriberClient.pull.mockResolvedValueOnce([
      {
        receivedMessages: [
          { ackId: 'ack-1', message: { messageId: 'm1', data: Buffer.from('hello'), attributes: { k: 'v' } } },
        ],
      },
    ]);

    const q = new PubSubQueue(gcpCreds);
    const msgs = await q.receiveMessages('q1', 3);
    expect(msgs).toEqual([{ id: 'm1', body: 'hello', receiptHandle: 'ack-1', attributes: { k: 'v' } }]);
    expect(subscriberClient.pull).toHaveBeenCalledWith({
      subscription: 'projects/proj-1/subscriptions/q1',
      maxMessages: 3,
    });

    await q.deleteMessage('q1', 'ack-1');
    expect(subscriberClient.acknowledge).toHaveBeenCalledWith({
      subscription: 'projects/proj-1/subscriptions/q1',
      ackIds: ['ack-1'],
    });
  });

  it('publishes a Buffer payload to the queue topic', async () => {
    pubsubTopic.publishMessage.mockResolvedValueOnce('m1');
    const q = new PubSubQueue(gcpCreds);
    const id = await q.sendMessage('q1', 'hello', { attributes: { k: 'v' } });
    expect(id).toBe('m1');
    expect(pubsubTopic.publishMessage).toHaveBeenCalledWith({
      data: Buffer.from('hello'),
      attributes: { k: 'v' },
    });
  });
});

describe('OciQueue (oci)', () => {
  it('maps CreateQueue/PutMessages/GetMessages to their OCI request shapes', async () => {
    ociAdmin.createQueue.mockResolvedValueOnce({ opcWorkRequestId: 'wr-1' });
    ociData.putMessages.mockResolvedValueOnce({ putMessages: { messages: [{ id: 42 }] } });
    ociData.getMessages.mockResolvedValueOnce({
      getMessages: { messages: [{ id: 7, content: 'hello', receipt: 'r-1' }] },
    });

    const q = new OciQueue(ociCreds, 'ocid1.compartment.oc1..a');

    const id = await q.createQueue('q1', { visibilityTimeoutSeconds: 30 });
    expect(id).toBe('wr-1');
    expect(ociAdmin.createQueue).toHaveBeenCalledWith({
      createQueueDetails: {
        displayName: 'q1',
        compartmentId: 'ocid1.compartment.oc1..a',
        visibilityInSeconds: 30,
      },
    });

    const msgId = await q.sendMessage('q1', 'hello');
    expect(msgId).toBe('42');

    const msgs = await q.receiveMessages('q1', 2);
    expect(msgs).toEqual([{ id: '7', body: 'hello', receiptHandle: 'r-1', attributes: {} }]);
  });

  it('receiveMessages maps visibility and wait timeouts onto the OCI request', async () => {
    ociData.getMessages.mockResolvedValueOnce({ getMessages: { messages: [] } });
    const q = new OciQueue(ociCreds, 'ocid1.compartment.oc1..a');
    await q.receiveMessages('q1', 4, { visibilityTimeoutSeconds: 45, waitTimeSeconds: 12 });
    expect(ociData.getMessages).toHaveBeenLastCalledWith({
      queueId: 'q1',
      limit: 4,
      visibilityInSeconds: 45,
      timeoutInSeconds: 12,
    });
  });

  it('receiveMessages surfaces message metadata custom properties as attributes', async () => {
    ociData.getMessages.mockResolvedValueOnce({
      getMessages: {
        messages: [{ id: 8, content: 'hi', receipt: 'r-2', metadata: { customProperties: { tenant: 'acme' } } }],
      },
    });
    const q = new OciQueue(ociCreds, 'ocid1.compartment.oc1..a');
    const [msg] = await q.receiveMessages('q1', 1);
    expect(msg.attributes).toEqual({ tenant: 'acme' });
  });

  it('leaves approximateMessageCount at 0 — GetQueue does not expose it', async () => {
    ociAdmin.getQueue.mockResolvedValueOnce({ queue: { visibilityInSeconds: 30, retentionInSeconds: 86400 } });
    const q = new OciQueue(ociCreds, 'ocid1.compartment.oc1..a');
    const attrs = await q.getQueueAttributes('q1');
    expect(attrs).toEqual({ approximateMessageCount: 0, visibilityTimeoutSeconds: 30, messageRetentionSeconds: 86400 });
  });
});
