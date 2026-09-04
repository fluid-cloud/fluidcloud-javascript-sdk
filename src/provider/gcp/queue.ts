import { PubSub, v1, type CreateSubscriptionOptions } from '@google-cloud/pubsub';

import type { GcpCredentials } from '../../credentials/index.js';
import { wrapProviderError } from '../../errors.js';
import type {
  Queue,
  QueueAttributes,
  QueueCreateOptions,
  QueueInfo,
  QueueMessage,
  ReceiveMessageOptions,
  SendMessageOptions,
} from '../types/queue.js';
import { gcpClientConfig } from './auth.js';

/**
 * Pub/Sub-backed implementation of Queue. A "queue" is modeled as a topic
 * plus a pull subscription of the same id. receiveMessages/deleteMessage use
 * the low-level Pull/Acknowledge API so the ack id acts as a receipt handle.
 */
export class PubSubQueue implements Queue {
  private readonly client: PubSub;
  private readonly subClient: v1.SubscriberClient;
  private readonly projectId: string;

  constructor(creds: GcpCredentials) {
    const cfg = gcpClientConfig(creds);
    this.client = new PubSub(cfg);
    this.subClient = new v1.SubscriberClient(cfg as unknown as ConstructorParameters<typeof v1.SubscriberClient>[0]);
    this.projectId = creds.projectId;
  }

  private subFullName(queueId: string): string {
    return `projects/${this.projectId}/subscriptions/${queueId}`;
  }

  /** Creates a topic and pull subscription pair and returns the shared id. */
  async createQueue(name: string, opts?: QueueCreateOptions): Promise<string> {
    try {
      const [topic] = await this.client.createTopic(name);
      const subOpts: CreateSubscriptionOptions = {};
      if (opts?.messageRetentionSeconds) subOpts.messageRetentionDuration = opts.messageRetentionSeconds;
      if (opts?.visibilityTimeoutSeconds) subOpts.ackDeadlineSeconds = opts.visibilityTimeoutSeconds;
      await this.client.createSubscription(topic, name, subOpts);
      return name;
    } catch (err) {
      wrapProviderError('gcp', 'createQueue', err);
    }
  }

  /** Deletes the subscription and topic backing a queue. */
  async deleteQueue(queueId: string): Promise<void> {
    await this.client
      .subscription(queueId)
      .delete()
      .catch(() => {});
    try {
      await this.client.topic(queueId).delete();
    } catch (err) {
      wrapProviderError('gcp', 'deleteQueue', err);
    }
  }

  /** Lists all subscriptions in the project. */
  async listQueues(): Promise<QueueInfo[]> {
    try {
      const [subs] = await this.client.getSubscriptions();
      return subs.map((sub) => {
        const id = sub.name.split('/').pop() ?? sub.name;
        return { id, name: id, url: sub.name };
      });
    } catch (err) {
      wrapProviderError('gcp', 'listQueues', err);
    }
  }

  /** Publishes a message to the queue's topic and returns the message id. */
  async sendMessage(queueId: string, body: string, opts?: SendMessageOptions): Promise<string> {
    try {
      return await this.client.topic(queueId).publishMessage({
        data: Buffer.from(body),
        ...(opts?.attributes ? { attributes: opts.attributes } : {}),
      });
    } catch (err) {
      wrapProviderError('gcp', 'sendMessage', err);
    }
  }

  /** Pulls up to maxMessages messages using the low-level Subscriber API. */
  async receiveMessages(queueId: string, maxMessages: number, _opts?: ReceiveMessageOptions): Promise<QueueMessage[]> {
    const limit = maxMessages > 0 ? maxMessages : 1;
    try {
      const [resp] = await this.subClient.pull({
        subscription: this.subFullName(queueId),
        maxMessages: limit,
      });
      return (resp.receivedMessages ?? []).map((rm) => ({
        id: rm.message?.messageId ?? '',
        body: rm.message?.data ? Buffer.from(rm.message.data).toString() : '',
        receiptHandle: rm.ackId ?? '',
        attributes: (rm.message?.attributes as Record<string, string>) ?? {},
      }));
    } catch (err) {
      wrapProviderError('gcp', 'receiveMessages', err);
    }
  }

  /** Acknowledges a message using its ack id. */
  async deleteMessage(queueId: string, receiptHandle: string): Promise<void> {
    try {
      await this.subClient.acknowledge({
        subscription: this.subFullName(queueId),
        ackIds: [receiptHandle],
      });
    } catch (err) {
      wrapProviderError('gcp', 'deleteMessage', err);
    }
  }

  /** Reads the subscription's ack deadline and retention as queue attributes. */
  async getQueueAttributes(queueId: string): Promise<QueueAttributes> {
    try {
      const [cfg] = await this.client.subscription(queueId).getMetadata();
      const retention = cfg.messageRetentionDuration;
      const retentionSeconds =
        typeof retention === 'object' && retention !== null ? Number(retention.seconds ?? 0) : 0;
      return {
        approximateMessageCount: 0,
        visibilityTimeoutSeconds: cfg.ackDeadlineSeconds ?? 0,
        messageRetentionSeconds: retentionSeconds,
      };
    } catch (err) {
      wrapProviderError('gcp', 'getQueueAttributes', err);
    }
  }
}
