import { models, QueueAdminClient, QueueClient } from 'oci-queue';

import type { OciCredentials } from '../../credentials/index.js';
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
import { ociAuthProvider } from './auth.js';

/** OCI Queue Service-backed implementation of Queue. */
export class OciQueue implements Queue {
  private readonly mgmtClient: QueueAdminClient;
  private readonly dataClient: QueueClient;
  private readonly compartment: string;

  constructor(creds: OciCredentials, compartment: string) {
    const provider = ociAuthProvider(creds);
    this.mgmtClient = new QueueAdminClient({ authenticationDetailsProvider: provider });
    this.dataClient = new QueueClient({ authenticationDetailsProvider: provider });
    this.compartment = compartment || creds.compartmentOcid || '';
    if (creds.region) {
      this.mgmtClient.regionId = creds.region;
      this.dataClient.regionId = creds.region;
    }
  }

  /** Creates a new OCI queue and returns the async work request id as a reference. */
  async createQueue(name: string, opts?: QueueCreateOptions): Promise<string> {
    const details: models.CreateQueueDetails = {
      displayName: name,
      compartmentId: this.compartment,
      ...(opts?.visibilityTimeoutSeconds ? { visibilityInSeconds: opts.visibilityTimeoutSeconds } : {}),
      ...(opts?.messageRetentionSeconds ? { retentionInSeconds: opts.messageRetentionSeconds } : {}),
    };
    try {
      const resp = await this.mgmtClient.createQueue({ createQueueDetails: details });
      return resp.opcWorkRequestId || resp.opcRequestId || '';
    } catch (err) {
      wrapProviderError('oci', 'createQueue', err);
    }
  }

  /** Deletes an OCI queue by OCID. */
  async deleteQueue(queueId: string): Promise<void> {
    try {
      await this.mgmtClient.deleteQueue({ queueId });
    } catch (err) {
      wrapProviderError('oci', 'deleteQueue', err);
    }
  }

  /** Lists all queues in the compartment. */
  async listQueues(): Promise<QueueInfo[]> {
    const results: QueueInfo[] = [];
    let page: string | undefined;
    try {
      do {
        const resp = await this.mgmtClient.listQueues({ compartmentId: this.compartment, page });
        for (const item of resp.queueCollection.items) {
          results.push({ id: item.id, name: item.displayName ?? '', url: item.messagesEndpoint });
        }
        page = resp.opcNextPage;
      } while (page);
    } catch (err) {
      wrapProviderError('oci', 'listQueues', err);
    }
    return results;
  }

  /**
   * Sends a message. Both options are ignored, and neither is expressible on OCI
   * Queue: there is no per-message enqueue delay, and custom properties can only
   * ride on message metadata, which requires a channel id and would change
   * delivery routing rather than simply annotating the message.
   */
  async sendMessage(queueId: string, body: string, _opts?: SendMessageOptions): Promise<string> {
    try {
      const resp = await this.dataClient.putMessages({
        queueId,
        putMessagesDetails: { messages: [{ content: body }] },
      });
      const msg = resp.putMessages.messages[0];
      return msg ? String(msg.id) : '';
    } catch (err) {
      wrapProviderError('oci', 'sendMessage', err);
    }
  }

  /** Receives messages from an OCI queue, honoring visibility and wait timeouts. */
  async receiveMessages(queueId: string, maxMessages: number, opts?: ReceiveMessageOptions): Promise<QueueMessage[]> {
    const limit = maxMessages > 0 ? maxMessages : 1;
    try {
      const resp = await this.dataClient.getMessages({
        queueId,
        limit,
        ...(opts?.visibilityTimeoutSeconds ? { visibilityInSeconds: opts.visibilityTimeoutSeconds } : {}),
        ...(opts?.waitTimeSeconds ? { timeoutInSeconds: opts.waitTimeSeconds } : {}),
      });
      return resp.getMessages.messages.map((m) => ({
        id: String(m.id),
        body: m.content ?? '',
        receiptHandle: m.receipt,
        attributes: { ...(m.metadata?.customProperties ?? {}) },
      }));
    } catch (err) {
      wrapProviderError('oci', 'receiveMessages', err);
    }
  }

  /** Deletes a message from an OCI queue using its receipt handle. */
  async deleteMessage(queueId: string, receiptHandle: string): Promise<void> {
    try {
      await this.dataClient.deleteMessage({ queueId, messageReceipt: receiptHandle });
    } catch (err) {
      wrapProviderError('oci', 'deleteMessage', err);
    }
  }

  /** Returns queue attributes from OCI. Message count is not exposed by GetQueue. */
  async getQueueAttributes(queueId: string): Promise<QueueAttributes> {
    try {
      const resp = await this.mgmtClient.getQueue({ queueId });
      return {
        approximateMessageCount: 0,
        visibilityTimeoutSeconds: resp.queue.visibilityInSeconds ?? 0,
        messageRetentionSeconds: resp.queue.retentionInSeconds ?? 0,
      };
    } catch (err) {
      wrapProviderError('oci', 'getQueueAttributes', err);
    }
  }
}
