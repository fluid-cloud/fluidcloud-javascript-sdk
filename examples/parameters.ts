import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  {
    appConfigEndpoint: process.env.APP_CONFIG_ENDPOINT,
    vaultOcid: process.env.VAULT_OCID,
    compartment: process.env.COMPARTMENT,
    keyOcid: process.env.KEY_OCID,
  },
);

const parameters = client.parameters;

await parameters.put('/app/db-host', 'db.internal.example.com', {
  description: 'Primary database host',
  tags: { env: 'prod' },
});
console.log('put ok, provider:', parameters.provider());

const value = await parameters.get('/app/db-host');
console.log('get:', value);

const withMeta = await parameters.getWithMetadata('/app/db-host');
console.log('metadata: version=%s updatedAt=%s', withMeta.version, withMeta.updatedAt.toISOString());

const exists = await parameters.exists('/app/db-host');
console.log('exists:', exists);

const all = await parameters.list();
console.log('list count:', all.length);

const versions = await parameters.listVersions('/app/db-host');
console.log('versions:', versions.map((v) => `${v.version}(${v.status})`).join(', '));

if (versions.length > 0) {
  const first = await parameters.getVersion('/app/db-host', versions[0]!.version);
  console.log('version', versions[0]!.version, '=', first);
}

console.log('supports put:', parameters.supports('put'));

await parameters.delete('/app/db-host');
console.log('deleted');

await client.close();
