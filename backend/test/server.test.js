import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect as netConnect } from 'node:net';
import { request as httpRequest } from 'node:http';

import { serve } from '@hono/node-server';

import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { EventHub } from '../src/event-hub.js';
import { shutdownRuntime } from '../src/shutdown.js';

function getStatusWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port, path: '/health', headers: { host },
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

function getStatusWithoutHost(port) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1');
    let response = '';
    socket.once('connect', () => socket.write(
      `GET /health HTTP/1.0${String.fromCharCode(13, 10, 13, 10)}`,
    ));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.once('end', () => {
      const match = /^HTTP\/1\.\d (\d{3})/m.exec(response);
      if (match) resolve(Number(match[1]));
      else reject(new Error(`Invalid HTTP response: ${response}`));
    });
    socket.once('error', reject);
  });
}

test('Node HTTP adapter serves health and drains before database shutdown', async () => {
  const database = createDatabase(':memory:');
  const eventHub = new EventHub();
  let releaseRequest;
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const gate = new Promise(resolve => { releaseRequest = resolve; });
  const mqttBridge = {
    metrics: { connected: false },
    close: async () => {},
    publishPidCommand: async () => {},
  };
  const app = createApp({
    config: {
      robotIds: ['linebot-01'],
      adminToken: 'x'.repeat(40),
      allowedOrigins: ['http://localhost:5173'],
    },
    database,
    mqttBridge,
    eventHub,
  });
  app.get('/slow-test', async c => {
    requestStarted();
    await gate;
    return c.json({ databaseOpen: database.raw.open });
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).databaseOpen, true);
    assert.equal(await getStatusWithHost(port, 'rebind.attacker.example:3000'), 400);
    assert.equal(await getStatusWithHost(port, 'localhost:3000'), 200);
    assert.equal(await getStatusWithHost(port, '127.0.0.2:3000'), 200);
    assert.equal(await getStatusWithHost(port, '[::1]:3000'), 200);
    assert.equal(await getStatusWithoutHost(port), 400);

    const pendingResponse = fetch(`http://127.0.0.1:${port}/slow-test`);
    await started;
    const shutdown = shutdownRuntime({ server, eventHub, mqttBridge, database });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(database.raw.open, true);
    releaseRequest();
    const response = await pendingResponse;
    assert.equal((await response.json()).databaseOpen, true);
    await shutdown;
    assert.equal(database.raw.open, false);
  } finally {
    releaseRequest();
    if (database.raw.open) {
      await new Promise(resolve => server.close(resolve));
      eventHub.close();
      database.close();
    }
  }
});
