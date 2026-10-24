import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { EventHub } from '../src/event-hub.js';

const config = {
  robotIds: ['linebot-01', 'linebot-02'],
  allowedOrigins: ['http://localhost:5173'],
};

function createHarness() {
  const database = createDatabase(':memory:');
  const eventHub = new EventHub();
  const sent = [];
  const mqttBridge = {
    metrics: { connected: true },
    publishPidCommand: async (robotId, payload) => sent.push({ robotId, payload }),
  };
  const app = createApp({ config, database, mqttBridge, eventHub });
  const request = app.request.bind(app);
  app.request = (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('host')) headers.set('host', '127.0.0.1:3000');
    return request(input, { ...init, headers });
  };
  return { app, database, eventHub, mqttBridge, sent };
}

test('PID writes require an allowed origin but no admin bearer token', async () => {
  const h = createHarness();
  try {
    h.database.upsertPidState({
      robotId: 'linebot-01', kp: 12.5, ki: 1, kd: 0.15, revision: 4,
      requestId: null, persisted: true, receivedAt: new Date().toISOString(),
    });
    const body = JSON.stringify({ kp: 10, ki: 1, kd: 0.1 });
    const missingOrigin = await h.app.request('/api/robots/linebot-01/pid', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(missingOrigin.status, 403);
    const deniedOrigin = await h.app.request('/api/robots/linebot-01/pid', {
      method: 'POST',
      headers: {
        origin: 'https://untrusted.example',
        'content-type': 'application/json',
      },
      body,
    });
    assert.equal(deniedOrigin.status, 403);
    assert.equal(h.sent.length, 0);

    const acceptedWithoutToken = await h.app.request('/api/robots/linebot-01/pid', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      body,
    });
    assert.equal(acceptedWithoutToken.status, 202);
    assert.equal(h.sent.length, 1);

    const oversized = await h.app.request('/api/robots/linebot-01/pid', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kp: 10, ki: 1, kd: 0.1, padding: 'x'.repeat(2048) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    h.eventHub.close();
    h.database.close();
  }
});

test('PID POST publishes an unretained-revision command and returns pending', async () => {
  const h = createHarness();
  try {
    h.database.upsertPidState({
      robotId: 'linebot-01', kp: 12.5, ki: 1, kd: 0.15, revision: 4,
      requestId: null, persisted: true, receivedAt: new Date().toISOString(),
    });
    const response = await h.app.request('/api/robots/linebot-01/pid', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kp: 10, ki: 1, kd: 0.1 }),
    });
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.status, 'pending');
    assert.equal(result.baseRevision, 4);
    assert.match(result.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].robotId, 'linebot-01');
    assert.deepEqual(h.sent[0].payload, {
      v: 1, requestId: result.requestId, baseRevision: 4, kp: 10, ki: 1, kd: 0.1,
    });
    assert.equal(h.database.pidCommands('linebot-01')[0].status, 'pending');
  } finally {
    h.eventHub.close();
    h.database.close();
  }
});

test('SSE streams are isolated to their requested robot', async () => {
  const h = createHarness();
  let readerOne;
  let readerTwo;
  try {
    const first = await h.app.request('/api/robots/linebot-01/events');
    const second = await h.app.request('/api/robots/linebot-02/events');
    readerOne = first.body.getReader();
    readerTwo = second.body.getReader();
    await readerOne.read();
    await readerTwo.read();

    h.eventHub.publish('telemetry', { robotId: 'linebot-01', seq: 1 });
    assert.match(new TextDecoder().decode((await readerOne.read()).value), /linebot-01/);
    const leaked = await Promise.race([
      readerTwo.read().then(() => 'delivered'),
      new Promise(resolve => setTimeout(() => resolve('not-delivered'), 40)),
    ]);
    assert.equal(leaked, 'not-delivered');
    await readerTwo.cancel();

    const secondAgain = await h.app.request('/api/robots/linebot-02/events');
    readerTwo = secondAgain.body.getReader();
    await readerTwo.read();
    h.eventHub.publish('telemetry', { robotId: 'linebot-02', seq: 2 });
    assert.match(new TextDecoder().decode((await readerTwo.read()).value), /linebot-02/);
  } finally {
    await readerOne?.cancel();
    await readerTwo?.cancel();
    h.eventHub.close();
    h.database.close();
  }
});

test('SSE endpoint streams live events and latest endpoint is bounded', async () => {
  const h = createHarness();
  try {
    h.database.insertTelemetry({
      robotId: 'linebot-01', bootId: 'boot-a', seq: 1,
      receivedAt: new Date().toISOString(), uptimeMs: 10, mask: 4,
      position: 2, error: 0, correction: 0, leftPwm: 75, rightPwm: 75,
      mode: 'track', dtMs: 10, pidRevision: 0,
      droppedFrames: 0, droppedAcks: 0, droppedEvents: 0,
    });
    const latest = await h.app.request('/api/robots/linebot-01/latest');
    assert.equal((await latest.json()).telemetry.seq, 1);

    const sse = await h.app.request('/api/robots/linebot-01/events');
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    const reader = sse.body.getReader();
    const initial = await reader.read();
    assert.match(new TextDecoder().decode(initial.value), /connected/);
    h.eventHub.publish('status', { robotId: 'linebot-01', state: 'online' });
    const pushed = await reader.read();
    assert.match(new TextDecoder().decode(pushed.value), /event: status/);
    await reader.cancel();
  } finally {
    h.eventHub.close();
    h.database.close();
  }
});

test('telemetry cursor pagination preserves rows sharing the boundary timestamp', async () => {
  const h = createHarness();
  const receivedAt = '2026-10-22T01:00:00.000Z';
  try {
    const rows = [
      { bootId: 'boot-a', seq: 1 },
      { bootId: 'boot-a', seq: 2 },
      { bootId: 'boot-b', seq: 1 },
    ];
    for (const { bootId, seq } of rows) {
      h.database.insertTelemetry({
        robotId: 'linebot-01', bootId, seq, receivedAt,
        uptimeMs: seq * 10, mask: 4, position: 2, error: 0, correction: 0,
        leftPwm: 75, rightPwm: 75, mode: 'track', dtMs: 10,
        pidRevision: 0, droppedFrames: 0, droppedAcks: 0, droppedEvents: 0,
      });
    }

    const firstResponse = await h.app.request('/api/robots/linebot-01/telemetry?limit=2');
    const first = await firstResponse.json();
    assert.deepEqual(first.telemetry.map(row => `${row.boot_id}:${row.seq}`),
                     ['boot-a:2', 'boot-b:1']);
    assert.equal(typeof first.nextCursor, 'string');

    const secondResponse = await h.app.request(
      `/api/robots/linebot-01/telemetry?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    const second = await secondResponse.json();
    assert.deepEqual(second.telemetry.map(row => `${row.boot_id}:${row.seq}`), ['boot-a:1']);
    assert.equal(second.nextCursor, null);
  } finally {
    h.eventHub.close();
    h.database.close();
  }
});
