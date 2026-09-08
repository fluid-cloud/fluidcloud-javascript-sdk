import * as common from 'oci-common';
import { type models, NotificationControlPlaneClient, NotificationDataPlaneClient } from 'oci-ons';

import type { OciCredentials } from '../../credentials/index.js';
import { NotFoundError, wrapProviderError } from '../../errors.js';
import type {
  Messaging,
  MessagingCreateTopicOptions,
  PublishOptions,
  SubscriptionInfo,
  TopicInfo,
} from '../types/messaging.js';
import { ociAuthProvider } from './auth.js';

/** OCI Notifications Service (ONS) implementation of Messaging. */
export class OnsMessaging implements Messaging {
  private readonly controlClient: NotificationControlPlaneClient;
  private readonly dataClient: NotificationDataPlaneClient;
  private readonly compartment: string;

  constructor(creds: OciCredentials, compartment: string) {
    const provider = ociAuthProvider(creds);
    this.controlClient = new NotificationControlPlaneClient({ authenticationDetailsProvider: provider });
    this.dataClient = new NotificationDataPlaneClient({ authenticationDetailsProvider: provider });
    if (creds.region) {
      this.controlClient.region = common.Region.fromRegionId(creds.region);
      this.dataClient.region = common.Region.fromRegionId(creds.region);
    }
    this.compartment = compartment || creds.compartmentOcid || '';
  }

  /** Creates an ONS topic and returns its OCID. */
  async createTopic(name: string, opts?: MessagingCreateTopicOptions): Promise<string> {
    const details: models.CreateTopicDetails = { name, compartmentId: this.compartment };
    if (opts?.displayName) details.description = opts.displayName;
    let resp;
    try {
      resp = await this.controlClient.createTopic({ createTopicDetails: details });
    } catch (err) {
      return wrapProviderError('oci', 'createTopic', err);
    }
    const topicId = resp.notificationTopic?.topicId;
    if (!topicId) throw new NotFoundError('topic id missing from create response');
    return topicId;
  }

  /** Deletes an ONS topic by OCID. */
  async deleteTopic(topicId: string): Promise<void> {
    try {
      await this.controlClient.deleteTopic({ topicId });
    } catch (err) {
      wrapProviderError('oci', 'deleteTopic', err);
    }
  }

  /** Lists all ONS topics in the compartment. */
  async listTopics(): Promise<TopicInfo[]> {
    const results: TopicInfo[] = [];
    let page: string | undefined;
    try {
      do {
        const resp = await this.controlClient.listTopics({ compartmentId: this.compartment, page });
        for (const t of resp.items ?? []) {
          results.push({ id: t.topicId ?? '', arn: t.topicId ?? '', name: t.name ?? '' });
        }
        page = resp.opcNextPage;
      } while (page);
    } catch (err) {
      wrapProviderError('oci', 'listTopics', err);
    }
    return results;
  }

  /** Publishes a message to an ONS topic. */
  async publish(topicId: string, message: string, opts?: PublishOptions): Promise<string> {
    try {
      const resp = await this.dataClient.publishMessage({
        topicId,
        messageDetails: { body: message, title: opts?.subject ?? '' },
      });
      if (resp.publishResult?.messageId) return resp.publishResult.messageId;
      return resp.opcRequestId ?? '';
    } catch (err) {
      return wrapProviderError('oci', 'publish', err);
    }
  }

  /** Creates a subscription to an ONS topic. */
  async subscribe(topicId: string, protocol: string, endpoint: string): Promise<string> {
    let resp;
    try {
      resp = await this.dataClient.createSubscription({
        createSubscriptionDetails: { topicId, compartmentId: this.compartment, protocol, endpoint },
      });
    } catch (err) {
      return wrapProviderError('oci', 'createSubscription', err);
    }
    const id = resp.subscription?.id;
    if (!id) throw new NotFoundError('subscription id missing from create response');
    return id;
  }

  /** Deletes a subscription. */
  async unsubscribe(subscriptionId: string): Promise<void> {
    try {
      await this.dataClient.deleteSubscription({ subscriptionId });
    } catch (err) {
      wrapProviderError('oci', 'deleteSubscription', err);
    }
  }

  /** Lists all subscriptions for a topic. */
  async listSubscriptions(topicId: string): Promise<SubscriptionInfo[]> {
    const results: SubscriptionInfo[] = [];
    let page: string | undefined;
    try {
      do {
        const resp = await this.dataClient.listSubscriptions({ compartmentId: this.compartment, topicId, page });
        for (const sub of resp.items ?? []) {
          results.push({
            id: sub.id ?? '',
            topicId: sub.topicId ?? '',
            protocol: sub.protocol ?? '',
            endpoint: sub.endpoint ?? '',
          });
        }
        page = resp.opcNextPage;
      } while (page);
    } catch (err) {
      wrapProviderError('oci', 'listSubscriptions', err);
    }
    return results;
  }
}
