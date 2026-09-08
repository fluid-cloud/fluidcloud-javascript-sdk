import { Client } from '@microsoft/microsoft-graph-client';

import type { AzureCredentials } from '../../credentials/index.js';
import { messageOf, NotFoundError, UnsupportedError, wrapProviderError } from '../../errors.js';
import type {
  AuthTokens,
  GroupInfo,
  Identity,
  User,
  UserPoolInfo,
  UserPoolOptions,
  UserSpec,
} from '../types/identity.js';
import { azureCredential } from './auth.js';

interface GraphUser {
  id?: string;
  displayName?: string;
  userPrincipalName?: string;
  mailNickname?: string;
  mail?: string;
  accountEnabled?: boolean;
}

interface GraphGroup {
  id?: string;
  displayName?: string;
  description?: string;
}

interface GraphListResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

function toUser(g: GraphUser): User {
  const attributes: Record<string, string> = {};
  if (g.id) attributes.id = g.id;
  if (g.displayName) attributes.displayName = g.displayName;
  if (g.userPrincipalName) attributes.userPrincipalName = g.userPrincipalName;
  return {
    username: g.userPrincipalName ?? '',
    email: g.mail || g.userPrincipalName || '',
    enabled: g.accountEnabled ?? true,
    status: '',
    attributes,
  };
}

/** Azure Entra ID identity directory via Microsoft Graph. The directory is a single tenant, so poolId is a synthetic emulated pool. */
export class EntraIdentity implements Identity {
  private readonly client: Client;
  private readonly tenantId: string;

  constructor(creds: AzureCredentials) {
    const credential = azureCredential(creds);
    this.tenantId = creds.tenantId;
    this.client = Client.init({
      authProvider: async (done) => {
        try {
          const token = await credential.getToken('https://graph.microsoft.com/.default');
          if (!token) throw new Error('failed to acquire Graph token');
          done(null, token.token);
        } catch (err) {
          done(err instanceof Error ? err : new Error(messageOf(err)), null);
        }
      },
    });
  }

  private poolName(): string {
    return this.tenantId || 'default';
  }

  async createUserPool(_name: string, _opts?: UserPoolOptions): Promise<string> {
    return this.poolName();
  }

  async deleteUserPool(_poolId: string): Promise<void> {
    throw new UnsupportedError(
      'azure',
      'deleteUserPool',
      'Entra ID exposes a single directory that cannot be deleted as a user pool',
      'Manage the Entra tenant lifecycle through Azure subscription management',
    );
  }

  async listUserPools(): Promise<UserPoolInfo[]> {
    return [{ id: this.poolName(), name: this.poolName() }];
  }

  async getUserPool(_poolId: string): Promise<UserPoolInfo> {
    return { id: this.poolName(), name: this.poolName() };
  }

  async createUser(_poolId: string, user: UserSpec): Promise<User> {
    try {
      const at = user.username.indexOf('@');
      const nickname = at >= 0 ? user.username.slice(0, at) : user.username;
      const displayName = user.attributes?.displayName || user.username;
      const password = user.password || `ChangeMe!${nickname}123`;
      const payload = {
        displayName,
        userPrincipalName: user.username,
        mailNickname: nickname,
        accountEnabled: true,
        passwordProfile: { password, forceChangePasswordNextSignIn: true },
      };
      const created = (await this.client.api('/users').post(payload)) as GraphUser;
      const u = toUser(created);
      if (user.email) u.email = user.email;
      return u;
    } catch (err) {
      return wrapProviderError('azure', 'createUser', err);
    }
  }

  async getUser(_poolId: string, username: string): Promise<User> {
    try {
      const g = (await this.client.api(`/users/${encodeURIComponent(username)}`).get()) as GraphUser;
      return toUser(g);
    } catch (err) {
      return wrapProviderError('azure', 'getUser', err);
    }
  }

  async listUsers(_poolId: string): Promise<User[]> {
    const users: User[] = [];
    try {
      let path: string | undefined = '/users';
      while (path) {
        const resp = (await this.client.api(path).get()) as GraphListResponse<GraphUser>;
        for (const g of resp.value ?? []) users.push(toUser(g));
        path = resp['@odata.nextLink'];
      }
      return users;
    } catch (err) {
      return wrapProviderError('azure', 'listUsers', err);
    }
  }

  async updateUser(_poolId: string, username: string, attributes: Record<string, string>): Promise<void> {
    if (Object.keys(attributes).length === 0) return;
    try {
      await this.client.api(`/users/${encodeURIComponent(username)}`).patch(attributes);
    } catch (err) {
      wrapProviderError('azure', 'updateUser', err);
    }
  }

  async deleteUser(_poolId: string, username: string): Promise<void> {
    try {
      await this.client.api(`/users/${encodeURIComponent(username)}`).delete();
    } catch (err) {
      wrapProviderError('azure', 'deleteUser', err);
    }
  }

  async enableUser(_poolId: string, username: string): Promise<void> {
    try {
      await this.client.api(`/users/${encodeURIComponent(username)}`).patch({ accountEnabled: true });
    } catch (err) {
      wrapProviderError('azure', 'enableUser', err);
    }
  }

  async disableUser(_poolId: string, username: string): Promise<void> {
    try {
      await this.client.api(`/users/${encodeURIComponent(username)}`).patch({ accountEnabled: false });
    } catch (err) {
      wrapProviderError('azure', 'disableUser', err);
    }
  }

  async setPassword(_poolId: string, username: string, password: string, permanent: boolean): Promise<void> {
    try {
      await this.client.api(`/users/${encodeURIComponent(username)}`).patch({
        passwordProfile: { password, forceChangePasswordNextSignIn: !permanent },
      });
    } catch (err) {
      wrapProviderError('azure', 'setPassword', err);
    }
  }

