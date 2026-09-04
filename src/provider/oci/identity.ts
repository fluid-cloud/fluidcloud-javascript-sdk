import { IdentityDomainsClient, models } from 'oci-identitydomains';

import type { OciCredentials } from '../../credentials/index.js';
import { NotFoundError, UnsupportedError, wrapProviderError } from '../../errors.js';
import type {
  AuthTokens,
  GroupInfo,
  Identity,
  User,
  UserPoolInfo,
  UserPoolOptions,
  UserSpec,
} from '../types/identity.js';
import { ociAuthProvider } from './auth.js';

const USER_SCHEMA_URN = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA_URN = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH_OP_SCHEMA_URN = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const PAGE_SIZE = 100;

function authFlowUnsupported(op: string): UnsupportedError {
  return new UnsupportedError(
    'oci',
    op,
    'OCI Identity Domains SCIM API does not support this auth flow',
    'Use the OCI Identity Domains hosted login or OAuth endpoints directly',
  );
}

function userToTypes(u: models.User): User {
  const attributes: Record<string, string> = {};
  if (u.id) attributes.id = u.id;
  if (u.ocid) attributes.ocid = u.ocid;
  if (u.displayName) attributes.displayName = u.displayName;
  let email = '';
  for (const e of u.emails ?? []) {
    if (e.value) {
      email = e.value;
      if (e.primary) break;
    }
  }
  return { username: u.userName ?? '', email, enabled: u.active === true, status: '', attributes };
}

/** OCI IAM Identity Domains identity directory via the SCIM API. The identity domain is a single directory, so poolId is a synthetic emulated pool. */
export class IamDomainsIdentity implements Identity {
  private readonly client: IdentityDomainsClient;
  private readonly domainEndpoint: string;

  constructor(creds: OciCredentials, identityDomainEndpoint: string) {
    this.client = new IdentityDomainsClient({ authenticationDetailsProvider: ociAuthProvider(creds) });
    if (identityDomainEndpoint) this.client.endpoint = identityDomainEndpoint;
    this.domainEndpoint = identityDomainEndpoint;
  }

  private poolName(): string {
    return this.domainEndpoint || 'default';
  }

  async createUserPool(_name: string, _opts?: UserPoolOptions): Promise<string> {
    return this.poolName();
  }

  async deleteUserPool(_poolId: string): Promise<void> {
    throw new UnsupportedError(
      'oci',
      'deleteUserPool',
      'OCI IAM Identity Domains exposes a single domain that cannot be deleted as a user pool',
      'Manage the identity domain lifecycle through the OCI Identity service',
    );
  }

  async listUserPools(): Promise<UserPoolInfo[]> {
    return [{ id: this.poolName(), name: this.poolName() }];
  }

  async getUserPool(_poolId: string): Promise<UserPoolInfo> {
    return { id: this.poolName(), name: this.poolName() };
  }

  private async findUserId(username: string): Promise<string> {
    try {
      const resp = await this.client.listUsers({ filter: `userName eq "${username}"` });
      const first = resp.users.resources[0];
      if (!first?.id) throw new NotFoundError(`oci: findUser: user ${username} not found`);
      return first.id;
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('oci', 'findUser', err);
    }
  }

  async createUser(_poolId: string, user: UserSpec): Promise<User> {
    try {
      const scimUser: models.User = {
        schemas: [USER_SCHEMA_URN],
        userName: user.username,
      };
      if (user.email) {
        scimUser.emails = [{ value: user.email, type: models.UserEmails.Type.Work, primary: true }];
      }
      const displayName = user.attributes?.displayName;
      if (displayName) scimUser.displayName = displayName;
      const familyName = user.attributes?.familyName || user.username;
      scimUser.name = { familyName };
      const givenName = user.attributes?.givenName;
      if (givenName) scimUser.name.givenName = givenName;

      const resp = await this.client.createUser({ user: scimUser });
      return userToTypes(resp.user);
    } catch (err) {
      return wrapProviderError('oci', 'createUser', err);
    }
  }

  async getUser(_poolId: string, username: string): Promise<User> {
    const id = await this.findUserId(username);
    try {
      const resp = await this.client.getUser({ userId: id });
      return userToTypes(resp.user);
    } catch (err) {
      return wrapProviderError('oci', 'getUser', err);
    }
  }

  async listUsers(_poolId: string): Promise<User[]> {
    const users: User[] = [];
    let startIndex = 1;
    try {
      for (;;) {
        const resp = await this.client.listUsers({ startIndex, count: PAGE_SIZE });
        for (const u of resp.users.resources) users.push(userToTypes(u));
        if (resp.users.resources.length < PAGE_SIZE) break;
        startIndex += resp.users.resources.length;
      }
      return users;
    } catch (err) {
      return wrapProviderError('oci', 'listUsers', err);
    }
  }

