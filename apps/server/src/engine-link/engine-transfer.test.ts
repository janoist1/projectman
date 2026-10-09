import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256, startFakeCloud } from '../../test/helpers/fake-cloud';
import type { FakeCloud } from '../../test/helpers/fake-cloud';
import { createEngineTransfers } from './engine-transfer';

describe('engine file transfers', () => {
  let cloud: FakeCloud;
  let dir: string;
  const transfers = () =>
    createEngineTransfers({
      cloudUrl: cloud.url,
      headers: () => ({ authorization: 'Bearer machine-key', 'x-extra': 'yes' }),
    });
  const token = 'tok_0123456789abcdef';

  beforeEach(async () => {
    cloud = await startFakeCloud();
    dir = mkdtempSync(path.join(os.tmpdir(), 'engine-transfer-'));
  });
  afterEach(async () => {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('upload', () => {
    it('streams the bytes with the key, and gives a receipt computed over what was sent', async () => {
      const body = Buffer.from('hello transcript\n'.repeat(1000));
      const receipt = await transfers().upload(token, 'transcript', {
        size: body.length,
        stream: () => Readable.from([body]),
      });
      expect(receipt).toEqual({ sha256: sha256(body), size: body.length });
      const sent = cloud.uploads.get(token)!;
      expect(sent.body.equals(body)).toBe(true);
      expect(sent.contentLength).toBe(body.length);
      expect(sent.authorization).toBe('Bearer machine-key');
    });

    it('refuses a result larger than the cloud accepts for that purpose, before it connects', async () => {
      await expect(
        transfers().upload(token, 'file', {
          size: 1024 * 1024 * 1024 * 1024,
          stream: () => Readable.from([]),
        }),
      ).rejects.toMatchObject({ code: 'result_too_large' });
      expect(cloud.uploads.size).toBe(0);
    });

    it('fails when the stream is longer than announced', async () => {
      await expect(
        transfers().upload(token, 'file', {
          size: 4,
          stream: () => Readable.from([Buffer.from('too long')]),
        }),
      ).rejects.toBeDefined();
    });

    it('fails when the stream errors, without crashing the process', async () => {
      const failing = () =>
        new Readable({
          read() {
            this.destroy(new Error('disk error'));
          },
        });
      await expect(transfers().upload(token, 'file', { size: 10, stream: failing })).rejects.toBeDefined();
    });

    it('reports a cloud that cannot be reached as link_down', async () => {
      await cloud.close();
      await expect(
        transfers().upload(token, 'file', { size: 1, stream: () => Readable.from([Buffer.from('x')]) }),
      ).rejects.toMatchObject({ code: 'link_down' });
    });
  });

  describe('download', () => {
    const body = Buffer.from('attachment content');
    const dest = () => path.join(dir, 'cache', 'file.bin');

    it('stores the file only when the size and checksum match, privately', async () => {
      cloud.downloads.set(token, body);
      await transfers().download(token, dest(), { size: body.length, sha256: sha256(body) });
      expect(readFileSync(dest())).toEqual(body);
      expect(statSync(dest()).mode & 0o777).toBe(0o600);
      expect(readdirSync(path.dirname(dest()))).toEqual(['file.bin']);
    });

    it('leaves nothing behind when the checksum or the size is wrong', async () => {
      cloud.downloads.set(token, body);
      await expect(
        transfers().download(token, dest(), { size: body.length, sha256: sha256('other') }),
      ).rejects.toMatchObject({
        code: 'internal',
      });
      await expect(
        transfers().download(token, dest(), { size: body.length - 1, sha256: sha256(body) }),
      ).rejects.toMatchObject({
        code: 'internal',
      });
      expect(readdirSync(path.dirname(dest()))).toEqual([]);
    });

    it('does not replace a file already there when the download fails', async () => {
      cloud.downloads.set(token, body);
      await transfers().download(token, dest(), { size: body.length, sha256: sha256(body) });
      writeFileSync(`${dest()}.keep`, 'x');
      await expect(
        transfers().download(token, dest(), { size: 3, sha256: sha256('abc') }),
      ).rejects.toBeDefined();
      expect(readFileSync(dest())).toEqual(body);
    });

    it('fails for a token the cloud does not know', async () => {
      await expect(
        transfers().download('tok_unknown00000000', dest(), { size: 1, sha256: sha256('x') }),
      ).rejects.toMatchObject({
        code: 'internal',
      });
    });
  });

  describe('redirects', () => {
    // The headers hold the link's service token: a redirect to another address must not carry them there.
    let elsewhere: Server;
    let elsewhereRequests: Array<Record<string, string | string[] | undefined>>;
    let redirecting: Server;

    const listen = (server: Server) =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
      );
    const redirectingTransfers = async () => {
      elsewhere = createServer((request, response) => {
        elsewhereRequests.push({ ...request.headers });
        request.resume();
        response.writeHead(200).end('ok');
      });
      const elsewherePort = await listen(elsewhere);
      redirecting = createServer((request, response) => {
        request.resume();
        response.writeHead(307, { location: `http://127.0.0.1:${elsewherePort}/stolen` }).end();
      });
      const port = await listen(redirecting);
      return createEngineTransfers({
        cloudUrl: `http://127.0.0.1:${port}`,
        headers: () => ({ authorization: 'Bearer machine-key', 'cf-access-client-secret': 'service-secret' }),
      });
    };

    beforeEach(() => {
      elsewhereRequests = [];
    });
    afterEach(async () => {
      await Promise.all(
        [elsewhere, redirecting].map(
          (server) => new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined))),
        ),
      );
    });

    it('does not follow a redirect of an upload, so the extra headers stay with the cloud', async () => {
      const body = Buffer.from('content');
      await expect(
        (await redirectingTransfers()).upload(token, 'file', {
          size: body.length,
          stream: () => Readable.from([body]),
        }),
      ).rejects.toBeDefined();
      expect(elsewhereRequests).toEqual([]);
    });

    it('does not follow a redirect of a download', async () => {
      await expect(
        (await redirectingTransfers()).download(token, path.join(dir, 'file'), {
          size: 1,
          sha256: sha256('x'),
        }),
      ).rejects.toMatchObject({ code: 'link_down' });
      expect(elsewhereRequests).toEqual([]);
    });
  });
});
