import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  {
    searchEndpoint: process.env.SEARCH_ENDPOINT!,
    searchUsername: process.env.SEARCH_USERNAME,
    searchPassword: process.env.SEARCH_PASSWORD,
    searchApiKey: process.env.SEARCH_API_KEY,
    region: process.env.AWS_REGION,
  },
);

const search = client.search;
const index = 'fluidcloud-example';

await search.createIndex(index, {
  mappings: { properties: { title: { type: 'text' }, views: { type: 'integer' } } },
});

await search.indexDocument(index, '1', { title: 'Hello FluidCloud', views: 10 });
await search.bulkIndex(index, [
  { id: '2', doc: { title: 'Second document', views: 3 } },
  { id: '3', doc: { title: 'Third document', views: 42 } },
]);
await search.refresh(index).catch(() => undefined);

const results = await search.search(index, { query: { match: { title: 'FluidCloud' } } });
console.log('total hits:', results.total);
for (const hit of results.hits) console.log(hit.id, hit.score, hit.source);

const count = await search.count(index, {});
console.log('document count:', count);

await search.deleteDocument(index, '1');
await search.deleteIndex(index);

await client.close();
