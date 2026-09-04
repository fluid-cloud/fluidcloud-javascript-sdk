import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  SendEmailCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';

import type { AwsCredentials } from '../../credentials/index.js';
import { InvalidCredentialsError, wrapProviderError } from '../../errors.js';
import type { Email, SendEmailOptions } from '../types/email.js';
import { awsClientConfig } from './auth.js';

/** SES v2-backed transactional email. */
export class SesEmail implements Email {
  private readonly client: SESv2Client;

  constructor(creds: AwsCredentials) {
    if (!creds) throw new InvalidCredentialsError();
    this.client = new SESv2Client(awsClientConfig(creds));
  }

  /** Sends a simple email via SES v2 and returns the message id. */
  async sendEmail(opts: SendEmailOptions): Promise<string> {
    try {
      const out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: opts.from,
          Destination: { ToAddresses: opts.to, CcAddresses: opts.cc, BccAddresses: opts.bcc },
          Content: {
            Simple: {
              Subject: { Data: opts.subject },
              Body: {
                ...(opts.body ? { Text: { Data: opts.body } } : {}),
                ...(opts.htmlBody ? { Html: { Data: opts.htmlBody } } : {}),
              },
            },
          },
          ...(opts.replyTo && opts.replyTo.length > 0 ? { ReplyToAddresses: opts.replyTo } : {}),
        }),
      );
      return out.MessageId ?? '';
    } catch (err) {
      wrapProviderError('aws', 'sendEmail', err);
    }
  }

  /** Sends a pre-built MIME message via SES v2's native raw send. */
  async sendRawEmail(raw: Buffer | Uint8Array, from: string): Promise<string> {
    try {
      const out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Content: { Raw: { Data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw) } },
        }),
      );
      return out.MessageId ?? '';
    } catch (err) {
      wrapProviderError('aws', 'sendRawEmail', err);
    }
  }

  /** Starts SES verification for a sender identity. */
  async verifyEmailIdentity(email: string): Promise<void> {
    try {
      await this.client.send(new CreateEmailIdentityCommand({ EmailIdentity: email }));
    } catch (err) {
      wrapProviderError('aws', 'verifyEmailIdentity', err);
    }
  }

  /** Lists every verified SES identity, paging through all results. */
  async listIdentities(): Promise<string[]> {
    const identities: string[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const out = await this.client.send(new ListEmailIdentitiesCommand({ NextToken: nextToken }));
        for (const id of out.EmailIdentities ?? []) {
          if (id.IdentityName) identities.push(id.IdentityName);
        }
        nextToken = out.NextToken;
      } while (nextToken);
      return identities;
    } catch (err) {
      wrapProviderError('aws', 'listIdentities', err);
    }
  }

  /** Deletes a verified SES identity. */
  async deleteIdentity(identity: string): Promise<void> {
    try {
      await this.client.send(new DeleteEmailIdentityCommand({ EmailIdentity: identity }));
    } catch (err) {
      wrapProviderError('aws', 'deleteIdentity', err);
    }
  }
}
