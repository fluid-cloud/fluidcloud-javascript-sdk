import { createClient, isUnsupported } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  {
    acsEndpoint: process.env.AZURE_ACS_ENDPOINT,
    acsKey: process.env.AZURE_ACS_KEY,
    compartment: process.env.OCI_COMPARTMENT,
  },
);

if (!client.hasEmail) {
  console.log('email not configured for this entity');
  await client.close();
  process.exit(0);
}

const email = client.email;
const from = process.env.FROM_ADDRESS!;
const to = process.env.TO_ADDRESS!;

const messageId = await email.sendEmail({
  from,
  to: [to],
  subject: 'Hello from the FluidCloud JS SDK',
  body: 'This is a plain-text test message.',
  htmlBody: '<p>This is an <strong>HTML</strong> test message.</p>',
});
console.log('sent ->', messageId);

try {
  await email.verifyEmailIdentity(from);
  console.log('verification started for', from);
} catch (err) {
  if (isUnsupported(err)) console.log('verifyEmailIdentity not supported on', client.provider);
  else throw err;
}

try {
  console.log('identities ->', await email.listIdentities());
} catch (err) {
  if (isUnsupported(err)) console.log('listIdentities not supported on', client.provider);
  else throw err;
}

await client.close();
