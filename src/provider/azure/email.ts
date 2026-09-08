import { type EmailAddress, EmailClient, type EmailContent } from '@azure/communication-email';

import { InvalidCredentialsError, UnsupportedError, wrapProviderError } from '../../errors.js';
import type { Email, SendEmailOptions } from '../types/email.js';

/** Azure Communication Services-backed transactional email. */
export class AcsEmail implements Email {
  private readonly client: EmailClient;

  constructor(endpoint: string, key: string) {
    if (!endpoint || !key) throw new InvalidCredentialsError();
    this.client = new EmailClient(`endpoint=${endpoint};accesskey=${key}`);
  }

  /** Sends an email via the ACS Email API and returns the operation id. */
  async sendEmail(opts: SendEmailOptions): Promise<string> {
    const toAddresses: EmailAddress[] = opts.to.map((address) => ({ address }));
    const ccAddresses: EmailAddress[] = (opts.cc ?? []).map((address) => ({ address }));
    const bccAddresses: EmailAddress[] = (opts.bcc ?? []).map((address) => ({ address }));
    const replyTo: EmailAddress[] = (opts.replyTo ?? []).map((address) => ({ address }));

    const content: EmailContent = {
      subject: opts.subject,
      html: opts.htmlBody ?? '',
      plainText: opts.body,
    };

    try {
      const poller = await this.client.beginSend({
        senderAddress: opts.from,
        recipients: { to: toAddresses, cc: ccAddresses, bcc: bccAddresses },
        content,
        replyTo,
      });
      const result = await poller.pollUntilDone();
      return result.id;
    } catch (err) {
      wrapProviderError('azure', 'sendEmail', err);
    }
  }

  /** Azure Communication Services does not support raw MIME email. */
  async sendRawEmail(_raw: Buffer | Uint8Array, _from: string): Promise<string> {
    throw new UnsupportedError(
      'azure',
      'sendRawEmail',
      'Azure Communication Services does not support raw MIME email.',
      'Use sendEmail with structured content instead.',
    );
  }

  /** Azure Communication Services does not support per-email identity verification via API. */
  async verifyEmailIdentity(_email: string): Promise<void> {
    throw new UnsupportedError(
      'azure',
      'verifyEmailIdentity',
      'Azure Communication Services does not support per-email identity verification via API. Verify domains via the Azure portal using DNS records.',
    );
  }

  /** Azure Communication Services does not support listing email identities via API. */
  async listIdentities(): Promise<string[]> {
    throw new UnsupportedError(
      'azure',
      'listIdentities',
      'Azure Communication Services does not support listing email identities via API.',
      'Manage domains via the Azure portal.',
    );
  }

  /** Azure Communication Services does not support deleting email identities via API. */
  async deleteIdentity(_identity: string): Promise<void> {
    throw new UnsupportedError(
      'azure',
      'deleteIdentity',
      'Azure Communication Services does not support deleting email identities via API.',
      'Manage domains via the Azure portal.',
    );
  }
}
