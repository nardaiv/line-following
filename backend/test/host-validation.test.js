import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { EventHub } from '../src/event-hub.js';

test('HTTP endpoints reject untrusted Host headers and accept loopback hosts', async () => {
  const database = createDatabase(':memory:');
  const eventHub = new EventHub();
  const app = createApp({
    config: {
      robotIds: ['linebot-01'],
      allowedOrigins: ['http://localhost:5173'],
      httpHost: '127.0.0.1',
      httpPort: 3000,
    },
    database,
    eventHub,
    mqttBridge: { metrics: { connected: false }, publishPidCommand: async () => {} },
  });
  try {
    const hostile = await app.request('/health', {
      headers: { host: 'rebind.attacker.example:3000' },
    });
    assert.equal(hostile.status, 400);

    const safe = await app.request('/health', {
      headers: { host: '127.0.0.1:3000' },
    });
    assert.equal(safe.status, 200);
  } finally {
    eventHub.close();
    database.close();
  }
});
