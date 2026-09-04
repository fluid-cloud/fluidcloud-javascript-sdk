import { createHash } from 'node:crypto';

import { PubSub } from '@google-cloud/pubsub';

import type { GcpCredentials } from '../../credentials/index.js';
import { wrapProviderError } from '../../errors.js';
import type {
  Messaging,
  MessagingCreateTopicOptions,
  PublishOptions,
  SubscriptionInfo,
  TopicInfo,
} from '../types/messaging.js';
import { gcpClientConfig } from './auth.js';

/** Returns a short, deterministic hex digest of s, used to derive stable subscription ids. */
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/** GCP Pub/Sub implementation of Messaging. */
export class PubSubMessaging implements Messaging {
  private readonly client: PubSub;

  constructor(creds: GcpCredentials) {
    this.client = new PubSub(gcpClientConfig(creds));
  }

  /** Creates a Pub/Sub topic and returns its fully-qualified name. */
  async createTopic(name: string, _opts?: MessagingCreateTopicOptions): Promise<string> {
    try {
      const [topic] = await this.client.createTopic(name);
      return topic.name;
    } catch (err) {
      return wrapProviderError('gcp', 'createTopic', err);
    }
  }

  /** Deletes a Pub/Sub topic. */
  async deleteTopic(topicId: string): Promise<void> {
    try {
      await this.client.topic(topicId).delete();
    } catch (err) {
      wrapProviderError('gcp', 'deleteTopic', err);
    }
  }

  /** Lists all Pub/Sub topics in the project. */
  async listTopics(): Promise<TopicInfo[]> {
    try {
      const [topics] = await this.client.getTopics();
      return topics.map((t) => ({ id: t.name, name: t.name, arn: t.name }));
    } catch (err) {
      return wrapProviderError('gcp', 'listTopics', err);
    }
  }

  /** Publishes a message to a Pub/Sub topic. */
  async publish(topicId: string, message: string, opts?: PublishOptions): Promise<string> {
    try {
      return await this.client.topic(topicId).publishMessage({
        data: Buffer.from(message),
        ...(opts?.attributes ? { attributes: opts.attributes } : {}),
      });
    } catch (err) {
      return wrapProviderError('gcp', 'publish', err);
    }
  }

  /** Creates a subscription on a topic; a non-empty endpoint yields a push subscription. */
  async subscribe(topicId: string, _protocol: string, endpoint: string): Promise<string> {
    const topicShortName = topicId.includes('/') ? topicId.slice(topicId.lastIndexOf('/') + 1) : topicId;
    const subId = `${topicShortName}-${shortHash(endpoint)}`;
    try {
      await this.client.createSubscription(topicId, subId, endpoint ? { pushEndpoint: endpoint } : {});
      return subId;
    } catch (err) {
      return wrapProviderError('gcp', 'subscribe', err);
    }
  }

  /** Deletes a Pub/Sub subscription. */
  async unsubscribe(subscriptionId: string): Promise<void> {
    try {
      await this.client.subscription(subscriptionId).delete();
    } catch (err) {
      wrapProviderError('gcp', 'unsubscribe', err);
    }
  }

  /** Lists all subscriptions on a topic. */
  async listSubscriptions(topicId: string): Promise<SubscriptionInfo[]> {
    const result: SubscriptionInfo[] = [];
    try {
      const [subs] = await this.client.topic(topicId).getSubscriptions();
      for (const sub of subs) {
        const info: SubscriptionInfo = { id: sub.name, topicId, protocol: 'pull', endpoint: '' };
        try {
          const [metadata] = await sub.getMetadata();
          const pushEndpoint = metadata.pushConfig?.pushEndpoint;
          if (pushEndpoint) {
            info.protocol = 'push';
            info.endpoint = pushEndpoint;
          }
        } catch {}
        result.push(info);
      }
    } catch (err) {
      wrapProviderError('gcp', 'listSubscriptions', err);
    }
    return result;
  }
}
