import { describe, expect, it } from 'vitest';

import {
  AccessDeniedError,
  ErrorCode,
  FluidCloudError,
  hasCode,
  isAccessDenied,
  isNotFound,
  isUnsupported,
  messageOf,
  NotFoundError,
  ProviderError,
  UnsupportedError,
  ValidationError,
  wrapProviderError,
} from '../src/errors.js';

describe('error taxonomy', () => {
  it.each([
    ['NotFoundError', new NotFoundError(), ErrorCode.NotFound],
    ['AccessDeniedError', new AccessDeniedError(), ErrorCode.AccessDenied],
    ['UnsupportedError', new UnsupportedError('gcp', 'getTags', 'no object tags.'), ErrorCode.OperationNotSupported],
    ['ValidationError', new ValidationError('apiKey', 'is required'), ErrorCode.Validation],
    ['ProviderError', new ProviderError('aws', 'get', new Error('boom')), ErrorCode.Provider],
  ])('%s carries its code and is a FluidCloudError', (_name, err, code) => {
    expect(err).toBeInstanceOf(FluidCloudError);
    expect(err.code).toBe(code);
    expect(err.name).toBe(err.constructor.name);
  });

  it('formats a provider error with provider, operation and cause', () => {
    const err = new ProviderError('azure', 'presignGet', new Error('no key'));
    expect(err.message).toBe('azure: presignGet failed: no key');
    expect(err.provider).toBe('azure');
    expect(err.operation).toBe('presignGet');
  });

  it.each([
    [
      'without an alternative',
      '',
      'gcp: multipartCreate is not supported on this provider. GCS has no S3-style multipart.',
    ],
    [
      'with an alternative',
      'use upload()',
      'gcp: multipartCreate is not supported on this provider. GCS has no S3-style multipart. Recommended alternative: use upload()',
    ],
  ])('formats an unsupported error %s', (_name, alternative, expected) => {
    expect(new UnsupportedError('gcp', 'multipartCreate', 'GCS has no S3-style multipart.', alternative).message).toBe(
      expected,
    );
  });

  it('finds a code through the cause chain', () => {
    const wrapped = new ProviderError('aws', 'get', new NotFoundError());
    expect(hasCode(wrapped, ErrorCode.NotFound)).toBe(true);
    expect(isNotFound(wrapped)).toBe(true);
    expect(isAccessDenied(wrapped)).toBe(false);
  });

  it.each([
    ['not found', new NotFoundError(), isNotFound],
    ['access denied', new AccessDeniedError(), isAccessDenied],
    ['unsupported', new UnsupportedError('oci', 'createDistribution', 'no CDN.'), isUnsupported],
  ])('classifies %s', (_name, err, predicate) => {
    expect(predicate(err)).toBe(true);
  });

  it('survives a self-referencing cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = a;
    expect(hasCode(a, ErrorCode.NotFound)).toBe(false);
  });

  it('wraps an unknown throw but passes typed errors through unchanged', () => {
    const unsupported = new UnsupportedError('oci', 'x', 'no.');
    expect(() => wrapProviderError('oci', 'x', unsupported)).toThrow(unsupported);
    expect(() => wrapProviderError('aws', 'get', 'plain string')).toThrow(ProviderError);
  });

  it.each([
    ['an Error', new Error('boom'), 'boom'],
    ['a string', 'boom', 'boom'],
    ['a number', 42, '42'],
  ])('reads a message from %s', (_name, value, expected) => {
    expect(messageOf(value)).toBe(expected);
  });
});
