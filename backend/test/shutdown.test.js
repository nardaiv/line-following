import test from 'node:test';
import assert from 'node:assert/strict';

import { shutdownRuntime } from '../src/shutdown.js';

test('database remains open until HTTP requests have drained', async () => {
  const order = [];
  let closeServerCallback;
  let databaseClosed = false;
  const shutdown = shutdownRuntime({
    server: {
      close(callback) {
        order.push('http-close-started');
        closeServerCallback = callback;
      },
    },
    eventHub: { close: () => order.push('sse-closed') },
    mqttBridge: { close: async () => order.push('mqtt-closed') },
    database: { close: () => { databaseClosed = true; order.push('database-closed'); } },
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(databaseClosed, false);
  assert.ok(order.includes('http-close-started'));
  assert.ok(order.includes('sse-closed'));
  assert.ok(order.includes('mqtt-closed'));

  closeServerCallback();
  await shutdown;
  assert.equal(databaseClosed, true);
  assert.ok(order.indexOf('database-closed') > order.indexOf('http-close-started'));
});
