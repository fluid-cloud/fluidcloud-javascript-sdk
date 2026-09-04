export interface UserPoolOptions {
  /** Enables email as an auto-verified attribute where supported. */
  autoVerifiedEmail?: boolean;
}

export interface UserPoolInfo {
  id: string;
  name: string;
}

export interface UserSpec {
  username: string;
  email?: string;
  /** Optional temporary password. */
  password?: string;
  attributes?: Record<string, string>;
}

export interface User {
  username: string;
  email: string;
  enabled: boolean;
  status: string;
  attributes: Record<string, string>;
}

export interface GroupInfo {
  name: string;
  description: string;
}

export interface AuthTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  /** Lifetime in seconds. */
  expiresIn: number;
  tokenType: string;
}

/**
 * Unified identity directory. Maps to AWS Cognito user pools, Azure Entra ID via
 * Microsoft Graph, and OCI IAM Identity Domains. The "user pool" concept is
 * native on AWS and emulated where the directory is singular.
 */
export interface Identity {
  /** Creates a user pool and returns its id. */
  createUserPool(name: string, opts?: UserPoolOptions): Promise<string>;

  /** Deletes a user pool. */
  deleteUserPool(poolId: string): Promise<void>;

  /** Lists user pools. */
  listUserPools(): Promise<UserPoolInfo[]>;

  /** Reads one user pool. */
  getUserPool(poolId: string): Promise<UserPoolInfo>;

  /** Creates a user. */
  createUser(poolId: string, user: UserSpec): Promise<User>;

  /** Reads a user. */
  getUser(poolId: string, username: string): Promise<User>;

  /** Lists users in a pool. */
  listUsers(poolId: string): Promise<User[]>;

  /** Updates user attributes. */
  updateUser(poolId: string, username: string, attributes: Record<string, string>): Promise<void>;

  /** Deletes a user. */
  deleteUser(poolId: string, username: string): Promise<void>;

  /** Enables a user. */
  enableUser(poolId: string, username: string): Promise<void>;

  /** Disables a user. */
  disableUser(poolId: string, username: string): Promise<void>;

  /** Sets a user password, permanently or as a temporary one. */
  setPassword(poolId: string, username: string, password: string, permanent: boolean): Promise<void>;

  /** Creates a group. */
  createGroup(poolId: string, group: string): Promise<void>;

  /** Deletes a group. */
  deleteGroup(poolId: string, group: string): Promise<void>;

  /** Lists groups. */
  listGroups(poolId: string): Promise<GroupInfo[]>;

  /** Adds a user to a group. */
  addUserToGroup(poolId: string, username: string, group: string): Promise<void>;

  /** Removes a user from a group. */
  removeUserFromGroup(poolId: string, username: string, group: string): Promise<void>;

  /** Lists the users in a group. */
  listUsersInGroup(poolId: string, group: string): Promise<User[]>;

  /** Self-service sign-up. */
  signUp(
    poolId: string,
    clientId: string,
    username: string,
    password: string,
    attributes?: Record<string, string>,
  ): Promise<void>;

  /** Confirms a sign-up with the emailed code. */
  confirmSignUp(poolId: string, clientId: string, username: string, code: string): Promise<void>;

  /** Authenticates a user and returns tokens. */
  authenticate(poolId: string, clientId: string, username: string, password: string): Promise<AuthTokens>;

  /** Exchanges a refresh token for new tokens. */
  refreshToken(poolId: string, clientId: string, refreshToken: string): Promise<AuthTokens>;
}
