import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  {
    serviceBusNamespace: process.env.AZURE_SERVICE_BUS_NAMESPACE,
    compartment: process.env.OCI_COMPARTMENT_OCID,
  },
);

const topicId = await client.messaging.createTopic('fluidcloud-example', {
  displayName: 'FluidCloud Example Topic',
});
console.log('created topic:', topicId);

const messageId = await client.messaging.publish(topicId, 'hello from the FluidCloud JS SDK', {
  subject: 'greeting',
  attributes: { source: 'examples/messaging.ts' },
});
console.log('published message:', messageId);

const subscriptionId = await client.messaging.subscribe(
  topicId,
  'https',
  process.env.MESSAGING_WEBHOOK_URL ?? 'https://example.com/webhook',
);
console.log('created subscription:', subscriptionId);

const subscriptions = await client.messaging.listSubscriptions(topicId);
console.log('subscriptions on topic:', subscriptions);

const topics = await client.messaging.listTopics();
console.log('topics in account:', topics.length);

await client.messaging.unsubscribe(subscriptionId);
await client.messaging.deleteTopic(topicId);

await client.close();
