import { describe, expect, it } from 'vitest';

import { DEFAULT_SERVER_URL, validateConfig } from '../src/config.js';
import { ValidationError } from '../src/errors.js';

describe('validateConfig', () => {
  it.each([
    ['missing apiKey', { apiKey: '', entityId: 'e-1' }, 'apiKey'],
    ['missing entityId', { apiKey: 'fc_k_s', entityId: '' }, 'entityId'],
  ])('rejects %s', (_name, cfg, field) => {
    expect(() => validateConfig(cfg)).toThrow(ValidationError);
    try {
      validateConfig(cfg);
    } catch (err) {
      expect((err as ValidationError).field).toBe(field);
    }
  });

  it.each([
    ['defaults the server URL when absent', undefined, DEFAULT_SERVER_URL],
    ['defaults the server URL when empty', '', DEFAULT_SERVER_URL],
    ['keeps an explicit server URL', 'https://fc.internal', 'https://fc.internal'],
  ])('%s', (_name, serverUrl, expected) => {
    const resolved = validateConfig({ apiKey: 'fc_k_s', entityId: 'e-1', serverUrl });
    expect(resolved.serverUrl).toBe(expected);
  });

  it('passes region through untouched', () => {
    expect(validateConfig({ apiKey: 'k', entityId: 'e', region: 'ap-south-1' }).region).toBe('ap-south-1');
  });
});
