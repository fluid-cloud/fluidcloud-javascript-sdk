import { randomUUID } from 'node:crypto';

import { cert, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app';
import { getAuth, type Auth, type UserRecord } from 'firebase-admin/auth';

import type { GcpCredentials } from '../../credentials/index.js';
import { UnsupportedError, wrapProviderError } from '../../errors.js';
import type {
  AuthTokens,
  GroupInfo,
  Identity,
  User,
  UserPoolInfo,
  UserPoolOptions,
  UserSpec,
} from '../types/identity.js';
import { gcpClientConfig } from './auth.js';

function identityUnsupported(op: string): UnsupportedError {
  return new UnsupportedError(
    'gcp',
    op,
    'GCP Identity Platform is project-scoped with no Cognito-style pools/groups or server-side sign-in.',
    'User management is available; pools/groups/sign-up/authenticate are not.',
  );
}

function userFromRecord(rec: UserRecord): User {
  const u: User = {
    username: rec.email ?? '',
    email: rec.email ?? '',
    enabled: !rec.disabled,
    status: rec.disabled ? 'disabled' : 'enabled',
    attributes: {},
  };
  if (rec.customClaims && Object.keys(rec.customClaims).length > 0) {
    for (const [k, v] of Object.entries(rec.customClaims)) u.attributes[k] = String(v);
  }
  return u;
}

function toClaims(attributes: Record<string, string>): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attributes)) claims[k] = v;
  return claims;
}

/** GCP Identity Platform (Firebase Auth) identity directory. The project is a single implicit pool; there are no groups or server-side sign-in flows. */
export class CloudIdentity implements Identity {
  private readonly client: Auth;
  private readonly projectId: string;

  constructor(creds: GcpCredentials) {
    const cfg = gcpClientConfig(creds);
    const raw = cfg.credentials;
    const serviceAccount: ServiceAccount = {
      projectId: (raw.project_id as string | undefined) ?? cfg.projectId,
      clientEmail: raw.client_email as string | undefined,
      privateKey: raw.private_key as string | undefined,
    };
    const app: App = initializeApp({ credential: cert(serviceAccount), projectId: cfg.projectId }, `fluidcloud-identity-${randomUUID()}`);
    this.client = getAuth(app);
    this.projectId = cfg.projectId;
  }

  private async resolveUid(username: string): Promise<string> {
    try {
      const rec = await this.client.getUserByEmail(username);
      return rec.uid;
    } catch (err) {
      return wrapProviderError('gcp', 'getUserByEmail', err);
    }
  }

  async listUserPools(): Promise<UserPoolInfo[]> {
    return [{ id: this.projectId, name: this.projectId }];
  }

  async getUserPool(_poolId: string): Promise<UserPoolInfo> {
    return { id: this.projectId, name: this.projectId };
  }

  async createUserPool(_name: string, _opts?: UserPoolOptions): Promise<string> {
    throw identityUnsupported('createUserPool');
  }

  async deleteUserPool(_poolId: string): Promise<void> {
    throw identityUnsupported('deleteUserPool');
  }

  async createUser(_poolId: string, user: UserSpec): Promise<User> {
    try {
      const email = user.email || user.username;
      const rec = await this.client.createUser({
        email,
        ...(user.password ? { password: user.password } : {}),
      });
      if (user.attributes && Object.keys(user.attributes).length > 0) {
        await this.client.setCustomUserClaims(rec.uid, toClaims(user.attributes));
      }
      const u = userFromRecord(rec);
      if (user.attributes && Object.keys(user.attributes).length > 0) u.attributes = user.attributes;
      return u;
    } catch (err) {
      return wrapProviderError('gcp', 'createUser', err);
    }
  }

  async getUser(_poolId: string, username: string): Promise<User> {
    try {
      const rec = await this.client.getUserByEmail(username);
      return userFromRecord(rec);
    } catch (err) {
      return wrapProviderError('gcp', 'getUser', err);
    }
  }

  async listUsers(_poolId: string): Promise<User[]> {
    const out: User[] = [];
    try {
      let pageToken: string | undefined;
      do {
        const result = await this.client.listUsers(1000, pageToken);
        for (const rec of result.users) out.push(userFromRecord(rec));
        pageToken = result.pageToken;
      } while (pageToken);
      return out;
    } catch (err) {
      return wrapProviderError('gcp', 'listUsers', err);
    }
  }

  async updateUser(_poolId: string, username: string, attributes: Record<string, string>): Promise<void> {
    const uid = await this.resolveUid(username);
    try {
      await this.client.setCustomUserClaims(uid, toClaims(attributes));
    } catch (err) {
      wrapProviderError('gcp', 'updateUser', err);
    }
  }

  async deleteUser(_poolId: string, username: string): Promise<void> {
    const uid = await this.resolveUid(username);
    try {
      await this.client.deleteUser(uid);
    } catch (err) {
      wrapProviderError('gcp', 'deleteUser', err);
    }
  }

  async enableUser(_poolId: string, username: string): Promise<void> {
    await this.setDisabled(username, false);
  }

  async disableUser(_poolId: string, username: string): Promise<void> {
    await this.setDisabled(username, true);
  }

  private async setDisabled(username: string, disabled: boolean): Promise<void> {
    const uid = await this.resolveUid(username);
    try {
      await this.client.updateUser(uid, { disabled });
    } catch (err) {
      wrapProviderError('gcp', 'updateUser', err);
    }
  }

  async setPassword(_poolId: string, username: string, password: string, _permanent: boolean): Promise<void> {
    const uid = await this.resolveUid(username);
    try {
      await this.client.updateUser(uid, { password });
    } catch (err) {
      wrapProviderError('gcp', 'setPassword', err);
    }
  }

  async createGroup(_poolId: string, _group: string): Promise<void> {
    throw identityUnsupported('createGroup');
  }

  async deleteGroup(_poolId: string, _group: string): Promise<void> {
    throw identityUnsupported('deleteGroup');
  }

  async listGroups(_poolId: string): Promise<GroupInfo[]> {
    throw identityUnsupported('listGroups');
  }

  async addUserToGroup(_poolId: string, _username: string, _group: string): Promise<void> {
    throw identityUnsupported('addUserToGroup');
  }

  async removeUserFromGroup(_poolId: string, _username: string, _group: string): Promise<void> {
    throw identityUnsupported('removeUserFromGroup');
  }

  async listUsersInGroup(_poolId: string, _group: string): Promise<User[]> {
    throw identityUnsupported('listUsersInGroup');
  }

  async signUp(
    _poolId: string,
    _clientId: string,
    _username: string,
    _password: string,
    _attributes?: Record<string, string>,
  ): Promise<void> {
    throw identityUnsupported('signUp');
  }

  async confirmSignUp(_poolId: string, _clientId: string, _username: string, _code: string): Promise<void> {
    throw identityUnsupported('confirmSignUp');
  }

  async authenticate(_poolId: string, _clientId: string, _username: string, _password: string): Promise<AuthTokens> {
    throw identityUnsupported('authenticate');
  }

  async refreshToken(_poolId: string, _clientId: string, _refreshToken: string): Promise<AuthTokens> {
    throw identityUnsupported('refreshToken');
  }
}
