import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  QueueAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import type { AwsCredentials } from '../../credentials/index.js';
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
import { awsClientConfig } from './auth.js';

/** SQS-backed implementation of Queue. */
export class SqsQueue implements Queue {
  private readonly client: SQSClient;

  constructor(creds: AwsCredentials) {
    this.client = new SQSClient(awsClientConfig(creds, creds.region));
  }

  /** Creates a new SQS queue and returns its URL. */
  async createQueue(name: string, opts?: QueueCreateOptions): Promise<string> {
    const attributes: Record<string, string> = {};
    if (opts?.visibilityTimeoutSeconds) attributes.VisibilityTimeout = String(opts.visibilityTimeoutSeconds);
    if (opts?.messageRetentionSeconds) attributes.MessageRetentionPeriod = String(opts.messageRetentionSeconds);
    try {
      const out = await this.client.send(
        new CreateQueueCommand({
          QueueName: name,
          ...(Object.keys(attributes).length > 0 ? { Attributes: attributes } : {}),
        }),
      );
      return out.QueueUrl ?? '';
    } catch (err) {
      wrapProviderError('aws', 'createQueue', err);
    }
  }

  /** Deletes an SQS queue by URL. */
  async deleteQueue(queueId: string): Promise<void> {
    try {
      await this.client.send(new DeleteQueueCommand({ QueueUrl: queueId }));
    } catch (err) {
      wrapProviderError('aws', 'deleteQueue', err);
    }
  }

  /** Lists all SQS queues. */
  async listQueues(): Promise<QueueInfo[]> {
    const queues: QueueInfo[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.client.send(new ListQueuesCommand({ NextToken: nextToken }));
        for (const url of out.QueueUrls ?? []) {
          queues.push({ id: url, url, name: url });
        }
        nextToken = out.NextToken;
      } while (nextToken);
    } catch (err) {
      wrapProviderError('aws', 'listQueues', err);
    }
    return queues;
  }

  /** Sends a message to an SQS queue and returns the message id. */
  async sendMessage(queueId: string, body: string, opts?: SendMessageOptions): Promise<string> {
    try {
      const out = await this.client.send(
        new SendMessageCommand({
          QueueUrl: queueId,
          MessageBody: body,
          ...(opts?.delaySeconds ? { DelaySeconds: opts.delaySeconds } : {}),
          ...(opts?.attributes && Object.keys(opts.attributes).length > 0
            ? {
                MessageAttributes: Object.fromEntries(
                  Object.entries(opts.attributes).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]),
                ),
              }
            : {}),
        }),
      );
      return out.MessageId ?? '';
    } catch (err) {
      wrapProviderError('aws', 'sendMessage', err);
    }
  }

  /** Receives up to maxMessages messages from an SQS queue. */
  async receiveMessages(queueId: string, maxMessages: number, opts?: ReceiveMessageOptions): Promise<QueueMessage[]> {
    try {
      const out = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueId,
          MaxNumberOfMessages: maxMessages,
          ...(opts?.visibilityTimeoutSeconds ? { VisibilityTimeout: opts.visibilityTimeoutSeconds } : {}),
          ...(opts?.waitTimeSeconds ? { WaitTimeSeconds: opts.waitTimeSeconds } : {}),
        }),
      );
      return (out.Messages ?? []).map((m) => ({
        id: m.MessageId ?? '',
        body: m.Body ?? '',
        receiptHandle: m.ReceiptHandle ?? '',
        attributes: Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']),
        ),
      }));
    } catch (err) {
      wrapProviderError('aws', 'receiveMessages', err);
    }
  }

  /** Deletes a message from an SQS queue using its receipt handle. */
  async deleteMessage(queueId: string, receiptHandle: string): Promise<void> {
    try {
      await this.client.send(new DeleteMessageCommand({ QueueUrl: queueId, ReceiptHandle: receiptHandle }));
    } catch (err) {
      wrapProviderError('aws', 'deleteMessage', err);
    }
  }

  /** Reads queue depth and timing attributes for an SQS queue. */
  async getQueueAttributes(queueId: string): Promise<QueueAttributes> {
    try {
      const out = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueId,
          AttributeNames: [
            QueueAttributeName.ApproximateNumberOfMessages,
            QueueAttributeName.VisibilityTimeout,
            QueueAttributeName.MessageRetentionPeriod,
          ],
        }),
      );
      const attrs = out.Attributes ?? {};
      return {
        approximateMessageCount: Number(attrs.ApproximateNumberOfMessages ?? 0),
        visibilityTimeoutSeconds: Number(attrs.VisibilityTimeout ?? 0),
        messageRetentionSeconds: Number(attrs.MessageRetentionPeriod ?? 0),
      };
    } catch (err) {
      wrapProviderError('aws', 'getQueueAttributes', err);
    }
  }
}
