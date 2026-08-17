import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mountRuntimeActivityEndpoints,
  RuntimeActivityHub,
} from '../../src/server/runtime-activity.js';

describe('runtime activity reconnect replay', () => {
  let server: http.Server | undefined;
  let hub: RuntimeActivityHub | undefined;

  afterEach(async () => {
    hub?.dispose();
    server?.closeAllConnections();
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  it('replays only events newer than Last-Event-ID', async () => {
    const app = express();
    app.use(express.json());
    hub = new RuntimeActivityHub();
    mountRuntimeActivityEndpoints(
      app,
      async () => ({ path: 'C:/repo' }),
      hub,
      (_req, _res, next) => next(),
    );
    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    hub.publish(
      'C:/repo',
      [1, 2, 3].map((pid) => ({ runtime: 'node', kind: 'function', pid })),
    );
    const { port } = server.address() as AddressInfo;

    const replay = await new Promise<string>((resolve, reject) => {
      const request = http.get(
        `http://127.0.0.1:${port}/api/runtime/events?repo=fixture`,
        { headers: { 'Last-Event-ID': '2' } },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
            if (body.includes('id: 3')) {
              resolve(body);
              request.destroy();
            }
          });
          response.on('error', reject);
        },
      );
      request.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
    });

    expect(replay).toContain('id: 3');
    expect(replay).not.toContain('id: 1');
    expect(replay).not.toContain('id: 2');
  });
});
