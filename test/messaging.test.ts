import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AwsCredentials, AzureCredentials, GcpCredentials, OciCredentials } from '../src/credentials/index.js';
import { InvalidCredentialsError, NotFoundError, ProviderError } from '../src/errors.js';

const snsSend = vi.fn();
vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient {
    send = snsSend;
  }
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    SNSClient,
    CreateTopicCommand: class extends Command {},
    DeleteTopicCommand: class extends Command {},
    ListTopicsCommand: class extends Command {},
    PublishCommand: class extends Command {},
    SubscribeCommand: class extends Command {},
    UnsubscribeCommand: class extends Command {},
    ListSubscriptionsByTopicCommand: class extends Command {},
  };
});

const azureAdmin = {
  createTopic: vi.fn(),
  deleteTopic: vi.fn(),
  listTopics: vi.fn(),
  createSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
};
const azureSender = { sendMessages: vi.fn(), close: vi.fn() };
const azureCreateSender = vi.fn(() => azureSender);
vi.mock('@azure/service-bus', () => ({
  ServiceBusAdministrationClient: function ServiceBusAdministrationClient() {
    return azureAdmin;
  },
  ServiceBusClient: function ServiceBusClient() {
    return { createSender: azureCreateSender };
  },
}));

const gcpTopicObj = {
  name: 'projects/p/topics/my-topic',
  delete: vi.fn(),
  publishMessage: vi.fn(),
  getSubscriptions: vi.fn(),
};
const gcpSubscriptionObj = { name: 'projects/p/subscriptions/sub-1', delete: vi.fn() };
const gcpCreateTopic = vi.fn();
const gcpGetTopics = vi.fn();
const gcpCreateSubscription = vi.fn();
vi.mock('@google-cloud/pubsub', () => ({
  PubSub: function PubSub() {
    return {
      createTopic: gcpCreateTopic,
      getTopics: gcpGetTopics,
      topic: vi.fn(() => gcpTopicObj),
      subscription: vi.fn(() => gcpSubscriptionObj),
      createSubscription: gcpCreateSubscription,
    };
  },
}));

const ociControl = { createTopic: vi.fn(), deleteTopic: vi.fn(), listTopics: vi.fn(), region: undefined as unknown };
const ociData = {
  publishMessage: vi.fn(),
  createSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  region: undefined as unknown,
};
vi.mock('oci-ons', () => ({
  NotificationControlPlaneClient: function NotificationControlPlaneClient() {
    return ociControl;
  },
  NotificationDataPlaneClient: function NotificationDataPlaneClient() {
    return ociData;
  },
}));

const { SnsMessaging } = await import('../src/provider/aws/messaging.js');
const { ServiceBusMessaging } = await import('../src/provider/azure/messaging.js');
const { PubSubMessaging } = await import('../src/provider/gcp/messaging.js');
const { OnsMessaging } = await import('../src/provider/oci/messaging.js');

const awsCreds: AwsCredentials = { accessKey: 'ak', secretAccessKey: 'sk', region: 'us-east-1' };
const azureCreds: AzureCredentials = {
  tenantId: 't',
  clientId: 'c',
  clientSecret: 's',
  subscriptionId: 'sub',
};
const gcpCreds: GcpCredentials = {
  projectId: 'p',
  serviceAccountJson: JSON.stringify({ type: 'service_account', project_id: 'p' }),
};
const ociCreds: OciCredentials = {
  tenancyOcid: 'ocid1.tenancy.oc1..a',
  userOcid: 'ocid1.user.oc1..a',
  fingerprint: 'ff:ff',
  privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  region: 'us-ashburn-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createTopic happy path', () => {
  it('aws maps DisplayName into topic attributes and returns the ARN', async () => {
    snsSend.mockResolvedValueOnce({ TopicArn: 'arn:aws:sns:us-east-1:1:t1' });
    const id = await new SnsMessaging(awsCreds).createTopic('t1', { displayName: 'My Topic' });
    expect(id).toBe('arn:aws:sns:us-east-1:1:t1');
    const cmd = snsSend.mock.calls[0][0];
    expect(cmd.input).toEqual({ Name: 't1', Attributes: { DisplayName: 'My Topic' } });
  });

  it('azure creates a topic by name and returns the name as id', async () => {
    azureAdmin.createTopic.mockResolvedValueOnce({});
    const id = await new ServiceBusMessaging(azureCreds, 'ns').createTopic('t1');
    expect(id).toBe('t1');
    expect(azureAdmin.createTopic).toHaveBeenCalledWith('t1');
  });

  it('gcp creates a topic and returns the fully-qualified name', async () => {
    gcpCreateTopic.mockResolvedValueOnce([gcpTopicObj]);
    const id = await new PubSubMessaging(gcpCreds).createTopic('my-topic');
    expect(id).toBe('projects/p/topics/my-topic');
    expect(gcpCreateTopic).toHaveBeenCalledWith('my-topic');
  });

  it('oci maps DisplayName into description and returns the topic OCID', async () => {
    ociControl.createTopic.mockResolvedValueOnce({ notificationTopic: { topicId: 'ocid1.onstopic.oc1..t1' } });
    const id = await new OnsMessaging(ociCreds, 'ocid1.compartment.oc1..c').createTopic('t1', {
      displayName: 'My Topic',
    });
    expect(id).toBe('ocid1.onstopic.oc1..t1');
    expect(ociControl.createTopic).toHaveBeenCalledWith({
      createTopicDetails: { name: 't1', compartmentId: 'ocid1.compartment.oc1..c', description: 'My Topic' },
    });
  });
});

