import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  { compartment: process.env.OCI_COMPARTMENT_OCID },
);

const audit = client.audit;

const events = await audit.lookupEvents({
  startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
  endTime: new Date(),
  maxResults: 20,
});
console.log('recent events:', events.map((e) => ({ id: e.id, name: e.name, time: e.time })));

try {
  await audit.createTrail('example-trail', { s3BucketName: process.env.S3_BUCKET_NAME!, isMultiRegion: true });
  console.log('trail created');

  const trails = await audit.listTrails();
  console.log('trails:', trails);

  const status = await audit.getTrailStatus('example-trail');
  console.log('trail status:', status);

  await audit.deleteTrail('example-trail');
  console.log('trail deleted');
} catch (err) {
  console.log('trail lifecycle unsupported on this provider:', (err as Error).message);
}

await client.close();
