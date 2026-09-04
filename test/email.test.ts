import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidCredentialsError, NotFoundError, ProviderError, UnsupportedError } from '../src/errors.js';
import type { SendEmailOptions } from '../src/provider/types/email.js';

const sesSendMock = vi.fn();
vi.mock('@aws-sdk/client-sesv2', () => {
  class Command {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class SESv2Client {
    send = sesSendMock;
  }
  class SendEmailCommand extends Command {}
  class CreateEmailIdentityCommand extends Command {}
  class ListEmailIdentitiesCommand extends Command {}
  class DeleteEmailIdentityCommand extends Command {}
  return { SESv2Client, SendEmailCommand, CreateEmailIdentityCommand, ListEmailIdentitiesCommand, DeleteEmailIdentityCommand };
});

const acsBeginSendMock = vi.fn();
const AcsEmailClientCtor = vi.fn(function (this: { connectionString: string; beginSend: typeof acsBeginSendMock }, connectionString: string) {
  this.connectionString = connectionString;
  this.beginSend = acsBeginSendMock;
});
vi.mock('@azure/communication-email', () => ({ EmailClient: AcsEmailClientCtor }));

const ociCreateSenderMock = vi.fn();
const ociListSendersMock = vi.fn();
const ociDeleteSenderMock = vi.fn();
vi.mock('oci-email', () => {
  class EmailClient {
    regionId = '';
    createSender = ociCreateSenderMock;
    listSenders = ociListSendersMock;
    deleteSender = ociDeleteSenderMock;
  }
  return { EmailClient };
});

const ociSubmitEmailMock = vi.fn();
vi.mock('oci-emaildataplane', () => {
  class EmailDPClient {
    regionId = '';
    submitEmail = ociSubmitEmailMock;
  }
  return { EmailDPClient };
});

const { SesEmail } = await import('../src/provider/aws/email.js');
const { AcsEmail } = await import('../src/provider/azure/email.js');
const { GcpEmail } = await import('../src/provider/gcp/email.js');
const { OciEmail } = await import('../src/provider/oci/email.js');

const awsCreds = { accessKey: 'AKIA', secretAccessKey: 'shh', region: 'us-east-1' };
const ociCreds = {
  tenancyOcid: 'ocid1.tenancy.oc1..t',
  userOcid: 'ocid1.user.oc1..u',
  fingerprint: 'aa:bb',
  privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  region: 'us-ashburn-1',
};

const baseOpts: SendEmailOptions = { from: 'a@x.com', to: ['b@x.com'], subject: 'hi' };

describe('SesEmail (aws)', () => {
  beforeEach(() => sesSendMock.mockReset());

  it('sendEmail maps to a Simple SendEmailCommand', async () => {
    sesSendMock.mockResolvedValueOnce({ MessageId: 'mid-1' });
    const svc = new SesEmail(awsCreds);
    const id = await svc.sendEmail({ ...baseOpts, cc: ['c@x.com'], body: 'text', htmlBody: '<p>hi</p>', replyTo: ['r@x.com'] });
    expect(id).toBe('mid-1');
    const input = sesSendMock.mock.calls[0][0].input as Record<string, any>;
    expect(input.FromEmailAddress).toBe('a@x.com');
    expect(input.Destination).toEqual({ ToAddresses: ['b@x.com'], CcAddresses: ['c@x.com'], BccAddresses: undefined });
    expect(input.Content.Simple.Subject.Data).toBe('hi');
    expect(input.Content.Simple.Body.Text.Data).toBe('text');
    expect(input.Content.Simple.Body.Html.Data).toBe('<p>hi</p>');
    expect(input.ReplyToAddresses).toEqual(['r@x.com']);
  });

  it('sendRawEmail uses the native SES raw send', async () => {
    sesSendMock.mockResolvedValueOnce({ MessageId: 'mid-2' });
    const svc = new SesEmail(awsCreds);
    const id = await svc.sendRawEmail(Buffer.from('raw mime'), 'a@x.com');
    expect(id).toBe('mid-2');
    const input = sesSendMock.mock.calls[0][0].input as Record<string, any>;
    expect(input.FromEmailAddress).toBe('a@x.com');
    expect(input.Content.Raw.Data).toEqual(Buffer.from('raw mime'));
  });

  it('verifyEmailIdentity creates an email identity', async () => {
    sesSendMock.mockResolvedValueOnce({});
    const svc = new SesEmail(awsCreds);
    await svc.verifyEmailIdentity('a@x.com');
    expect(sesSendMock.mock.calls[0][0].input).toEqual({ EmailIdentity: 'a@x.com' });
  });

  it('listIdentities pages through all results', async () => {
    sesSendMock
      .mockResolvedValueOnce({ EmailIdentities: [{ IdentityName: 'a@x.com' }], NextToken: 'p2' })
      .mockResolvedValueOnce({ EmailIdentities: [{ IdentityName: 'b@x.com' }] });
    const svc = new SesEmail(awsCreds);
    await expect(svc.listIdentities()).resolves.toEqual(['a@x.com', 'b@x.com']);
    expect(sesSendMock).toHaveBeenCalledTimes(2);
  });

  it('deleteIdentity deletes the identity', async () => {
    sesSendMock.mockResolvedValueOnce({});
    const svc = new SesEmail(awsCreds);
    await svc.deleteIdentity('a@x.com');
    expect(sesSendMock.mock.calls[0][0].input).toEqual({ EmailIdentity: 'a@x.com' });
  });

  it('wraps SDK failures as ProviderError', async () => {
    sesSendMock.mockRejectedValueOnce(new Error('boom'));
    const svc = new SesEmail(awsCreds);
    await expect(svc.sendEmail(baseOpts)).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects missing credentials', () => {
    expect(() => new SesEmail(undefined as never)).toThrow(InvalidCredentialsError);
  });
});

describe('AcsEmail (azure)', () => {
  beforeEach(() => {
    acsBeginSendMock.mockReset();
    AcsEmailClientCtor.mockClear();
  });

  it('builds the client from an endpoint;accesskey connection string', () => {
    new AcsEmail('https://acs.example.com', 'key123');
    expect(AcsEmailClientCtor).toHaveBeenCalledWith('endpoint=https://acs.example.com;accesskey=key123');
  });

  it('sendEmail maps recipients and content, returning the operation id', async () => {
    acsBeginSendMock.mockResolvedValueOnce({ pollUntilDone: () => Promise.resolve({ id: 'op-1' }) });
    const svc = new AcsEmail('https://acs.example.com', 'key123');
    const id = await svc.sendEmail({ ...baseOpts, cc: ['c@x.com'], htmlBody: '<p>hi</p>', body: 'text' });
    expect(id).toBe('op-1');
    expect(acsBeginSendMock).toHaveBeenCalledWith({
      senderAddress: 'a@x.com',
      recipients: { to: [{ address: 'b@x.com' }], cc: [{ address: 'c@x.com' }], bcc: [] },
      content: { subject: 'hi', html: '<p>hi</p>', plainText: 'text' },
      replyTo: [],
    });
  });

  it('rejects missing endpoint or key', () => {
    expect(() => new AcsEmail('', 'key')).toThrow(InvalidCredentialsError);
    expect(() => new AcsEmail('https://acs.example.com', '')).toThrow(InvalidCredentialsError);
  });

  it.each([
    ['sendRawEmail', (svc: InstanceType<typeof AcsEmail>) => svc.sendRawEmail(Buffer.from('x'), 'a@x.com')],
    ['verifyEmailIdentity', (svc: InstanceType<typeof AcsEmail>) => svc.verifyEmailIdentity('a@x.com')],
    ['listIdentities', (svc: InstanceType<typeof AcsEmail>) => svc.listIdentities()],
    ['deleteIdentity', (svc: InstanceType<typeof AcsEmail>) => svc.deleteIdentity('a@x.com')],
  ])('%s throws UnsupportedError', async (_name, call) => {
    const svc = new AcsEmail('https://acs.example.com', 'key123');
    await expect(call(svc)).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('GcpEmail (gcp)', () => {
  it.each([
    ['sendEmail', (svc: InstanceType<typeof GcpEmail>) => svc.sendEmail(baseOpts)],
    ['sendRawEmail', (svc: InstanceType<typeof GcpEmail>) => svc.sendRawEmail(Buffer.from('x'), 'a@x.com')],
    ['verifyEmailIdentity', (svc: InstanceType<typeof GcpEmail>) => svc.verifyEmailIdentity('a@x.com')],
    ['listIdentities', (svc: InstanceType<typeof GcpEmail>) => svc.listIdentities()],
    ['deleteIdentity', (svc: InstanceType<typeof GcpEmail>) => svc.deleteIdentity('a@x.com')],
  ])('%s throws UnsupportedError', async (_name, call) => {
    const svc = new GcpEmail();
    await expect(call(svc)).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('OciEmail (oci)', () => {
  beforeEach(() => {
    ociCreateSenderMock.mockReset();
    ociListSendersMock.mockReset();
    ociDeleteSenderMock.mockReset();
    ociSubmitEmailMock.mockReset();
  });

  it('sendEmail maps to EmailDPClient.submitEmail', async () => {
    ociSubmitEmailMock.mockResolvedValueOnce({
      opcRequestId: 'req-1',
      emailSubmittedResponse: { messageId: 'mid-1', envelopeId: 'env-1', suppressedRecipients: [] },
    });
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    const id = await svc.sendEmail({
      ...baseOpts,
      cc: ['c@x.com'],
      bcc: ['d@x.com'],
      body: 'text',
      htmlBody: '<p>hi</p>',
      replyTo: ['r@x.com'],
    });
    expect(id).toBe('mid-1');
    const details = ociSubmitEmailMock.mock.calls[0][0].submitEmailDetails;
    expect(details.sender).toEqual({ senderAddress: { email: 'a@x.com' }, compartmentId: 'ocid1.compartment.oc1..c' });
    expect(details.recipients).toEqual({
      to: [{ email: 'b@x.com' }],
      cc: [{ email: 'c@x.com' }],
      bcc: [{ email: 'd@x.com' }],
    });
    expect(details.subject).toBe('hi');
    expect(details.bodyText).toBe('text');
    expect(details.bodyHtml).toBe('<p>hi</p>');
    expect(details.replyTo).toEqual([{ email: 'r@x.com' }]);
  });

  it('sendEmail falls back to opcRequestId when no messageId is returned', async () => {
    ociSubmitEmailMock.mockResolvedValueOnce({ opcRequestId: 'req-2' });
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    await expect(svc.sendEmail(baseOpts)).resolves.toBe('req-2');
  });

  it('sendEmail wraps data-plane failures as ProviderError', async () => {
    ociSubmitEmailMock.mockRejectedValueOnce(new Error('boom'));
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    await expect(svc.sendEmail(baseOpts)).rejects.toBeInstanceOf(ProviderError);
  });

  it('sendRawEmail parses MIME headers, carries the text body, and submits via sendEmail', async () => {
    ociSubmitEmailMock.mockResolvedValueOnce({
      emailSubmittedResponse: { messageId: 'mid-raw', envelopeId: 'env', suppressedRecipients: [] },
    });
    const raw = Buffer.from(
      'Subject: Raw hello\r\nFrom: sender@x.com\r\nTo: b@x.com, "C C" <c@x.com>\r\nCc: d@x.com\r\nBcc: e@x.com\r\nReply-To: r@x.com\r\n\r\nbody text',
    );
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    const id = await svc.sendRawEmail(raw, 'override@x.com');
    expect(id).toBe('mid-raw');
    const details = ociSubmitEmailMock.mock.calls[0][0].submitEmailDetails;
    expect(details.sender.senderAddress.email).toBe('override@x.com');
    expect(details.recipients.to).toEqual([{ email: 'b@x.com' }, { email: 'c@x.com' }]);
    expect(details.recipients.cc).toEqual([{ email: 'd@x.com' }]);
    expect(details.recipients.bcc).toEqual([{ email: 'e@x.com' }]);
    expect(details.replyTo).toEqual([{ email: 'r@x.com' }]);
    expect(details.subject).toBe('Raw hello');
    expect(details.bodyText).toBe('body text');
    expect(details.bodyHtml).toBeUndefined();
  });

  it('sendRawEmail carries the body as HTML when Content-Type is text/html', async () => {
    ociSubmitEmailMock.mockResolvedValueOnce({
      emailSubmittedResponse: { messageId: 'mid-raw-html', envelopeId: 'env', suppressedRecipients: [] },
    });
    const raw = Buffer.from(
      'Subject: Raw hello\r\nFrom: sender@x.com\r\nTo: b@x.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>hi</p>',
    );
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    const id = await svc.sendRawEmail(raw, 'override@x.com');
    expect(id).toBe('mid-raw-html');
    const details = ociSubmitEmailMock.mock.calls[0][0].submitEmailDetails;
    expect(details.bodyHtml).toBe('<p>hi</p>');
    expect(details.bodyText).toBeUndefined();
  });

  it('sendRawEmail falls back to the raw From header when from is empty', async () => {
    ociSubmitEmailMock.mockResolvedValueOnce({
      emailSubmittedResponse: { messageId: 'mid-raw-2', envelopeId: 'env', suppressedRecipients: [] },
    });
    const raw = Buffer.from('Subject: hi\r\nFrom: sender@x.com\r\nTo: b@x.com\r\n\r\nbody');
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    await svc.sendRawEmail(raw, '');
    expect(ociSubmitEmailMock.mock.calls[0][0].submitEmailDetails.sender.senderAddress.email).toBe('sender@x.com');
  });

  it('verifyEmailIdentity creates a sender', async () => {
    ociCreateSenderMock.mockResolvedValueOnce({ sender: { id: 's1' } });
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    await svc.verifyEmailIdentity('a@x.com');
    expect(ociCreateSenderMock).toHaveBeenCalledWith({
      createSenderDetails: { compartmentId: 'ocid1.compartment.oc1..c', emailAddress: 'a@x.com' },
    });
  });

  it('listIdentities pages through senders', async () => {
    ociListSendersMock
      .mockResolvedValueOnce({ items: [{ emailAddress: 'a@x.com', id: 's1' }], opcNextPage: 'p2' })
      .mockResolvedValueOnce({ items: [{ emailAddress: 'b@x.com', id: 's2' }] });
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    await expect(svc.listIdentities()).resolves.toEqual(['a@x.com', 'b@x.com']);
    expect(ociListSendersMock).toHaveBeenCalledTimes(2);
  });

  it('deleteIdentity deletes the matching sender by id', async () => {
    ociListSendersMock.mockResolvedValueOnce({ items: [{ emailAddress: 'a@x.com', id: 's1' }] });
    ociDeleteSenderMock.mockResolvedValueOnce({});
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    await svc.deleteIdentity('a@x.com');
    expect(ociDeleteSenderMock).toHaveBeenCalledWith({ senderId: 's1' });
  });

  it('deleteIdentity throws NotFoundError when no sender matches', async () => {
    ociListSendersMock.mockResolvedValueOnce({ items: [] });
    const svc = new OciEmail(ociCreds, 'ocid1.compartment.oc1..c');
    await expect(svc.deleteIdentity('missing@x.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects missing credentials', () => {
    expect(() => new OciEmail(undefined as never, 'c')).toThrow(InvalidCredentialsError);
  });
});
