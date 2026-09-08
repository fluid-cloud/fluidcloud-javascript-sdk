import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  {
    keyVaultName: process.env.AZURE_KEY_VAULT_NAME,
    vaultOcid: process.env.OCI_VAULT_OCID,
    compartment: process.env.OCI_COMPARTMENT,
    keyOcid: process.env.OCI_KEY_OCID,
  },
);

const secrets = client.secrets;

console.log('provider:', secrets.provider());

await secrets.put('example/db-password', 's3cr3t', {
  description: 'Example database password',
  tags: { env: 'demo' },
});
console.log('put example/db-password');

const value = await secrets.get('example/db-password');
console.log('get example/db-password:', value);

const withMetadata = await secrets.getWithMetadata('example/db-password');
console.log('getWithMetadata:', withMetadata.name, withMetadata.version);

const exists = await secrets.exists('example/db-password');
console.log('exists:', exists);

const all = await secrets.list();
console.log(
  'list:',
  all.map((s) => s.name),
);

const versions = await secrets.listVersions('example/db-password');
console.log(
  'listVersions:',
  versions.map((v) => `${v.version}:${v.status}`),
);

await secrets.putBinary('example/api-key.bin', Buffer.from([1, 2, 3, 4]));
const binary = await secrets.getBinary('example/api-key.bin');
console.log('getBinary length:', binary.length);

if (secrets.supports('rotate')) {
  await secrets.rotateSecret('example/db-password');
  console.log('rotated example/db-password');
} else {
  console.log('rotate not supported on', secrets.provider());
}

await secrets.delete('example/db-password');
await secrets.delete('example/api-key.bin');
console.log('deleted example secrets');

await client.close();
