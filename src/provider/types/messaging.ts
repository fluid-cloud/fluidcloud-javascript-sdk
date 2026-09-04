export interface TopicInfo {
  id: string;
  name: string;
  arn: string;
}

export interface SubscriptionInfo {
  id: string;
  topicId: string;
  protocol: string;
  endpoint: string;
}

export interface PublishOptions {
  subject?: string;
  attributes?: Record<string, string>;
}

export interface MessagingCreateTopicOptions {
  displayName?: string;
  attributes?: Record<string, string>;
}

/** Unified pub/sub topic messaging. */
export interface Messaging {
  /** Creates a topic and returns its provider id. */
  createTopic(name: string, opts?: MessagingCreateTopicOptions): Promise<string>;

  /** Deletes a topic. */
  deleteTopic(topicId: string): Promise<void>;

  /** Lists topics. */
  listTopics(): Promise<TopicInfo[]>;

  /** Publishes a message and returns the provider message id. */
  publish(topicId: string, message: string, opts?: PublishOptions): Promise<string>;

  /** Subscribes an endpoint to a topic and returns the subscription id. */
  subscribe(topicId: string, protocol: string, endpoint: string): Promise<string>;

  /** Removes a subscription. */
  unsubscribe(subscriptionId: string): Promise<void>;

  /** Lists subscriptions on a topic. */
  listSubscriptions(topicId: string): Promise<SubscriptionInfo[]>;
}
