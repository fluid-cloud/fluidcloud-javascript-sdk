import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotFoundError, UnsupportedError } from '../src/errors.js';

const awsSend = vi.fn();
vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cognito-identity-provider')>(
    '@aws-sdk/client-cognito-identity-provider',
  );
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(function CognitoIdentityProviderClient() {
      return { send: awsSend };
    }),
  };
});

const graphApi = vi.fn();
vi.mock('@microsoft/microsoft-graph-client', () => ({
  Client: { init: vi.fn(() => ({ api: graphApi })) },
}));

const gcpAuth = {
  getUserByEmail: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  listUsers: vi.fn(),
  setCustomUserClaims: vi.fn(),
};
vi.mock('firebase-admin/app', () => ({
  cert: vi.fn((sa: unknown) => sa),
  initializeApp: vi.fn(() => ({})),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => gcpAuth),
}));

const ociClient = {
  createUser: vi.fn(),
  getUser: vi.fn(),
  listUsers: vi.fn(),
  patchUser: vi.fn(),
  deleteUser: vi.fn(),
  createGroup: vi.fn(),
  deleteGroup: vi.fn(),
  listGroups: vi.fn(),
  patchGroup: vi.fn(),
  getGroup: vi.fn(),
  endpoint: '',
};
vi.mock('oci-identitydomains', async () => {
  const actual = await vi.importActual<typeof import('oci-identitydomains')>('oci-identitydomains');
  return {
    ...actual,
    IdentityDomainsClient: vi.fn().mockImplementation(function IdentityDomainsClient() {
      return ociClient;
    }),
  };
});

const { CognitoIdentity } = await import('../src/provider/aws/identity.js');
const { EntraIdentity } = await import('../src/provider/azure/identity.js');
const { CloudIdentity } = await import('../src/provider/gcp/identity.js');
const { IamDomainsIdentity } = await import('../src/provider/oci/identity.js');