  private async findGroupId(group: string): Promise<string> {
    try {
      const resp = (await this.client
        .api('/groups')
        .filter(`displayName eq '${group}'`)
        .get()) as GraphListResponse<GraphGroup>;
      if (!resp.value || resp.value.length === 0 || !resp.value[0].id) {
        throw new NotFoundError(`azure: findGroup: group ${group} not found`);
      }
      return resp.value[0].id;
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('azure', 'findGroup', err);
    }
  }

  private async findUserId(username: string): Promise<string> {
    try {
      const g = (await this.client.api(`/users/${encodeURIComponent(username)}`).get()) as GraphUser;
      if (!g.id) throw new NotFoundError(`azure: findUser: user ${username} not found`);
      return g.id;
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('azure', 'findUser', err);
    }
  }

  async createGroup(_poolId: string, group: string): Promise<void> {
    try {
      const nickname = group.replace(/[^a-zA-Z0-9]/g, '') || 'group';
      await this.client.api('/groups').post({
        displayName: group,
        mailEnabled: false,
        mailNickname: nickname,
        securityEnabled: true,
      });
    } catch (err) {
      wrapProviderError('azure', 'createGroup', err);
    }
  }

  async deleteGroup(_poolId: string, group: string): Promise<void> {
    const id = await this.findGroupId(group);
    try {
      await this.client.api(`/groups/${encodeURIComponent(id)}`).delete();
    } catch (err) {
      wrapProviderError('azure', 'deleteGroup', err);
    }
  }

  async listGroups(_poolId: string): Promise<GroupInfo[]> {
    const groups: GroupInfo[] = [];
    try {
      let path: string | undefined = '/groups';
      while (path) {
        const resp = (await this.client.api(path).get()) as GraphListResponse<GraphGroup>;
        for (const g of resp.value ?? []) groups.push({ name: g.displayName ?? '', description: g.description ?? '' });
        path = resp['@odata.nextLink'];
      }
      return groups;
    } catch (err) {
      return wrapProviderError('azure', 'listGroups', err);
    }
  }

  async addUserToGroup(_poolId: string, username: string, group: string): Promise<void> {
    const groupId = await this.findGroupId(group);
    const userId = await this.findUserId(username);
    try {
      await this.client.api(`/groups/${encodeURIComponent(groupId)}/members/$ref`).post({
        '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`,
      });
    } catch (err) {
      wrapProviderError('azure', 'addUserToGroup', err);
    }
  }

  async removeUserFromGroup(_poolId: string, username: string, group: string): Promise<void> {
    const groupId = await this.findGroupId(group);
    const userId = await this.findUserId(username);
    try {
      await this.client
        .api(`/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`)
        .delete();
    } catch (err) {
      wrapProviderError('azure', 'removeUserFromGroup', err);
    }
  }

  async listUsersInGroup(_poolId: string, group: string): Promise<User[]> {
    const groupId = await this.findGroupId(group);
    const users: User[] = [];
    try {
      let path: string | undefined = `/groups/${encodeURIComponent(groupId)}/members`;
      while (path) {
        const resp = (await this.client.api(path).get()) as GraphListResponse<GraphUser>;
        for (const g of resp.value ?? []) users.push(toUser(g));
        path = resp['@odata.nextLink'];
      }
      return users;
    } catch (err) {
      return wrapProviderError('azure', 'listUsersInGroup', err);
    }
  }

  async signUp(
    poolId: string,
    _clientId: string,
    username: string,
    password: string,
    attributes?: Record<string, string>,
  ): Promise<void> {
    await this.createUser(poolId, { username, password, attributes });
  }

  async confirmSignUp(_poolId: string, _clientId: string, _username: string, _code: string): Promise<void> {}

  private tokenEndpoint(): string {
    const tenant = this.tenantId || 'organizations';
    return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  }

  private async postToken(form: URLSearchParams): Promise<AuthTokens> {
    let res: Response;
    try {
      res = await fetch(this.tokenEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch (err) {
      return wrapProviderError('azure', 'token', err);
    }

    const data = await res.text();
    let tr: {
      access_token?: string;
      id_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      error?: string;
      error_description?: string;
    };
    try {
      tr = JSON.parse(data) as typeof tr;
    } catch (err) {
      return wrapProviderError('azure', 'unmarshalToken', err);
    }
    if (!res.ok || tr.error) {
      return wrapProviderError(
        'azure',
        'token',
        new Error(`token request failed (${res.status}): ${tr.error ?? ''} ${tr.error_description ?? ''}`),
      );
    }
    return {
      accessToken: tr.access_token ?? '',
      idToken: tr.id_token ?? '',
      refreshToken: tr.refresh_token ?? '',
      expiresIn: tr.expires_in ?? 0,
      tokenType: tr.token_type ?? '',
    };
  }

  async authenticate(_poolId: string, clientId: string, username: string, password: string): Promise<AuthTokens> {
    const form = new URLSearchParams();
    form.set('grant_type', 'password');
    form.set('client_id', clientId);
    form.set('username', username);
    form.set('password', password);
    form.set('scope', 'https://graph.microsoft.com/.default offline_access');
    return this.postToken(form);
  }

  async refreshToken(_poolId: string, clientId: string, refreshToken: string): Promise<AuthTokens> {
    const form = new URLSearchParams();
    form.set('grant_type', 'refresh_token');
    form.set('client_id', clientId);
    form.set('refresh_token', refreshToken);
    form.set('scope', 'https://graph.microsoft.com/.default offline_access');
    const tokens = await this.postToken(form);
    if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
    return tokens;
  }
}
