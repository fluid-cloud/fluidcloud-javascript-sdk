import { ServiceBusAdministrationClient, ServiceBusClient, type ServiceBusMessage } from '@azure/service-bus';

import type { AzureCredentials } from '../../credentials/index.js';
import { InvalidCredentialsError, wrapProviderError } from '../../errors.js';
import type {
  Messaging,
  MessagingCreateTopicOptions,
  PublishOptions,
  SubscriptionInfo,
  TopicInfo,
} from '../types/messaging.js';
import { azureCredential } from './auth.js';

const NON_ALPHANUMERIC = /[^a-zA-Z0-9]/g;

/** Converts an endpoint into a valid subscription name (<= 50 chars, alphanumeric). */
function sanitizeSubscriptionName(endpoint: string): string {
  let name = endpoint.replace(NON_ALPHANUMERIC, '');
  if (name.length > 50) name = name.slice(0, 50);
  return name || 'default';
}

/** Azure Service Bus implementation of Messaging, using topics and subscriptions. */
export class ServiceBusMessaging implements Messaging {
  private readonly adminClient: ServiceBusAdministrationClient;
  private readonly sbClient: ServiceBusClient;

  constructor(creds: AzureCredentials, namespace: string) {
    if (!namespace) throw new InvalidCredentialsError('serviceBusNamespace is required for Azure messaging');
    const credential = azureCredential(creds);
    const fqns = `${namespace}.servicebus.windows.net`;
    this.adminClient = new ServiceBusAdministrationClient(fqns, credential);
    this.sbClient = new ServiceBusClient(fqns, credential);
  }

  /** Creates an Azure Service Bus topic and returns its name as the id. */
  async createTopic(name: string, _opts?: MessagingCreateTopicOptions): Promise<string> {
    try {
      await this.adminClient.createTopic(name);
      return name;
    } catch (err) {
      return wrapProviderError('azure', 'createTopic', err);
    }
  }

  /** Deletes an Azure Service Bus topic. */
  async deleteTopic(topicId: string): Promise<void> {
    try {
      await this.adminClient.deleteTopic(topicId);
    } catch (err) {
      wrapProviderError('azure', 'deleteTopic', err);
    }
  }

  /** Lists all topics in the namespace. */
  async listTopics(): Promise<TopicInfo[]> {
    const result: TopicInfo[] = [];
    try {
      for await (const t of this.adminClient.listTopics()) {
        result.push({ id: t.name, name: t.name, arn: '' });
      }
    } catch (err) {
      wrapProviderError('azure', 'listTopics', err);
    }
    return result;
  }

  /** Sends a message to the given topic. */
  async publish(topicId: string, message: string, opts?: PublishOptions): Promise<string> {
    let sender;
    try {
      sender = this.sbClient.createSender(topicId);
    } catch (err) {
      return wrapProviderError('azure', 'newSender', err);
    }
    try {
      const msg: ServiceBusMessage = { body: message, ...(opts?.subject ? { subject: opts.subject } : {}) };
      await sender.sendMessages(msg);
    } catch (err) {
      return wrapProviderError('azure', 'publish', err);
    } finally {
      await sender.close();
    }
    return topicId;
  }

  /** Creates a subscription for the topic and returns "topicId|subscriptionName". */
  async subscribe(topicId: string, _protocol: string, endpoint: string): Promise<string> {
    const subName = sanitizeSubscriptionName(endpoint);
    try {
      await this.adminClient.createSubscription(topicId, subName);
    } catch (err) {
      return wrapProviderError('azure', 'createSubscription', err);
    }
    return `${topicId}|${subName}`;
  }

  /** Deletes a subscription. subscriptionId must be "topicId|subscriptionName". */
  async unsubscribe(subscriptionId: string): Promise<void> {
    const sep = subscriptionId.indexOf('|');
    if (sep === -1) {
      throw new InvalidCredentialsError("invalid subscriptionID format; expected 'topicID|subscriptionName'");
    }
    const topicId = subscriptionId.slice(0, sep);
    const subName = subscriptionId.slice(sep + 1);
    try {
      await this.adminClient.deleteSubscription(topicId, subName);
    } catch (err) {
      wrapProviderError('azure', 'deleteSubscription', err);
    }
  }

  /** Lists all subscriptions for a topic. */
  async listSubscriptions(topicId: string): Promise<SubscriptionInfo[]> {
    const result: SubscriptionInfo[] = [];
    try {
      for await (const sub of this.adminClient.listSubscriptions(topicId)) {
        result.push({ id: `${topicId}|${sub.subscriptionName}`, topicId, protocol: '', endpoint: '' });
      }
    } catch (err) {
      wrapProviderError('azure', 'listSubscriptions', err);
    }
    return result;
  }
}
