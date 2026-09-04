import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AuthFlowType,
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  CreateGroupCommand,
  CreateUserPoolCommand,
  DeleteGroupCommand,
  DeleteUserPoolCommand,
  DescribeUserPoolCommand,
  InitiateAuthCommand,
  ListGroupsCommand,
  ListUserPoolsCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  SignUpCommand,
  VerifiedAttributeType,
  type AttributeType,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';

import type { AwsCredentials } from '../../credentials/index.js';
import { NotFoundError, wrapProviderError } from '../../errors.js';
import type {
  AuthTokens,
  GroupInfo,
  Identity,
  User,
  UserPoolInfo,
  UserPoolOptions,
  UserSpec,
} from '../types/identity.js';
import { awsClientConfig } from './auth.js';

function buildAttributes(email: string | undefined, attributes: Record<string, string> | undefined): AttributeType[] {
  const attrs: AttributeType[] = [];
  if (email) attrs.push({ Name: 'email', Value: email });
  for (const [k, v] of Object.entries(attributes ?? {})) attrs.push({ Name: k, Value: v });
  return attrs;
}

function userFromCognito(username: string, enabled: boolean | undefined, status: string, attributes: AttributeType[] | undefined): User {
  const attrs: Record<string, string> = {};
  let email = '';
  for (const a of attributes ?? []) {
    const name = a.Name ?? '';
    const value = a.Value ?? '';
    attrs[name] = value;
    if (name === 'email') email = value;
  }
  return { username, email, enabled: enabled ?? false, status, attributes: attrs };
}

function tokensFromCognito(result: AuthenticationResultType): AuthTokens {
  return {
    accessToken: result.AccessToken ?? '',
    idToken: result.IdToken ?? '',
    refreshToken: result.RefreshToken ?? '',
    expiresIn: result.ExpiresIn ?? 0,
    tokenType: result.TokenType ?? '',
  };
}

/** AWS Cognito User Pools identity directory. */
export class CognitoIdentity implements Identity {
  private readonly client: CognitoIdentityProviderClient;

  constructor(creds: AwsCredentials, region?: string) {
    this.client = new CognitoIdentityProviderClient(awsClientConfig(creds, region));
  }

  async createUserPool(name: string, opts?: UserPoolOptions): Promise<string> {
    try {
      const out = await this.client.send(
        new CreateUserPoolCommand({
          PoolName: name,
          ...(opts?.autoVerifiedEmail ? { AutoVerifiedAttributes: [VerifiedAttributeType.EMAIL] } : {}),
        }),
      );
      if (!out.UserPool?.Id) throw new NotFoundError('aws: createUserPool: user pool not found');
      return out.UserPool.Id;
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('aws', 'createUserPool', err);
    }
  }

  async deleteUserPool(poolId: string): Promise<void> {
    try {
      await this.client.send(new DeleteUserPoolCommand({ UserPoolId: poolId }));
    } catch (err) {
      wrapProviderError('aws', 'deleteUserPool', err);
    }
  }

