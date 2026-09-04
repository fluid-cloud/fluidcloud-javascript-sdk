import { createClient } from '../src/index.js';

const client = await createClient(
  {
    serverUrl: process.env.SERVER_URL ?? 'https://app.fluidcloud.com',
    apiKey: process.env.API_KEY!,
    entityId: process.env.ENTITY_ID!,
  },
  { identityDomainEndpoint: process.env.IDENTITY_DOMAIN_ENDPOINT },
);

const identity = client.identity;

const pools = await identity.listUserPools();
console.log('user pools:', pools);

const poolId = pools[0]?.id ?? (await identity.createUserPool('fluidcloud-demo', { autoVerifiedEmail: true }));
console.log('using pool:', poolId);

const user = await identity.createUser(poolId, {
  username: 'demo-user',
  email: 'demo-user@example.com',
  password: 'Temp-Pass-123!',
  attributes: { role: 'member' },
});
console.log('created user:', user);

await identity.createGroup(poolId, 'demo-group').catch((err) => console.log('createGroup:', err.message));
await identity.addUserToGroup(poolId, user.username, 'demo-group').catch((err) => console.log('addUserToGroup:', err.message));

const membersOfGroup = await identity.listUsersInGroup(poolId, 'demo-group').catch(() => []);
console.log('group members:', membersOfGroup);

await identity.setPassword(poolId, user.username, 'Perm-Pass-456!', true);

const tokens = await identity.authenticate(poolId, process.env.APP_CLIENT_ID ?? '', user.username, 'Perm-Pass-456!').catch((err) => {
  console.log('authenticate:', err.message);
  return undefined;
});
if (tokens) console.log('access token expires in:', tokens.expiresIn);

await identity.deleteUser(poolId, user.username);

await client.close();
