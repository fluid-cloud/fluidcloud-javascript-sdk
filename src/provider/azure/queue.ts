import { randomUUID } from 'node:crypto';

import { ServiceBusAdministrationClient, ServiceBusClient, type ServiceBusReceivedMessage, type ServiceBusReceiver } from '@azure/service-bus';

import type { AzureCredentials } from '../../credentials/index.js';
import { NotFoundError, wrapProviderError } from '../../errors.js';
import type {
  Queue,
  QueueAttributes,
  QueueCreateOptions,
  QueueInfo,
  QueueMessage,
  ReceiveMessageOptions,
  SendMessageOptions,
} from '../types/queue.js';
import { azureCredential } from './auth.js';

/** Azure Service Bus-backed implementation of Queue. */
export class ServiceBusQueue implements Queue {
  private readonly adminClient: ServiceBusAdministrationClient;
  private readonly sbClient: ServiceBusClient;
  private readonly namespace: string;
  private readonly receivers = new Map<string, ServiceBusReceiver>();
  private readonly messages = new Map<string, ServiceBusReceivedMessage>();

  constructor(creds: AzureCredentials, namespace: string) {
    const credential = azureCredential(creds);
    const fqns = `${namespace}.servicebus.windows.net`;
    this.adminClient = new ServiceBusAdministrationClient(fqns, credential);
    this.sbClient = new ServiceBusClient(fqns, credential);
    this.namespace = namespace;
  }

  /** Creates a new Azure Service Bus queue and returns its name as the id. */
  async createQueue(name: string, opts?: QueueCreateOptions): Promise<string> {
    try {
      await this.adminClient.createQueue(name, {
        ...(opts?.visibilityTimeoutSeconds ? { lockDuration: `PT${opts.visibilityTimeoutSeconds}S` } : {}),
      });
      return name;
    } catch (err) {
      wrapProviderError('azure', 'createQueue', err);
    }
  }

  /** Deletes an Azure Service Bus queue. */
  async deleteQueue(queueId: string): Promise<void> {
    try {
      await this.adminClient.deleteQueue(queueId);
    } catch (err) {
      wrapProviderError('azure', 'deleteQueue', err);
    }
  }

  /** Lists all queues in the namespace. */
  async listQueues(): Promise<QueueInfo[]> {
    const result: QueueInfo[] = [];
    try {
      for await (const item of this.adminClient.listQueues()) {
        result.push({
          id: item.name,
          name: item.name,
          url: `https://${this.namespace}.servicebus.windows.net/${item.name}`,
        });
      }
    } catch (err) {
      wrapProviderError('azure', 'listQueues', err);
    }
    return result;
  }

  /** Sends a message to the given queue and returns a generated message id. */
  async sendMessage(queueId: string, body: string, opts?: SendMessageOptions): Promise<string> {
    const sender = this.sbClient.createSender(queueId);
    try {
      const id = randomUUID();
      await sender.sendMessages({
        body,
        messageId: id,
        ...(opts?.delaySeconds ? { scheduledEnqueueTimeUtc: new Date(Date.now() + opts.delaySeconds * 1000) } : {}),
        ...(opts?.attributes && Object.keys(opts.attributes).length > 0 ? { applicationProperties: opts.attributes } : {}),
      });
      return id;
    } catch (err) {
      wrapProviderError('azure', 'sendMessage', err);
    } finally {
      await sender.close();
    }
  }

  private async getOrCreateReceiver(queueId: string): Promise<ServiceBusReceiver> {
    const existing = this.receivers.get(queueId);
    if (existing) return existing;
    const receiver = this.sbClient.createReceiver(queueId, { receiveMode: 'peekLock' });
    this.receivers.set(queueId, receiver);
    return receiver;
  }

  /**
   * Receives up to maxMessages messages. waitTimeSeconds bounds how long the call
   * blocks. visibilityTimeoutSeconds is ignored: Service Bus takes the lock
   * duration from the queue definition, not from the receive call.
   */
  async receiveMessages(queueId: string, maxMessages: number, opts?: ReceiveMessageOptions): Promise<QueueMessage[]> {
    try {
      const receiver = await this.getOrCreateReceiver(queueId);
      const msgs = await receiver.receiveMessages(
        maxMessages,
        opts?.waitTimeSeconds ? { maxWaitTimeInMs: opts.waitTimeSeconds * 1000 } : undefined,
      );
      const result: QueueMessage[] = [];
      for (const msg of msgs) {
        const token = msg.lockToken ?? '';
        this.messages.set(token, msg);
        result.push({
          id: String(msg.messageId ?? ''),
          body: typeof msg.body === 'string' ? msg.body : String(msg.body),
          receiptHandle: token,
          attributes: Object.fromEntries(
            Object.entries(msg.applicationProperties ?? {}).map(([k, v]) => [k, String(v)]),
          ),
        });
      }
      return result;
    } catch (err) {
      wrapProviderError('azure', 'receiveMessages', err);
    }
  }

  /** Completes (deletes) a message using its receipt handle (lock token). */
  async deleteMessage(queueId: string, receiptHandle: string): Promise<void> {
    const msg = this.messages.get(receiptHandle);
    if (!msg) throw new NotFoundError(`message with receipt handle "${receiptHandle}" not found in cache`);
    try {
      const receiver = await this.getOrCreateReceiver(queueId);
      await receiver.completeMessage(msg);
      this.messages.delete(receiptHandle);
    } catch (err) {
      wrapProviderError('azure', 'deleteMessage', err);
    }
  }

  /** Returns attributes for the given queue. */
  async getQueueAttributes(queueId: string): Promise<QueueAttributes> {
    try {
      const runtimeProps = await this.adminClient.getQueueRuntimeProperties(queueId);
      return {
        approximateMessageCount: runtimeProps.totalMessageCount ?? 0,
        visibilityTimeoutSeconds: 0,
        messageRetentionSeconds: 0,
      };
    } catch (err) {
      wrapProviderError('azure', 'getQueueAttributes', err);
    }
  }
}
