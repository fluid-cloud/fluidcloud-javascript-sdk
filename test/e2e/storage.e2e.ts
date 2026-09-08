import { afterAll, describe, it } from 'vitest';

import type { Client } from '../../src/index.js';
import { clientFor, env, PROVIDERS, type ProviderName, skipReason, uniqueName } from './env.js';
import { recordSkip, runFn } from './reporter.js';

const CATEGORY = 'Storage';
const clients = new Map<ProviderName, Client>();

afterAll(async () => {
  for (const client of clients.values()) await client.close();
});

describe.each(PROVIDERS)('storage on %s', (provider) => {
  it('exercises the storage surface', async () => {
    const reason = skipReason(provider);
    const bucket = env.buckets[provider];

    if (reason || !bucket) {
      for (const fn of FUNCTIONS) {
        recordSkip(CATEGORY, fn, provider, reason ?? `no test bucket for ${provider}`);
      }
      return;
    }

    const client = await clientFor(provider);
    clients.set(provider, client);

    if (!client.hasStorage) {
      for (const fn of FUNCTIONS) recordSkip(CATEGORY, fn, provider, 'storage not configured');
      return;
    }

    const storage = client.storage;
    const key = `fluidcloud-e2e/${uniqueName('obj')}.txt`;
    const body = Buffer.from('fluidcloud js sdk e2e');

    await runFn(CATEGORY, 'put', provider, async () => {
      await storage.put(bucket, key, body, { contentType: 'text/plain' });
    });

    await runFn(CATEGORY, 'get', provider, async () => {
      const got = await storage.get(bucket, key);
      if (!got.equals(body)) throw new Error(`round trip mismatch: got ${got.toString()}`);
    });

    await runFn(CATEGORY, 'head', provider, async () => {
      const head = await storage.head(bucket, key);
      if (head.size !== body.length) throw new Error(`size ${head.size} != ${body.length}`);
    });

    await runFn(CATEGORY, 'exists', provider, async () => {
      if (!(await storage.exists(bucket, key))) throw new Error('exists returned false for a written object');
      if (await storage.exists(bucket, `${key}.missing`)) throw new Error('exists returned true for a missing object');
    });

    await runFn(CATEGORY, 'getRange', provider, async () => {
      const head = await storage.getRange(bucket, key, 0, 10);
      if (!head.equals(body.subarray(0, 10))) throw new Error('range mismatch');
    });

    await runFn(CATEGORY, 'getStream', provider, async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.getStream(bucket, key)) chunks.push(Buffer.from(chunk));
      if (!Buffer.concat(chunks).equals(body)) throw new Error('stream mismatch');
    });

    await runFn(CATEGORY, 'list', provider, async () => {
      const found = await storage.list(bucket, { prefix: 'fluidcloud-e2e/', maxKeys: 100 });
      if (!found.some((o) => o.key === key)) throw new Error('written object missing from list');
    });

    await runFn(CATEGORY, 'listAll', provider, async () => {
      await storage.listAll(bucket, { prefix: 'fluidcloud-e2e/' });
    });

    await runFn(CATEGORY, 'setMetadata', provider, async () => {
      await storage.setMetadata(bucket, key, { owner: 'e2e' });
    });

    await runFn(CATEGORY, 'getMetadata', provider, async () => {
      const meta = await storage.getMetadata(bucket, key);
      if (meta.owner !== 'e2e') throw new Error(`metadata mismatch: ${JSON.stringify(meta)}`);
    });

    if (storage.supports('set_tags')) {
      await runFn(CATEGORY, 'setTags', provider, async () => {
        await storage.setTags(bucket, key, { env: 'test' });
      });
      await runFn(CATEGORY, 'getTags', provider, async () => {
        const tags = await storage.getTags(bucket, key);
        if (tags.env !== 'test') throw new Error(`tag mismatch: ${JSON.stringify(tags)}`);
      });
      await runFn(CATEGORY, 'deleteTags', provider, async () => {
        await storage.deleteTags(bucket, key);
      });
    } else {
      for (const fn of ['setTags', 'getTags', 'deleteTags']) {
        recordSkip(CATEGORY, fn, provider, 'unsupported on this provider');
      }
    }

    const copyKey = `${key}.copy`;
    await runFn(CATEGORY, 'copy', provider, async () => {
      await storage.copy(bucket, key, bucket, copyKey);
    });

    const moveKey = `${key}.moved`;
    await runFn(CATEGORY, 'move', provider, async () => {
      await storage.move(bucket, copyKey, bucket, moveKey);
    });

    await runFn(CATEGORY, 'presignGet', provider, async () => {
      const url = await storage.presignGet(bucket, key, 900);
      if (!url.startsWith('http')) throw new Error(`bad presigned URL: ${url}`);
    });

    await runFn(CATEGORY, 'presignPut', provider, async () => {
      const url = await storage.presignPut(bucket, `${key}.upload`, 900);
      if (!url.startsWith('http')) throw new Error(`bad presigned URL: ${url}`);
    });

    await runFn(CATEGORY, 'bucketExists', provider, async () => {
      if (!(await storage.bucketExists(bucket))) throw new Error('bucketExists returned false for the test bucket');
    });

    await runFn(CATEGORY, 'listBuckets', provider, async () => {
      await storage.listBuckets();
    });

    await runFn(CATEGORY, 'deleteBulk', provider, async () => {
      const failures = await storage.deleteBulk(bucket, [moveKey]);
      if (failures.length > 0) throw new Error(`bulk delete reported ${JSON.stringify(failures)}`);
    });

    await runFn(CATEGORY, 'delete', provider, async () => {
      await storage.delete(bucket, key);
      if (await storage.exists(bucket, key)) throw new Error('object still present after delete');
    });
  });
});

const FUNCTIONS = [
  'put',
  'get',
  'head',
  'exists',
  'getRange',
  'getStream',
  'list',
  'listAll',
  'setMetadata',
  'getMetadata',
  'setTags',
  'getTags',
  'deleteTags',
  'copy',
  'move',
  'presignGet',
  'presignPut',
  'bucketExists',
  'listBuckets',
  'deleteBulk',
  'delete',
];
