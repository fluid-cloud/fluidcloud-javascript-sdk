export interface QueueInfo {
  id: string;
  name: string;
  url: string;
}

export interface QueueMessage {
  id: string;
  body: string;
  receiptHandle: string;
  attributes: Record<string, string>;
}

export interface QueueAttributes {
  approximateMessageCount: number;
  visibilityTimeoutSeconds: number;
  messageRetentionSeconds: number;
}

export interface QueueCreateOptions {
  visibilityTimeoutSeconds?: number;
  messageRetentionSeconds?: number;
}

export interface SendMessageOptions {
  delaySeconds?: number;
  attributes?: Record<string, string>;
}

export interface ReceiveMessageOptions {
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
}

/** Unified point-to-point queueing. */
export interface Queue {
  /** Creates a queue and returns its provider id. */
  createQueue(name: string, opts?: QueueCreateOptions): Promise<string>;

  /** Deletes a queue. */
  deleteQueue(queueId: string): Promise<void>;

  /** Lists queues. */
  listQueues(): Promise<QueueInfo[]>;

  /** Sends a message and returns the provider message id. */
  sendMessage(queueId: string, body: string, opts?: SendMessageOptions): Promise<string>;

  /** Receives up to maxMessages messages. */
  receiveMessages(queueId: string, maxMessages: number, opts?: ReceiveMessageOptions): Promise<QueueMessage[]>;

  /** Deletes a received message by its receipt handle. */
  deleteMessage(queueId: string, receiptHandle: string): Promise<void>;

  /** Reads queue depth and timing attributes. */
  getQueueAttributes(queueId: string): Promise<QueueAttributes>;
}
