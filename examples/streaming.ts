import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  {
    resourceGroup: process.env.AZURE_RESOURCE_GROUP,
    eventHubsNamespace: process.env.AZURE_EVENT_HUBS_NAMESPACE,
    mskBootstrapServers: process.env.AWS_MSK_BOOTSTRAP_SERVERS,
  },
);

const streaming = client.streaming;

const streamId = await streaming.createStream('fluidcloud-example-stream', { partitions: 1 });
console.log('created stream:', streamId);

await streaming.createConsumerGroup(streamId, 'example-group');
console.log('created consumer group: example-group');

await streaming.putRecords(streamId, [
  { key: Buffer.from('k1'), value: Buffer.from('hello from the FluidCloud JS SDK') },
]);
console.log('produced 1 record');

const records = await streaming.getRecords(streamId, { partition: 0, limit: 5, consumerGroup: 'example-group' });
console.log('consumed records:', records.map((r) => r.value.toString()));

if (records.length > 0) {
  const last = records[records.length - 1]!;
  await streaming.commitOffset(streamId, 'example-group', last.partition ?? 0, last.offset ?? 0);
  console.log('committed offset');
}

const info = await streaming.getStream(streamId);
console.log('stream info:', info);

const streams = await streaming.listStreams();
console.log('all streams:', streams.map((s) => s.name));

await streaming.deleteConsumerGroup(streamId, 'example-group');
await streaming.deleteStream(streamId);
console.log('deleted stream:', streamId);

await client.close();
