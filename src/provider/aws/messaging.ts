import {
  CreateTopicCommand,
  DeleteTopicCommand,
  ListSubscriptionsByTopicCommand,
  ListTopicsCommand,
  PublishCommand,
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
  type MessageAttributeValue,
} from '@aws-sdk/client-sns';

import type { AwsCredentials } from '../../credentials/index.js';
import { wrapProviderError } from '../../errors.js';
import type {
  Messaging,
  MessagingCreateTopicOptions,
  PublishOptions,
  SubscriptionInfo,
  TopicInfo,
} from '../types/messaging.js';
import { awsClientConfig } from './auth.js';

/** AWS SNS implementation of Messaging. */
export class SnsMessaging implements Messaging {
  private readonly client: SNSClient;

  constructor(creds: AwsCredentials) {
    this.client = new SNSClient(awsClientConfig(creds));
  }

  /** Creates an SNS topic and returns its ARN. */
  async createTopic(name: string, opts?: MessagingCreateTopicOptions): Promise<string> {
    try {
      const out = await this.client.send(
        new CreateTopicCommand({
          Name: name,
          ...(opts?.displayName ? { Attributes: { DisplayName: opts.displayName } } : {}),
        }),
      );
      return out.TopicArn ?? '';
    } catch (err) {
      return wrapProviderError('aws', 'createTopic', err);
    }
  }

  /** Deletes an SNS topic by ARN. */
  async deleteTopic(topicId: string): Promise<void> {
    try {
      await this.client.send(new DeleteTopicCommand({ TopicArn: topicId }));
    } catch (err) {
      wrapProviderError('aws', 'deleteTopic', err);
    }
  }

  /** Lists all SNS topics. */
  async listTopics(): Promise<TopicInfo[]> {
    const topics: TopicInfo[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.client.send(new ListTopicsCommand({ NextToken: nextToken }));
        for (const t of out.Topics ?? []) {
          const arn = t.TopicArn ?? '';
          topics.push({ id: arn, arn, name: arn });
        }
        nextToken = out.NextToken;
      } while (nextToken);
    } catch (err) {
      wrapProviderError('aws', 'listTopics', err);
    }
    return topics;
  }

  /** Publishes a message to an SNS topic. */
  async publish(topicId: string, message: string, opts?: PublishOptions): Promise<string> {
    let messageAttributes: Record<string, MessageAttributeValue> | undefined;
    if (opts?.attributes && Object.keys(opts.attributes).length > 0) {
      messageAttributes = {};
      for (const [k, v] of Object.entries(opts.attributes)) {
        messageAttributes[k] = { DataType: 'String', StringValue: v };
      }
    }
    try {
      const out = await this.client.send(
        new PublishCommand({
          TopicArn: topicId,
          Message: message,
          ...(opts?.subject ? { Subject: opts.subject } : {}),
          ...(messageAttributes ? { MessageAttributes: messageAttributes } : {}),
        }),
      );
      return out.MessageId ?? '';
    } catch (err) {
      return wrapProviderError('aws', 'publish', err);
    }
  }

  /** Subscribes an endpoint to an SNS topic. */
  async subscribe(topicId: string, protocol: string, endpoint: string): Promise<string> {
    try {
      const out = await this.client.send(
        new SubscribeCommand({ TopicArn: topicId, Protocol: protocol, Endpoint: endpoint }),
      );
      return out.SubscriptionArn ?? '';
    } catch (err) {
      return wrapProviderError('aws', 'subscribe', err);
    }
  }

  /** Removes a subscription from an SNS topic. */
  async unsubscribe(subscriptionId: string): Promise<void> {
    try {
      await this.client.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionId }));
    } catch (err) {
      wrapProviderError('aws', 'unsubscribe', err);
    }
  }

  /** Lists all subscriptions for a given topic. */
  async listSubscriptions(topicId: string): Promise<SubscriptionInfo[]> {
    const subs: SubscriptionInfo[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.client.send(
          new ListSubscriptionsByTopicCommand({ TopicArn: topicId, NextToken: nextToken }),
        );
        for (const sub of out.Subscriptions ?? []) {
          subs.push({
            id: sub.SubscriptionArn ?? '',
            topicId: sub.TopicArn ?? '',
            protocol: sub.Protocol ?? '',
            endpoint: sub.Endpoint ?? '',
          });
        }
        nextToken = out.NextToken;
      } while (nextToken);
    } catch (err) {
      wrapProviderError('aws', 'listSubscriptions', err);
    }
    return subs;
  }
}
