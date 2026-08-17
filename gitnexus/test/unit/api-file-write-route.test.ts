import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import {
  handleFileWriteRequest,
  resolveFileWritePolicy,
  shaOfContent,
  MAX_WRITE_BYTES,
} from '../../src/server/api.js';

/**
 * The write route is the highest-risk surface in the Code Inspector feature.
 * These tests pin every guard: containment, symlink rejection, existing-files
 * only, size cap, optimistic concurrency, and the configuration gate.
 */

interface MockRes {
  statusCode: number;
  body: any;
  status: (code: number) => { json: (body: any) => void };
  json: (body: any) => void;
}

const mockRes = (): MockRes => {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return {
        json(body: any) {
          res.body = body;
        },
      };
    },
    json(body: any) {
      res.body = body;
    },
  };
  return res;
};

let repoRoot: string;
const ORIGINAL = 'const a = 1;\n';

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-write-'));
  await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'src', 'a.ts'), ORIGINAL, 'utf-8');
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

const write = async (body: any, allowWrites = true) => {
  const res = mockRes();
  await handleFileWriteRequest({ body } as any, res as any, repoRoot, { allowWrites });
  return res;
};

describe('handleFileWriteRequest', () => {
  it('writes the file and returns the new sha', async () => {
    const res = await write({
      path: 'src/a.ts',
      content: 'const a = 2;\n',
      expectedSha: shaOfContent(ORIGINAL),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sha: shaOfContent('const a = 2;\n') });
    expect(await fs.readFile(path.join(repoRoot, 'src', 'a.ts'), 'utf-8')).toBe('const a = 2;\n');
  });

  it('leaves no temporary file behind after a successful write', async () => {
    await write({
      path: 'src/a.ts',
      content: 'next',
      expectedSha: shaOfContent(ORIGINAL),
    });

    const entries = await fs.readdir(path.join(repoRoot, 'src'));
    expect(entries.filter((e) => e.includes('.tmp'))).toHaveLength(0);
    expect(entries).toContain('a.ts');
  });

  it('rejects a path escaping the repository root', async () => {
    const res = await write({
      path: '../escaped.ts',
      content: 'x',
      expectedSha: 'whatever',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/traversal/i);
  });

  it('rejects an absolute path outside the repository', async () => {
    const outside = path.join(os.tmpdir(), 'gitnexus-outside-target.ts');
    const res = await write({ path: outside, content: 'x', expectedSha: 'whatever' });

    expect(res.statusCode).toBe(403);
  });

  it('rejects a file that does not already exist, so it cannot create files', async () => {
    const res = await write({
      path: 'src/brand-new.ts',
      content: 'x',
      expectedSha: shaOfContent(''),
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects a symlink, which could redirect the write outside the repo', async () => {
    const target = path.join(os.tmpdir(), 'gitnexus-symlink-target.txt');
    await fs.writeFile(target, 'outside', 'utf-8');
    const linkPath = path.join(repoRoot, 'src', 'link.ts');
    try {
      await fs.symlink(target, linkPath);
    } catch {
      // Windows without developer mode cannot create symlinks; the guard is
      // still exercised by the other cases.
      return;
    }

    const res = await write({
      path: 'src/link.ts',
      content: 'x',
      expectedSha: shaOfContent('outside'),
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/non-regular/i);
    expect(await fs.readFile(target, 'utf-8')).toBe('outside');
  });

  it('rejects a body over the size cap', async () => {
    const res = await write({
      path: 'src/a.ts',
      content: 'x'.repeat(MAX_WRITE_BYTES + 1),
      expectedSha: shaOfContent(ORIGINAL),
    });

    expect(res.statusCode).toBe(413);
  });

  it('returns 409 when the file changed on disk since it was read', async () => {
    const res = await write({
      path: 'src/a.ts',
      content: 'clobber',
      expectedSha: shaOfContent('something the client read earlier'),
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/changed on disk/i);
    // The original content survives — a stale save must never overwrite.
    expect(await fs.readFile(path.join(repoRoot, 'src', 'a.ts'), 'utf-8')).toBe(ORIGINAL);
  });

  it('requires path, content, and expectedSha', async () => {
    expect((await write({ content: 'x', expectedSha: 'y' })).statusCode).toBe(400);
    expect((await write({ path: 'src/a.ts', expectedSha: 'y' })).statusCode).toBe(400);
    expect((await write({ path: 'src/a.ts', content: 'x' })).statusCode).toBe(400);
  });

  it('rejects every write when the server has writes disabled', async () => {
    const res = await write(
      { path: 'src/a.ts', content: 'x', expectedSha: shaOfContent(ORIGINAL) },
      false,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/--allow-file-writes/);
    expect(await fs.readFile(path.join(repoRoot, 'src', 'a.ts'), 'utf-8')).toBe(ORIGINAL);
  });
});

describe('resolveFileWritePolicy', () => {
  it('enables writes for loopback-bound servers', () => {
    expect(resolveFileWritePolicy('127.0.0.1')).toBe(true);
    expect(resolveFileWritePolicy('localhost')).toBe(true);
    expect(resolveFileWritePolicy('::1')).toBe(true);
  });

  it('disables writes when bound to a network-reachable address', () => {
    expect(resolveFileWritePolicy('0.0.0.0')).toBe(false);
    expect(resolveFileWritePolicy('192.168.1.10')).toBe(false);
  });

  it('honours an explicit environment override in both directions', () => {
    expect(resolveFileWritePolicy('0.0.0.0', '1')).toBe(true);
    expect(resolveFileWritePolicy('127.0.0.1', '0')).toBe(false);
  });

  it('ignores an unrecognized override value', () => {
    expect(resolveFileWritePolicy('127.0.0.1', 'yes')).toBe(true);
    expect(resolveFileWritePolicy('0.0.0.0', 'yes')).toBe(false);
  });
});