describe('provider errors are wrapped', () => {
  it('aws send failure becomes a ProviderError', async () => {
    snsSend.mockRejectedValueOnce(new Error('boom'));
    await expect(new SnsMessaging(awsCreds).deleteTopic('arn')).rejects.toBeInstanceOf(ProviderError);
  });

  it('azure createTopic failure becomes a ProviderError', async () => {
    azureAdmin.createTopic.mockRejectedValueOnce(new Error('boom'));
    await expect(new ServiceBusMessaging(azureCreds, 'ns').createTopic('t1')).rejects.toBeInstanceOf(ProviderError);
  });

  it('gcp publish failure becomes a ProviderError', async () => {
    gcpTopicObj.publishMessage.mockRejectedValueOnce(new Error('boom'));
    await expect(new PubSubMessaging(gcpCreds).publish('t1', 'hi')).rejects.toBeInstanceOf(ProviderError);
  });

  it('oci deleteTopic failure becomes a ProviderError', async () => {
    ociControl.deleteTopic.mockRejectedValueOnce(new Error('boom'));
    await expect(new OnsMessaging(ociCreds, 'c1').deleteTopic('t1')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('oci defensive not-found mapping', () => {
  it('createTopic throws NotFoundError when the response has no topic id', async () => {
    ociControl.createTopic.mockResolvedValueOnce({ notificationTopic: {} });
    await expect(new OnsMessaging(ociCreds, 'c1').createTopic('t1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('subscribe throws NotFoundError when the response has no subscription id', async () => {
    ociData.createSubscription.mockResolvedValueOnce({ subscription: {} });
    await expect(new OnsMessaging(ociCreds, 'c1').subscribe('t1', 'EMAIL', 'a@b.com')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('publish', () => {
  it('aws forwards subject and string attributes', async () => {
    snsSend.mockResolvedValueOnce({ MessageId: 'm1' });
    const id = await new SnsMessaging(awsCreds).publish('arn', 'hello', {
      subject: 'subj',
      attributes: { k: 'v' },
    });
    expect(id).toBe('m1');
    const cmd = snsSend.mock.calls[0][0];
    expect(cmd.input).toEqual({
      TopicArn: 'arn',
      Message: 'hello',
      Subject: 'subj',
      MessageAttributes: { k: { DataType: 'String', StringValue: 'v' } },
    });
  });

  it('azure sends the message and returns the topic id, closing the sender', async () => {
    azureSender.sendMessages.mockResolvedValueOnce(undefined);
    const id = await new ServiceBusMessaging(azureCreds, 'ns').publish('t1', 'hello', { subject: 'subj' });
    expect(id).toBe('t1');
    expect(azureCreateSender).toHaveBeenCalledWith('t1');
    expect(azureSender.sendMessages).toHaveBeenCalledWith({ body: 'hello', subject: 'subj' });
    expect(azureSender.close).toHaveBeenCalled();
  });

  it('gcp publishes buffered data with attributes and returns the message id', async () => {
    gcpTopicObj.publishMessage.mockResolvedValueOnce('m1');
    const id = await new PubSubMessaging(gcpCreds).publish('t1', 'hello', { attributes: { k: 'v' } });
    expect(id).toBe('m1');
    expect(gcpTopicObj.publishMessage).toHaveBeenCalledWith({ data: Buffer.from('hello'), attributes: { k: 'v' } });
  });

  it('oci falls back to opcRequestId when no message id is returned', async () => {
    ociData.publishMessage.mockResolvedValueOnce({ opcRequestId: 'req-1', publishResult: {} });
    const id = await new OnsMessaging(ociCreds, 'c1').publish('t1', 'hello');
    expect(id).toBe('req-1');
  });
});

describe('subscribe / unsubscribe / listSubscriptions', () => {
  it('aws subscribes with protocol and endpoint natively', async () => {
    snsSend.mockResolvedValueOnce({ SubscriptionArn: 'sub-arn' });
    const id = await new SnsMessaging(awsCreds).subscribe('arn', 'email', 'a@b.com');
    expect(id).toBe('sub-arn');
    expect(snsSend.mock.calls[0][0].input).toEqual({ TopicArn: 'arn', Protocol: 'email', Endpoint: 'a@b.com' });
  });

  it('azure sanitizes the endpoint into a subscription name and encodes id as topicId|subName', async () => {
    azureAdmin.createSubscription.mockResolvedValueOnce({});
    const id = await new ServiceBusMessaging(azureCreds, 'ns').subscribe('t1', 'https', 'https://a.b/c?d=1');
    expect(id).toBe('t1|httpsabcd1');
    expect(azureAdmin.createSubscription).toHaveBeenCalledWith('t1', 'httpsabcd1');
  });

  it('azure unsubscribe rejects a malformed subscription id', async () => {
    await expect(new ServiceBusMessaging(azureCreds, 'ns').unsubscribe('no-pipe')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('azure unsubscribe splits topicId|subName and deletes the subscription', async () => {
    azureAdmin.deleteSubscription.mockResolvedValueOnce({});
    await new ServiceBusMessaging(azureCreds, 'ns').unsubscribe('t1|sub1');
    expect(azureAdmin.deleteSubscription).toHaveBeenCalledWith('t1', 'sub1');
  });

  it('gcp subscribe with an endpoint creates a push subscription', async () => {
    gcpCreateSubscription.mockResolvedValueOnce([{}]);
    const id = await new PubSubMessaging(gcpCreds).subscribe('projects/p/topics/t1', 'push', 'https://a.b/push');
    expect(gcpCreateSubscription).toHaveBeenCalledWith(
      'projects/p/topics/t1',
      expect.stringMatching(/^t1-[0-9a-f]{12}$/),
      { pushEndpoint: 'https://a.b/push' },
    );
    expect(id).toMatch(/^t1-[0-9a-f]{12}$/);
  });

  it('gcp subscribe without an endpoint creates a pull subscription', async () => {
    gcpCreateSubscription.mockResolvedValueOnce([{}]);
    await new PubSubMessaging(gcpCreds).subscribe('t1', 'pull', '');
    expect(gcpCreateSubscription).toHaveBeenCalledWith('t1', expect.any(String), {});
  });

  it('gcp listSubscriptions reports push protocol and endpoint from metadata', async () => {
    gcpTopicObj.getSubscriptions.mockResolvedValueOnce([
      [{ name: 'sub-1', getMetadata: vi.fn().mockResolvedValueOnce([{ pushConfig: { pushEndpoint: 'https://e' } }]) }],
    ]);
    const subs = await new PubSubMessaging(gcpCreds).listSubscriptions('t1');
    expect(subs).toEqual([{ id: 'sub-1', topicId: 't1', protocol: 'push', endpoint: 'https://e' }]);
  });

  it('oci subscribe passes protocol and endpoint through natively', async () => {
    ociData.createSubscription.mockResolvedValueOnce({ subscription: { id: 'sub-ocid' } });
    const id = await new OnsMessaging(ociCreds, 'c1').subscribe('t1', 'EMAIL', 'a@b.com');
    expect(id).toBe('sub-ocid');
    expect(ociData.createSubscription).toHaveBeenCalledWith({
      createSubscriptionDetails: { topicId: 't1', compartmentId: 'c1', protocol: 'EMAIL', endpoint: 'a@b.com' },
    });
  });
});

describe('listTopics', () => {
  it('aws paginates over NextToken', async () => {
    snsSend
      .mockResolvedValueOnce({ Topics: [{ TopicArn: 'arn1' }], NextToken: 'tok' })
      .mockResolvedValueOnce({ Topics: [{ TopicArn: 'arn2' }] });
    const topics = await new SnsMessaging(awsCreds).listTopics();
    expect(topics).toEqual([
      { id: 'arn1', arn: 'arn1', name: 'arn1' },
      { id: 'arn2', arn: 'arn2', name: 'arn2' },
    ]);
    expect(snsSend).toHaveBeenCalledTimes(2);
  });

  it('azure iterates the admin pager', async () => {
    azureAdmin.listTopics.mockReturnValueOnce(
      (async function* () {
        yield { name: 't1' };
        yield { name: 't2' };
      })(),
    );
    const topics = await new ServiceBusMessaging(azureCreds, 'ns').listTopics();
    expect(topics).toEqual([
      { id: 't1', name: 't1', arn: '' },
      { id: 't2', name: 't2', arn: '' },
    ]);
  });

  it('oci paginates over opcNextPage', async () => {
    ociControl.listTopics
      .mockResolvedValueOnce({ items: [{ topicId: 'ocid1', name: 't1' }], opcNextPage: 'p2' })
      .mockResolvedValueOnce({ items: [{ topicId: 'ocid2', name: 't2' }] });
    const topics = await new OnsMessaging(ociCreds, 'c1').listTopics();
    expect(topics).toEqual([
      { id: 'ocid1', arn: 'ocid1', name: 't1' },
      { id: 'ocid2', arn: 'ocid2', name: 't2' },
    ]);
    expect(ociControl.listTopics).toHaveBeenCalledTimes(2);
  });
});
