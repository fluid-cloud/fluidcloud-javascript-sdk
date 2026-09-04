import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  { cdnProfileName: process.env.CDN_PROFILE_NAME },
);

const distribution = await client.cdn.createDistribution({
  originDomain: process.env.ORIGIN_DOMAIN ?? 'origin.example.com',
  comment: 'created by the fluidcloud-javascript-sdk example',
  enabled: true,
});
console.log('created distribution:', distribution);

const fetched = await client.cdn.getDistribution(distribution.id);
console.log('fetched distribution:', fetched);

const distributions = await client.cdn.listDistributions();
console.log('total distributions:', distributions.length);

const updated = await client.cdn.updateDistribution(distribution.id, {
  originDomain: distribution.originDomain,
  comment: 'updated by the fluidcloud-javascript-sdk example',
  enabled: distribution.enabled,
});
console.log('updated distribution:', updated);

const invalidationId = await client.cdn.createInvalidation(distribution.id, ['/*']);
console.log('created invalidation:', invalidationId);

try {
  const invalidation = await client.cdn.getInvalidation(distribution.id, invalidationId);
  console.log('invalidation status:', invalidation.status);
} catch (err) {
  console.log('invalidation status is not queryable on this provider:', (err as Error).message);
}

await client.cdn.disableDistribution(distribution.id);
console.log('disabled distribution', distribution.id);

await client.close();
