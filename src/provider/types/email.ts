export interface SendEmailOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  replyTo?: string[];
}

/** Unified transactional email. */
export interface Email {
  /** Sends a message and returns the provider message id. */
  sendEmail(opts: SendEmailOptions): Promise<string>;

  /** Sends a pre-built MIME message. */
  sendRawEmail(raw: Buffer | Uint8Array, from: string): Promise<string>;

  /** Starts verification for a sender identity. */
  verifyEmailIdentity(email: string): Promise<void>;

  /** Lists verified sender identities. */
  listIdentities(): Promise<string[]>;

  /** Removes a sender identity. */
  deleteIdentity(identity: string): Promise<void>;
}
