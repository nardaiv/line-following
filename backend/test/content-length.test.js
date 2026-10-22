import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { EventHub } from '../src/event-hub.js';

const token = 'a'.repeat(40);
const body = JSON.stringify({ kp: 12.5, ki: 1, kd: 0.15 });

test('PID endpoint accepts a valid numeric Content-Length', async () => {
  const database = createDatabase(':memory:');
  const eventHub = new EventHub();
  database.upsertPidState({
    robotId: 'linebot-01', kp: 12.5, ki: 1, kd: 0.15, revision: 0,
    requestId: null, persisted: true, receivedAt: new Date().toISOString(),
  });
  const app = createApp({
    config: {
      robotIds: ['linebot-01'],
      adminToken: token,
      allowedOrigins: ['http://localhost:5173'],
    },
    database,
    eventHub,
    mqttBridge: {
      metrics: { connected: true },
      publishPidCommand: async () => {},
    },
  });
  try {
    const response = await app.request('/api/robots/linebot-01/pid', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        host: '127.0.0.1:3000',
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(response.status, 202);
  } finally {
    eventHub.close();
    database.close();
  }
});