const awsCreds = { accessKey: 'ak', secretAccessKey: 'sk', region: 'us-east-1' };
const azureCreds = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret', subscriptionId: 'sub-1' };
const gcpCreds = { projectId: 'proj-1', serviceAccountJson: JSON.stringify({ project_id: 'proj-1', client_email: 'a@b.iam', private_key: 'k' }) };
const ociCreds = { tenancyOcid: 't', userOcid: 'u', fingerprint: 'f', privateKey: 'k', region: 'us-ashburn-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CognitoIdentity (aws)', () => {
  it('createUserPool sends CreateUserPoolCommand and returns the id', async () => {
    awsSend.mockResolvedValueOnce({ UserPool: { Id: 'pool-1', Name: 'x' } });
    const identity = new CognitoIdentity(awsCreds);
    const id = await identity.createUserPool('x', { autoVerifiedEmail: true });
    expect(id).toBe('pool-1');
    const input = awsSend.mock.calls[0][0].input;
    expect(input.PoolName).toBe('x');
    expect(input.AutoVerifiedAttributes).toEqual(['email']);
  });

  it('createUserPool throws NotFoundError when the pool id is missing', async () => {
    awsSend.mockResolvedValueOnce({ UserPool: {} });
    const identity = new CognitoIdentity(awsCreds);
    await expect(identity.createUserPool('x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getUserPool throws NotFoundError when DescribeUserPool returns no pool', async () => {
    awsSend.mockResolvedValueOnce({});
    const identity = new CognitoIdentity(awsCreds);
    await expect(identity.getUserPool('pool-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('setPassword forwards the permanent flag', async () => {
    awsSend.mockResolvedValueOnce({});
    const identity = new CognitoIdentity(awsCreds);
    await identity.setPassword('pool-1', 'bob', 'pw', true);
    const input = awsSend.mock.calls[0][0].input;
    expect(input).toMatchObject({ UserPoolId: 'pool-1', Username: 'bob', Password: 'pw', Permanent: true });
  });

  it('authenticate uses USER_PASSWORD_AUTH', async () => {
    awsSend.mockResolvedValueOnce({
      AuthenticationResult: { AccessToken: 'a', IdToken: 'i', RefreshToken: 'r', ExpiresIn: 3600, TokenType: 'Bearer' },
    });
    const identity = new CognitoIdentity(awsCreds);
    const tokens = await identity.authenticate('pool-1', 'client-1', 'bob', 'pw');
    const input = awsSend.mock.calls[0][0].input;
    expect(input.AuthFlow).toBe('USER_PASSWORD_AUTH');
    expect(input.AuthParameters).toEqual({ USERNAME: 'bob', PASSWORD: 'pw' });
    expect(tokens).toEqual({ accessToken: 'a', idToken: 'i', refreshToken: 'r', expiresIn: 3600, tokenType: 'Bearer' });
  });

  it('refreshToken preserves the input refresh token when Cognito omits it', async () => {
    awsSend.mockResolvedValueOnce({ AuthenticationResult: { AccessToken: 'a2', ExpiresIn: 100, TokenType: 'Bearer' } });
    const identity = new CognitoIdentity(awsCreds);
    const tokens = await identity.refreshToken('pool-1', 'client-1', 'refresh-in');
    const input = awsSend.mock.calls[0][0].input;
    expect(input.AuthFlow).toBe('REFRESH_TOKEN_AUTH');
    expect(tokens.refreshToken).toBe('refresh-in');
  });

  it('getUser maps Cognito attributes into User.attributes and email', async () => {
    awsSend.mockResolvedValueOnce({
      Username: 'bob',
      Enabled: true,
      UserStatus: 'CONFIRMED',
      UserAttributes: [{ Name: 'email', Value: 'bob@example.com' }, { Name: 'custom:role', Value: 'admin' }],
    });
    const identity = new CognitoIdentity(awsCreds);
    const user = await identity.getUser('pool-1', 'bob');
    expect(user).toEqual({
      username: 'bob',
      email: 'bob@example.com',
      enabled: true,
      status: 'CONFIRMED',
      attributes: { email: 'bob@example.com', 'custom:role': 'admin' },
    });
  });
});

function graphRequest(overrides: Partial<Record<'get' | 'post' | 'patch' | 'delete', unknown>>) {
  const req: Record<string, unknown> = {
    get: vi.fn().mockResolvedValue(undefined),
    post: vi.fn().mockResolvedValue(undefined),
    patch: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  req.filter = vi.fn().mockReturnValue(req);
  Object.assign(req, overrides);
  return req;
}

describe('EntraIdentity (azure)', () => {
  it('createUserPool returns the synthetic tenant pool and ignores the name', async () => {
    const identity = new EntraIdentity(azureCreds);
    const id = await identity.createUserPool('unused');
    expect(id).toBe('tenant-1');
  });

  it('deleteUserPool throws UnsupportedError', async () => {
    const identity = new EntraIdentity(azureCreds);
    await expect(identity.deleteUserPool('tenant-1')).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('getUser maps a Graph user into a provider-agnostic User', async () => {
    graphApi.mockReturnValueOnce(
      graphRequest({ get: vi.fn().mockResolvedValue({ id: 'obj-1', userPrincipalName: 'bob@x.com', mail: 'bob@x.com', accountEnabled: true }) }),
    );
    const identity = new EntraIdentity(azureCreds);
    const user = await identity.getUser('tenant-1', 'bob@x.com');
    expect(graphApi).toHaveBeenCalledWith('/users/bob%40x.com');
    expect(user.username).toBe('bob@x.com');
    expect(user.email).toBe('bob@x.com');
    expect(user.enabled).toBe(true);
  });

  it('addUserToGroup throws NotFoundError when the group filter finds nothing', async () => {
    graphApi.mockReturnValueOnce(graphRequest({ get: vi.fn().mockResolvedValue({ value: [] }) }));
    const identity = new EntraIdentity(azureCreds);
    await expect(identity.addUserToGroup('tenant-1', 'bob', 'missing-group')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('CloudIdentity (gcp)', () => {
  it('createUser creates via Firebase Admin and applies custom claims', async () => {
    gcpAuth.createUser.mockResolvedValueOnce({ uid: 'uid-1', email: 'bob@x.com', disabled: false, customClaims: undefined });
    const identity = new CloudIdentity(gcpCreds);
    const user = await identity.createUser('proj-1', { username: 'bob@x.com', password: 'pw', attributes: { role: 'admin' } });
    expect(gcpAuth.createUser).toHaveBeenCalledWith({ email: 'bob@x.com', password: 'pw' });
    expect(gcpAuth.setCustomUserClaims).toHaveBeenCalledWith('uid-1', { role: 'admin' });
    expect(user.attributes).toEqual({ role: 'admin' });
    expect(user.username).toBe('bob@x.com');
  });

  const unsupportedCases: Array<[string, (i: InstanceType<typeof CloudIdentity>) => Promise<unknown>]> = [
    ['createUserPool', (i) => i.createUserPool('x')],
    ['deleteUserPool', (i) => i.deleteUserPool('x')],
    ['createGroup', (i) => i.createGroup('p', 'g')],
    ['listGroups', (i) => i.listGroups('p')],
    ['signUp', (i) => i.signUp('p', 'c', 'u', 'pw')],
    ['authenticate', (i) => i.authenticate('p', 'c', 'u', 'pw')],
    ['refreshToken', (i) => i.refreshToken('p', 'c', 'r')],
  ];

  it.each(unsupportedCases)('%s throws UnsupportedError', async (_name, call) => {
    await expect(call(new CloudIdentity(gcpCreds))).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('IamDomainsIdentity (oci)', () => {
  it('createUser builds a SCIM user with a familyName default and returns the mapped User', async () => {
    ociClient.createUser.mockResolvedValueOnce({
      user: { userName: 'bob', active: true, id: 'id-1', emails: [{ value: 'bob@x.com', primary: true }] },
    });
    const identity = new IamDomainsIdentity(ociCreds, 'https://domain.example.com');
    const user = await identity.createUser('pool', { username: 'bob', email: 'bob@x.com' });
    const req = ociClient.createUser.mock.calls[0][0];
    expect(req.user.userName).toBe('bob');
    expect(req.user.name.familyName).toBe('bob');
    expect(user).toEqual({ username: 'bob', email: 'bob@x.com', enabled: true, status: '', attributes: { id: 'id-1' } });
  });

  it('updateUser throws NotFoundError when the SCIM filter finds no user', async () => {
    ociClient.listUsers.mockResolvedValueOnce({ users: { resources: [] } });
    const identity = new IamDomainsIdentity(ociCreds, 'https://domain.example.com');
    await expect(identity.updateUser('pool', 'ghost', { role: 'admin' })).rejects.toBeInstanceOf(NotFoundError);
    expect(ociClient.listUsers).toHaveBeenCalledWith({ filter: 'userName eq "ghost"' });
  });

  it('deleteUserPool and setPassword throw UnsupportedError', async () => {
    const identity = new IamDomainsIdentity(ociCreds, 'https://domain.example.com');
    await expect(identity.deleteUserPool('pool')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(identity.setPassword('pool', 'bob', 'pw', true)).rejects.toBeInstanceOf(UnsupportedError);
    await expect(identity.authenticate('pool', 'c', 'bob', 'pw')).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('listUsersInGroup maps SCIM group members', async () => {
    ociClient.listGroups.mockResolvedValueOnce({ groups: { resources: [{ id: 'g-1', displayName: 'admins' }] } });
    ociClient.getGroup.mockResolvedValueOnce({ group: { members: [{ value: 'u-1', name: 'bob' }] } });
    const identity = new IamDomainsIdentity(ociCreds, 'https://domain.example.com');
    const users = await identity.listUsersInGroup('pool', 'admins');
    expect(users).toEqual([{ username: 'bob', email: '', enabled: false, status: '', attributes: { id: 'u-1' } }]);
  });
});
