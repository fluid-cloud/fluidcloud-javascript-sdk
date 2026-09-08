import { type Client, createClient, isUnsupported } from '../src/index.js';

// One code path, four clouds: the same calls run against whichever provider the
// entity happens to be, and capability gaps surface as UnsupportedError.

const entityIds = (process.env.ENTITY_IDS ?? '').split(',').filter(Boolean);
const bucket = process.env.TEST_BUCKET!;

for (const entityId of entityIds) {
  const client = await createClient(
    { serverUrl: process.env.SERVER_URL, apiKey: process.env.API_KEY!, entityId },
    {
      storageAccount: process.env.AZURE_STORAGE_ACCOUNT,
      storageAccountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY,
      keyVaultName: process.env.AZURE_KEYVAULT_NAME,
      namespace: process.env.OCI_NAMESPACE,
      compartment: process.env.OCI_COMPARTMENT,
      vaultOcid: process.env.OCI_VAULT_OCID,
      keyOcid: process.env.OCI_KEY_OCID,
    },
  );

  console.log(`\n=== ${entityId} (${client.provider}) ===`);
  await exercise(client, bucket);
  await client.close();
}

async function exercise(client: Client, bucket: string): Promise<void> {
  if (!client.hasStorage) {
    console.log('storage not configured for this entity');
    return;
  }

  const storage = client.storage;
  const key = 'fluidcloud/portable.txt';

  await storage.put(bucket, key, `written by ${client.provider}`);
  console.log('get ->', (await storage.get(bucket, key)).toString());
  console.log('supports multipart ->', storage.supports('multipart'));
  console.log('supports tags ->', storage.supports('set_tags'));

  // Tagging is native on AWS and Azure, emulated on OCI, and absent on GCS.
  try {
    await storage.setTags(bucket, key, { owner: 'platform' });
    console.log('tags ->', await storage.getTags(bucket, key));
  } catch (err) {
    if (!isUnsupported(err)) throw err;
    console.log('tags -> unsupported on', client.provider);
  }

  await storage.delete(bucket, key);
}