  async listUserPools(): Promise<UserPoolInfo[]> {
    const pools: UserPoolInfo[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.client.send(
          new ListUserPoolsCommand({ MaxResults: 60, NextToken: nextToken }),
        );
        for (const p of out.UserPools ?? []) pools.push({ id: p.Id ?? '', name: p.Name ?? '' });
        nextToken = out.NextToken;
      } while (nextToken);
      return pools;
    } catch (err) {
      return wrapProviderError('aws', 'listUserPools', err);
    }
  }

  async getUserPool(poolId: string): Promise<UserPoolInfo> {
    try {
      const out = await this.client.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
      if (!out.UserPool) throw new NotFoundError('aws: getUserPool: user pool not found');
      return { id: out.UserPool.Id ?? '', name: out.UserPool.Name ?? '' };
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('aws', 'getUserPool', err);
    }
  }

  async createUser(poolId: string, user: UserSpec): Promise<User> {
    try {
      const attrs = buildAttributes(user.email, user.attributes);
      const out = await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: user.username,
          ...(attrs.length > 0 ? { UserAttributes: attrs } : {}),
          ...(user.password ? { TemporaryPassword: user.password } : {}),
        }),
      );
      if (!out.User) throw new NotFoundError('aws: createUser: user not found');
      return userFromCognito(out.User.Username ?? '', out.User.Enabled, String(out.User.UserStatus ?? ''), out.User.Attributes);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('aws', 'createUser', err);
    }
  }

  async getUser(poolId: string, username: string): Promise<User> {
    try {
      const out = await this.client.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }));
      return userFromCognito(out.Username ?? '', out.Enabled, String(out.UserStatus ?? ''), out.UserAttributes);
    } catch (err) {
      return wrapProviderError('aws', 'getUser', err);
    }
  }

  async listUsers(poolId: string): Promise<User[]> {
    const users: User[] = [];
    let paginationToken: string | undefined;
    try {
      do {
        const out = await this.client.send(
          new ListUsersCommand({ UserPoolId: poolId, PaginationToken: paginationToken }),
        );
        for (const u of out.Users ?? []) {
          users.push(userFromCognito(u.Username ?? '', u.Enabled, String(u.UserStatus ?? ''), u.Attributes));
        }
        paginationToken = out.PaginationToken;
      } while (paginationToken);
      return users;
    } catch (err) {
      return wrapProviderError('aws', 'listUsers', err);
    }
  }

  async updateUser(poolId: string, username: string, attributes: Record<string, string>): Promise<void> {
    try {
      await this.client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: poolId,
          Username: username,
          UserAttributes: buildAttributes(undefined, attributes),
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'updateUser', err);
    }
  }

  async deleteUser(poolId: string, username: string): Promise<void> {
    try {
      await this.client.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: username }));
    } catch (err) {
      wrapProviderError('aws', 'deleteUser', err);
    }
  }

  async enableUser(poolId: string, username: string): Promise<void> {
    try {
      await this.client.send(new AdminEnableUserCommand({ UserPoolId: poolId, Username: username }));
    } catch (err) {
      wrapProviderError('aws', 'enableUser', err);
    }
  }

  async disableUser(poolId: string, username: string): Promise<void> {
    try {
      await this.client.send(new AdminDisableUserCommand({ UserPoolId: poolId, Username: username }));
    } catch (err) {
      wrapProviderError('aws', 'disableUser', err);
    }
  }

  async setPassword(poolId: string, username: string, password: string, permanent: boolean): Promise<void> {
    try {
      await this.client.send(
        new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: username, Password: password, Permanent: permanent }),
      );
    } catch (err) {
      wrapProviderError('aws', 'setPassword', err);
    }
  }

  async createGroup(poolId: string, group: string): Promise<void> {
    try {
      await this.client.send(new CreateGroupCommand({ UserPoolId: poolId, GroupName: group }));
    } catch (err) {
      wrapProviderError('aws', 'createGroup', err);
    }
  }

  async deleteGroup(poolId: string, group: string): Promise<void> {
    try {
      await this.client.send(new DeleteGroupCommand({ UserPoolId: poolId, GroupName: group }));
    } catch (err) {
      wrapProviderError('aws', 'deleteGroup', err);
    }
  }

  async listGroups(poolId: string): Promise<GroupInfo[]> {
    const groups: GroupInfo[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.client.send(new ListGroupsCommand({ UserPoolId: poolId, NextToken: nextToken }));
        for (const g of out.Groups ?? []) groups.push({ name: g.GroupName ?? '', description: g.Description ?? '' });
        nextToken = out.NextToken;
      } while (nextToken);
      return groups;
    } catch (err) {
      return wrapProviderError('aws', 'listGroups', err);
    }
  }

  async addUserToGroup(poolId: string, username: string, group: string): Promise<void> {
    try {
      await this.client.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
    } catch (err) {
      wrapProviderError('aws', 'addUserToGroup', err);
    }
  }

  async removeUserFromGroup(poolId: string, username: string, group: string): Promise<void> {
    try {
      await this.client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
    } catch (err) {
      wrapProviderError('aws', 'removeUserFromGroup', err);
    }
  }

  async listUsersInGroup(poolId: string, group: string): Promise<User[]> {
    const users: User[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.client.send(
          new ListUsersInGroupCommand({ UserPoolId: poolId, GroupName: group, NextToken: nextToken }),
        );
        for (const u of out.Users ?? []) {
          users.push(userFromCognito(u.Username ?? '', u.Enabled, String(u.UserStatus ?? ''), u.Attributes));
        }
        nextToken = out.NextToken;
      } while (nextToken);
      return users;
    } catch (err) {
      return wrapProviderError('aws', 'listUsersInGroup', err);
    }
  }

  async signUp(poolId: string, clientId: string, username: string, password: string, attributes?: Record<string, string>): Promise<void> {
    try {
      const attrs = buildAttributes(undefined, attributes);
      await this.client.send(
        new SignUpCommand({
          ClientId: clientId,
          Username: username,
          Password: password,
          ...(attrs.length > 0 ? { UserAttributes: attrs } : {}),
        }),
      );
    } catch (err) {
      wrapProviderError('aws', 'signUp', err);
    }
  }

  async confirmSignUp(poolId: string, clientId: string, username: string, code: string): Promise<void> {
    try {
      await this.client.send(new ConfirmSignUpCommand({ ClientId: clientId, Username: username, ConfirmationCode: code }));
    } catch (err) {
      wrapProviderError('aws', 'confirmSignUp', err);
    }
  }

  async authenticate(poolId: string, clientId: string, username: string, password: string): Promise<AuthTokens> {
    try {
      const out = await this.client.send(
        new InitiateAuthCommand({
          ClientId: clientId,
          AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
          AuthParameters: { USERNAME: username, PASSWORD: password },
        }),
      );
      if (!out.AuthenticationResult) throw new NotFoundError('aws: authenticate: authentication result not found');
      return tokensFromCognito(out.AuthenticationResult);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('aws', 'authenticate', err);
    }
  }

  async refreshToken(poolId: string, clientId: string, refreshToken: string): Promise<AuthTokens> {
    try {
      const out = await this.client.send(
        new InitiateAuthCommand({
          ClientId: clientId,
          AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }),
      );
      if (!out.AuthenticationResult) throw new NotFoundError('aws: refreshToken: authentication result not found');
      const tokens = tokensFromCognito(out.AuthenticationResult);
      if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
      return tokens;
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return wrapProviderError('aws', 'refreshToken', err);
    }
  }
}
