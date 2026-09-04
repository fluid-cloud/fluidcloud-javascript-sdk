import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  { serviceBusNamespace: process.env.AZURE_SERVICE_BUS_NAMESPACE },
);

const queue = client.queue;

const queueId = await queue.createQueue('fluidcloud-example-queue', {
  visibilityTimeoutSeconds: 30,
  messageRetentionSeconds: 3600,
});
console.log('created queue:', queueId);

const messageId = await queue.sendMessage(queueId, 'hello from the FluidCloud JS SDK', {
  attributes: { source: 'examples/queue.ts' },
});
console.log('sent message:', messageId);

const messages = await queue.receiveMessages(queueId, 5, { waitTimeSeconds: 2 });
console.log('received messages:', messages);

for (const message of messages) {
  await queue.deleteMessage(queueId, message.receiptHandle);
  console.log('deleted message:', message.id);
}

const attrs = await queue.getQueueAttributes(queueId);
console.log('queue attributes:', attrs);

const queues = await queue.listQueues();
console.log('all queues:', queues.map((q) => q.name));

await queue.deleteQueue(queueId);
console.log('deleted queue:', queueId);

await client.close();
