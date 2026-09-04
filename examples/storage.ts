import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  { storageAccount: process.env.AZURE_STORAGE_ACCOUNT },
);

const bucket = process.env.BUCKET_NAME!;
const key = 'fluidcloud-sdk-example/hello.txt';

await client.storage.put(bucket, key, 'hello from the fluidcloud js sdk', { contentType: 'text/plain' });
console.log('uploaded', key);

const data = await client.storage.get(bucket, key);
console.log('downloaded', data.toString());

const head = await client.storage.head(bucket, key);
console.log('head', head);

await client.storage.setTags(bucket, key, { env: 'example' });
if (client.storage.supports('get_tags')) {
  console.log('tags', await client.storage.getTags(bucket, key));
}

const objects = await client.storage.list(bucket, { prefix: 'fluidcloud-sdk-example/' });
console.log('listed', objects.length, 'objects');

const url = await client.storage.presignGet(bucket, key, 300, { filename: 'hello.txt' });
console.log('presigned url', url);

await client.storage.delete(bucket, key);
console.log('deleted', key);

await client.close();