  async updateUser(_poolId: string, username: string, attributes: Record<string, string>): Promise<void> {
    if (Object.keys(attributes).length === 0) return;
    const id = await this.findUserId(username);
    try {
      const operations: models.Operations[] = Object.entries(attributes).map(([k, v]) => ({
        op: models.Operations.Op.Replace,
        path: k,
        value: v,
      }));
      await this.client.patchUser({ userId: id, patchOp: { schemas: [PATCH_OP_SCHEMA_URN], operations } });
    } catch (err) {
      wrapProviderError('oci', 'updateUser', err);
    }
  }

  async deleteUser(_poolId: string, username: string): Promise<void> {
    const id = await this.findUserId(username);
    try {
      await this.client.deleteUser({ userId: id });
    } catch (err) {
      wrapProviderError('oci', 'deleteUser', err);
    }
  }

  private async setActive(username: string, active: boolean): Promise<void> {
    const id = await this.findUserId(username);
    try {
      await this.client.patchUser({
        userId: id,
        patchOp: {
          schemas: [PATCH_OP_SCHEMA_URN],
          operations: [{ op: models.Operations.Op.Replace, path: 'active', value: active }],
        },
      });
    } catch (err) {
      wrapProviderError('oci', 'updateUser', err);
    }
  }

  async enableUser(_poolId: string, username: string): Promise<void> {
    await this.setActive(username, true);
  }

  async disableUser(_poolId: string, username: string): Promise<void> {
    await this.setActive(username, false);
  }

  async setPassword(_poolId: string, _username: string, _password: string, _permanent: boolean): Promise<void> {
    throw authFlowUnsupported('setPassword');
  }

  private async findGroupId(group: string): Promise<string> {
    try {
      const resp = await this.client.listGroups({ filter: `displayName eq "${group}"` });
      const first = resp.groups.resources[0];
      if (!first?.id) throw new NotFoundError(`oci: findGroup: group ${group} not found`);
      return first.id;
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('oci', 'findGroup', err);
    }
  }

  async createGroup(_poolId: string, group: string): Promise<void> {
    try {
      await this.client.createGroup({ group: { schemas: [GROUP_SCHEMA_URN], displayName: group } });
    } catch (err) {
      wrapProviderError('oci', 'createGroup', err);
    }
  }

  async deleteGroup(_poolId: string, group: string): Promise<void> {
    const id = await this.findGroupId(group);
    try {
      await this.client.deleteGroup({ groupId: id });
    } catch (err) {
      wrapProviderError('oci', 'deleteGroup', err);
    }
  }

  async listGroups(_poolId: string): Promise<GroupInfo[]> {
    const groups: GroupInfo[] = [];
    let startIndex = 1;
    try {
      for (;;) {
        const resp = await this.client.listGroups({ startIndex, count: PAGE_SIZE });
        for (const g of resp.groups.resources) groups.push({ name: g.displayName ?? '', description: '' });
        if (resp.groups.resources.length < PAGE_SIZE) break;
        startIndex += resp.groups.resources.length;
      }
      return groups;
    } catch (err) {
      return wrapProviderError('oci', 'listGroups', err);
    }
  }

  private async patchGroupMember(username: string, group: string, add: boolean): Promise<void> {
    const groupId = await this.findGroupId(group);
    const userId = await this.findUserId(username);
    try {
      const operation: models.Operations = add
        ? { op: models.Operations.Op.Add, path: 'members', value: [{ value: userId, type: 'User' }] }
        : { op: models.Operations.Op.Remove, path: `members[value eq "${userId}"]` };
      await this.client.patchGroup({
        groupId,
        patchOp: { schemas: [PATCH_OP_SCHEMA_URN], operations: [operation] },
      });
    } catch (err) {
      wrapProviderError('oci', 'patchGroup', err);
    }
  }

  async addUserToGroup(_poolId: string, username: string, group: string): Promise<void> {
    await this.patchGroupMember(username, group, true);
  }

  async removeUserFromGroup(_poolId: string, username: string, group: string): Promise<void> {
    await this.patchGroupMember(username, group, false);
  }

  async listUsersInGroup(_poolId: string, group: string): Promise<User[]> {
    const groupId = await this.findGroupId(group);
    try {
      const resp = await this.client.getGroup({ groupId });
      const users: User[] = [];
      for (const m of resp.group.members ?? []) {
        const attributes: Record<string, string> = {};
        if (m.value) attributes.id = m.value;
        users.push({ username: m.name ?? '', email: '', enabled: false, status: '', attributes });
      }
      return users;
    } catch (err) {
      return wrapProviderError('oci', 'getGroup', err);
    }
  }

  async signUp(
    _poolId: string,
    _clientId: string,
    _username: string,
    _password: string,
    _attributes?: Record<string, string>,
  ): Promise<void> {
    throw authFlowUnsupported('signUp');
  }

  async confirmSignUp(_poolId: string, _clientId: string, _username: string, _code: string): Promise<void> {
    throw authFlowUnsupported('confirmSignUp');
  }

  async authenticate(_poolId: string, _clientId: string, _username: string, _password: string): Promise<AuthTokens> {
    throw authFlowUnsupported('authenticate');
  }

  async refreshToken(_poolId: string, _clientId: string, _refreshToken: string): Promise<AuthTokens> {
    throw authFlowUnsupported('refreshToken');
  }
}
