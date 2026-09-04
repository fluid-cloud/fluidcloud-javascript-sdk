/**
 * Unified managed Redis cache. Maps to AWS ElastiCache, Azure Cache for Redis,
 * OCI Cache and GCP Memorystore. All speak the Redis wire protocol, so the data
 * plane is identical and only endpoint, TLS and auth differ. The cluster is
 * assumed to already exist. All TTLs are in seconds.
 */
export interface Cache {
  // Strings
  /** Reads a key. Throws NotFoundError when the key is absent. */
  get(key: string): Promise<string>;
  /** Writes a key with a TTL in seconds; 0 means no expiry. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Deletes keys, returning how many were removed. */
  del(...keys: string[]): Promise<number>;
  /** Counts which of the given keys exist. */
  exists(...keys: string[]): Promise<number>;
  /** Sets a TTL in seconds on an existing key. */
  expire(key: string, ttlSeconds: number): Promise<boolean>;
  /** Reads remaining TTL in seconds; -1 no expiry, -2 missing. */
  ttl(key: string): Promise<number>;
  /** Increments by one. */
  incr(key: string): Promise<number>;
  /** Increments by n. */
  incrBy(key: string, n: number): Promise<number>;
  /** Decrements by one. */
  decr(key: string): Promise<number>;

  // Hashes
  /** Reads one hash field. */
  hGet(key: string, field: string): Promise<string>;
  /** Writes hash fields. */
  hSet(key: string, values: Record<string, string>): Promise<void>;
  /** Reads a whole hash. */
  hGetAll(key: string): Promise<Record<string, string>>;
  /** Deletes hash fields. */
  hDel(key: string, ...fields: string[]): Promise<number>;

  // Lists
  /** Pushes onto the head. */
  lPush(key: string, ...values: string[]): Promise<number>;
  /** Pushes onto the tail. */
  rPush(key: string, ...values: string[]): Promise<number>;
  /** Pops from the head. */
  lPop(key: string): Promise<string>;
  /** Pops from the tail. */
  rPop(key: string): Promise<string>;
  /** Reads an inclusive range. */
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  /** Reads list length. */
  lLen(key: string): Promise<number>;

  // Sets
  /** Adds set members. */
  sAdd(key: string, ...members: string[]): Promise<number>;
  /** Removes set members. */
  sRem(key: string, ...members: string[]): Promise<number>;
  /** Reads all set members. */
  sMembers(key: string): Promise<string[]>;
  /** Reports set membership. */
  sIsMember(key: string, member: string): Promise<boolean>;

  // Keys and admin
  /** Lists keys matching a glob pattern. */
  keys(pattern: string): Promise<string[]>;
  /**
   * Incrementally iterates the keyspace. The cursor is a string because Redis
   * cursors exceed the safe integer range.
   */
  scan(cursor: string, match: string, count: number): Promise<{ keys: string[]; cursor: string }>;
  /** Reads a key type. */
  type(key: string): Promise<string>;
  /** Pings the server. */
  ping(): Promise<void>;
  /** Flushes the selected logical database. */
  flushDb(): Promise<void>;

  /** Releases the underlying connection pool. */
  close(): Promise<void>;
}
