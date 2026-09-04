import { createClient, isNotFound } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL,
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  {
    storageAccount: process.env.AZURE_STORAGE_ACCOUNT,
    storageAccountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY,
    keyVaultName: process.env.AZURE_KEYVAULT_NAME,
    appConfigEndpoint: process.env.AZURE_APPCONFIG_ENDPOINT,
    namespace: process.env.OCI_NAMESPACE,
    compartment: process.env.OCI_COMPARTMENT,
    vaultOcid: process.env.OCI_VAULT_OCID,
    keyOcid: process.env.OCI_KEY_OCID,
  },
);

console.log('provider:', client.provider);
console.log('capabilities:', client.capabilities);

const bucket = process.env.TEST_BUCKET!;

if (client.hasStorage && bucket) {
  const storage = client.storage;
  await storage.put(bucket, 'fluidcloud/hello.txt', 'hello from the FluidCloud JS SDK', {
    contentType: 'text/plain',
  });
  console.log('put ->', (await storage.get(bucket, 'fluidcloud/hello.txt')).toString());

  const head = await storage.head(bucket, 'fluidcloud/hello.txt');
  console.log('head ->', head.size, 'bytes,', head.contentType);

  for (const object of await storage.list(bucket, { prefix: 'fluidcloud/', maxKeys: 10 })) {
    console.log('  ', object.key, object.size);
  }

  console.log('presigned ->', await storage.presignGet(bucket, 'fluidcloud/hello.txt', 900));
  await storage.delete(bucket, 'fluidcloud/hello.txt');
}

if (client.hasSecrets) {
  const secrets = client.secrets;
  await secrets.put('fluidcloud-js-demo', 's3cr3t', { description: 'written by the JS SDK example' });
  console.log('secret ->', await secrets.get('fluidcloud-js-demo'));

  try {
    await secrets.get('definitely-not-here');
  } catch (err) {
    console.log('missing secret is a not-found:', isNotFound(err));
  }

  await secrets.delete('fluidcloud-js-demo');
}

if (client.hasParameters) {
  const parameters = client.parameters;
  await parameters.put('/fluidcloud/js-demo', 'v1', { secure: false });
  console.log('parameter ->', await parameters.get('/fluidcloud/js-demo'));
  await parameters.delete('/fluidcloud/js-demo');
}

await client.close();
