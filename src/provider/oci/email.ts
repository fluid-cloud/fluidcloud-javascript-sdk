import { EmailClient } from 'oci-email';
import { EmailDPClient } from 'oci-emaildataplane';

import type { OciCredentials } from '../../credentials/index.js';
import { NotFoundError, InvalidCredentialsError, wrapProviderError } from '../../errors.js';
import type { Email, SendEmailOptions } from '../types/email.js';
import { ociAuthProvider } from './auth.js';

interface ParsedMimeMessage {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  contentType: string;
  body: string;
}

function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.match(/<([^>]+)>/)?.[1]?.trim() ?? part);
}

function parseMimeMessage(raw: Buffer): ParsedMimeMessage {
  const text = raw.toString('utf-8');
  const headerEnd = text.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const body = headerEnd === -1 ? '' : text.slice(headerEnd).replace(/^\r?\n\r?\n/, '');
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(idx + 1).trim());
  }
  return {
    subject: headers.get('subject') ?? '',
    from: headers.get('from') ?? '',
    to: parseAddressList(headers.get('to')),
    cc: parseAddressList(headers.get('cc')),
    bcc: parseAddressList(headers.get('bcc')),
    replyTo: parseAddressList(headers.get('reply-to')),
    contentType: headers.get('content-type') ?? '',
    body,
  };
}

/** OCI Email Delivery: sender management via oci-email, sending via the emaildataplane HTTPS API. */
export class OciEmail implements Email {
  private readonly client: EmailClient;
  private readonly dataClient: EmailDPClient;
  private readonly compartment: string;

  constructor(creds: OciCredentials, compartment: string) {
    if (!creds) throw new InvalidCredentialsError();
    const resolvedCompartment = compartment || creds.compartmentOcid || '';
    const provider = ociAuthProvider(creds);
    this.client = new EmailClient({ authenticationDetailsProvider: provider });
    this.dataClient = new EmailDPClient({ authenticationDetailsProvider: provider });
    if (creds.region) {
      this.client.regionId = creds.region;
      this.dataClient.regionId = creds.region;
    }
    this.compartment = resolvedCompartment;
  }

  /** Submits an email via OCI Email Delivery's data-plane HTTPS API. */
  async sendEmail(opts: SendEmailOptions): Promise<string> {
    try {
      const out = await this.dataClient.submitEmail({
        submitEmailDetails: {
          sender: { senderAddress: { email: opts.from }, compartmentId: this.compartment },
          recipients: {
            to: opts.to.map((address) => ({ email: address })),
            cc: (opts.cc ?? []).map((address) => ({ email: address })),
            bcc: (opts.bcc ?? []).map((address) => ({ email: address })),
          },
          subject: opts.subject,
          ...(opts.body ? { bodyText: opts.body } : {}),
          ...(opts.htmlBody ? { bodyHtml: opts.htmlBody } : {}),
          ...(opts.replyTo && opts.replyTo.length > 0
            ? { replyTo: opts.replyTo.map((address) => ({ email: address })) }
            : {}),
        },
      });
      return out.emailSubmittedResponse?.messageId || out.opcRequestId || '';
    } catch (err) {
      wrapProviderError('oci', 'sendEmail', err);
    }
  }

  /** Parses a raw MIME message and submits it via sendEmail; the body is carried as text or HTML by Content-Type. */
  async sendRawEmail(raw: Buffer | Uint8Array, from: string): Promise<string> {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const parsed = parseMimeMessage(buf);
    const isHtml = parsed.contentType.toLowerCase().includes('text/html');
    return this.sendEmail({
      from: from || parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
      ...(isHtml ? { htmlBody: parsed.body } : { body: parsed.body }),
    });
  }

  /** Registers an approved sender email address. */
  async verifyEmailIdentity(email: string): Promise<void> {
    try {
      await this.client.createSender({
        createSenderDetails: { compartmentId: this.compartment, emailAddress: email },
      });
    } catch (err) {
      wrapProviderError('oci', 'verifyEmailIdentity', err);
    }
  }

  /** Lists all approved sender email addresses in the compartment. */
  async listIdentities(): Promise<string[]> {
    const results: string[] = [];
    let page: string | undefined;
    try {
      do {
        const resp = await this.client.listSenders({
          compartmentId: this.compartment,
          page,
        });
        for (const sender of resp.items) {
          if (sender.emailAddress) results.push(sender.emailAddress);
        }
        page = resp.opcNextPage;
      } while (page);
      return results;
    } catch (err) {
      wrapProviderError('oci', 'listIdentities', err);
    }
  }

  /** Removes an approved sender by email address. */
  async deleteIdentity(identity: string): Promise<void> {
    let page: string | undefined;
    try {
      do {
        const resp = await this.client.listSenders({
          compartmentId: this.compartment,
          emailAddress: identity,
          page,
        });
        for (const sender of resp.items) {
          if (sender.emailAddress === identity && sender.id) {
            await this.client.deleteSender({ senderId: sender.id });
            return;
          }
        }
        page = resp.opcNextPage;
      } while (page);
    } catch (err) {
      wrapProviderError('oci', 'deleteIdentity', err);
    }
    throw new NotFoundError(`sender identity not found: ${identity}`);
  }
}
