import { UnsupportedError } from '../../errors.js';
import type { Email, SendEmailOptions } from '../types/email.js';

function unsupported(operation: string): UnsupportedError {
  return new UnsupportedError(
    'gcp',
    operation,
    'GCP has no native transactional email service.',
    'Use a third-party provider such as SendGrid or Mailgun.',
  );
}

/** GCP has no native transactional email service; every operation throws. */
export class GcpEmail implements Email {
  /** Always throws: GCP has no native transactional email service. */
  async sendEmail(_opts: SendEmailOptions): Promise<string> {
    throw unsupported('sendEmail');
  }

  /** Always throws: GCP has no native transactional email service. */
  async sendRawEmail(_raw: Buffer | Uint8Array, _from: string): Promise<string> {
    throw unsupported('sendRawEmail');
  }

  /** Always throws: GCP has no native transactional email service. */
  async verifyEmailIdentity(_email: string): Promise<void> {
    throw unsupported('verifyEmailIdentity');
  }

  /** Always throws: GCP has no native transactional email service. */
  async listIdentities(): Promise<string[]> {
    throw unsupported('listIdentities');
  }

  /** Always throws: GCP has no native transactional email service. */
  async deleteIdentity(_identity: string): Promise<void> {
    throw unsupported('deleteIdentity');
  }
}
