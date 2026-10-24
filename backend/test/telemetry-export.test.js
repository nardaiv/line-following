import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { EventHub } from '../src/event-hub.js';

const FROM = '2026-10-23T10:00:00.000Z';
const TO = '2026-10-23T11:00:00.000Z';
const NOW = new Date('2026-10-23T12:00:00.000Z');

function row({ bootId = 'boot-a', seq = 1, receivedAt = FROM, mask = 4 } = {}) {
  const hasLine = mask !== 0;
  const position = hasLine ? 2 : null;
  return {
    robotId: 'linebot-01', bootId, seq, receivedAt, uptimeMs: seq * 10,
    mask, position, error: hasLine ? 0 : null,
    frontMask: mask, frontPosition: position,
    rearMask: 0, rearPosition: null,
    controlSensor: hasLine ? 'front' : 'none',
    correction: 0, leftPwm: 75, rightPwm: 75, mode: 'track', dtMs: 10,
    pidRevision: 0, droppedFrames: 0, droppedAcks: 0, droppedEvents: 0,
  };
}

function harness(options = {}) {
  const database = createDatabase(':memory:');
  const eventHub = new EventHub();
  const config = {
    robotIds: ['linebot-01'],
    allowedOrigins: ['http://127.0.0.1:5173'],
    csvExportMaxRows: 100,
    csvExportPageSize: 2,
    ...options,
  };
  const app = createApp({
    config,
    database,
    eventHub,
    mqttBridge: { metrics: { connected: true } },
    clock: () => new Date(NOW),
  });
  const request = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('host')) headers.set('host', '127.0.0.1:3000');
    return app.request(path, { ...init, headers });
  };
  return { database, eventHub, request };
}

function close(h) {
  h.eventHub.close();
  h.database.close();
}

test('CSV export metadata validates robot and strict UTC half-open range', async () => {
  const h = harness();
  try {
    h.database.insertTelemetry(row({ seq: 10, receivedAt: '2026-10-23T09:59:59.999Z' }));
    h.database.insertTelemetry(row({ seq: 1, bootId: 'boot-a', receivedAt: FROM }));
    h.database.insertTelemetry(row({ seq: 1, bootId: 'boot-b', receivedAt: FROM }));
    h.database.insertTelemetry(row({ seq: 2, receivedAt: '2026-10-23T10:30:00.000Z' }));
    h.database.insertTelemetry(row({ seq: 3, receivedAt: TO }));

    const response = await h.request(
      `/api/robots/linebot-01/telemetry.csv/info?from=${FROM}&to=${TO}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      robotId: 'linebot-01', from: FROM, to: TO, rowCount: 3, maxRows: 100,
    });
    const futureEnd = await h.request(
      `/api/robots/linebot-01/telemetry.csv/info?from=${FROM}&to=2026-10-23T13:00:00.000Z`,
    );
    assert.equal((await futureEnd.json()).to, NOW.toISOString());

    const unknown = await h.request(`/api/robots/nope/telemetry.csv/info?from=${FROM}&to=${TO}`);
    assert.equal(unknown.status, 404);
    const offset = await h.request(
      `/api/robots/linebot-01/telemetry.csv/info?from=2026-10-23T10:00:00+01:00&to=${TO}`,
    );
    assert.equal(offset.status, 400);
    const reversed = await h.request(
      `/api/robots/linebot-01/telemetry.csv/info?from=${TO}&to=${FROM}`,
    );
    assert.equal(reversed.status, 400);
  } finally {
    close(h);
  }
});

test('CSV download streams chronological pages with stable headers and filename', async () => {
  const h = harness();
  try {
    h.database.insertTelemetry(row({ seq: 1, bootId: 'boot-a', receivedAt: FROM }));
    h.database.insertTelemetry(row({ seq: 1, bootId: 'boot-b', receivedAt: FROM }));
    h.database.insertTelemetry(row({ seq: 2, receivedAt: '2026-10-23T10:30:00.000Z' }));

    const response = await h.request(
      `/api/robots/linebot-01/telemetry.csv?from=${FROM}&to=${TO}`,
    );
    assert.equal(response.status, 200);
    h.database.insertTelemetry(row({ seq: 3, receivedAt: TO }));
    assert.match(response.headers.get('content-type'), /text\/csv; charset=utf-8/);
    assert.equal(
      response.headers.get('content-disposition'),
      'attachment; filename="linebot-01_telemetry_2026-10-23T10-00-00-000Z_2026-10-23T11-00-00-000Z.csv"',
    );
    const csv = await response.text();
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^robot_id,boot_id,seq,received_at,uptime_ms,mask,/);
    assert.match(lines[1], /^linebot-01,boot-a,1,/);
    assert.match(lines[2], /^linebot-01,boot-b,1,/);
    assert.match(lines[3], /^linebot-01,boot-a,2,/);
  } finally {
    close(h);
  }
});

test('CSV export survives retention pruning between streamed pages', async () => {
  const h = harness();
  try {
    h.database.insertTelemetry(row({ seq: 1, receivedAt: FROM }));
    h.database.insertTelemetry(row({ seq: 2, receivedAt: '2026-10-23T10:30:00.000Z' }));
    h.database.insertTelemetry(row({ seq: 3, receivedAt: '2026-10-23T10:45:00.000Z' }));
    const response = await h.request(
      `/api/robots/linebot-01/telemetry.csv?from=${FROM}&to=${TO}`,
    );
    assert.equal(response.status, 200);

    h.database.raw.prepare('DELETE FROM telemetry WHERE robot_id=?').run('linebot-01');
    const lines = (await response.text()).trimEnd().split('\r\n');
    assert.equal(lines.length, 4);
    assert.match(lines.at(-1), /^linebot-01,boot-a,3,/);
    assert.equal(response.headers.get('x-export-row-count'), '3');
    assert.equal(
      h.database.raw.prepare('SELECT COUNT(*) AS n FROM telemetry_csv_exports').get().n,
      0,
    );
  } finally {
    close(h);
  }
});

test('CSV download cancellation releases its TEMP snapshot', async () => {
  const h = harness();
  try {
    h.database.insertTelemetry(row({ seq: 1, receivedAt: FROM }));
    h.database.insertTelemetry(row({ seq: 2, receivedAt: '2026-10-23T10:30:00.000Z' }));
    const response = await h.request(
      `/api/robots/linebot-01/telemetry.csv?from=${FROM}&to=${TO}`,
    );
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    assert.equal(
      h.database.raw.prepare('SELECT COUNT(*) AS n FROM telemetry_csv_exports').get().n,
      0,
    );
  } finally {
    close(h);
  }
});

test('CSV mid-stream page errors fail the response and release the TEMP snapshot', async () => {
  const h = harness();
  try {
    for (let seq = 1; seq <= 3; seq += 1) {
      h.database.insertTelemetry(row({ seq, receivedAt: FROM }));
    }
    const openTelemetryCsvExport = h.database.openTelemetryCsvExport;
    let pageCalls = 0;
    h.database.openTelemetryCsvExport = (...args) => {
      const snapshot = openTelemetryCsvExport(...args);
      const page = snapshot.page;
      snapshot.page = (after, limit) => {
        pageCalls += 1;
        if (pageCalls === 2) throw new Error('injected_page_failure');
        return page(after, limit);
      };
      return snapshot;
    };
    const response = await h.request(
      `/api/robots/linebot-01/telemetry.csv?from=${FROM}&to=${TO}`,
    );
    await assert.rejects(response.text(), /csv_stream_failed/);
    assert.equal(pageCalls, 2);
    assert.equal(
      h.database.raw.prepare('SELECT COUNT(*) AS n FROM telemetry_csv_exports').get().n,
      0,
    );
  } finally {
    close(h);
  }
});

test('CSV export reports empty and oversized ranges before streaming', async () => {
  const empty = harness();
  try {
    const info = await empty.request(
      `/api/robots/linebot-01/telemetry.csv/info?from=${FROM}&to=${TO}`,
    );
    assert.equal(info.status, 200);
    assert.equal((await info.json()).rowCount, 0);
    const download = await empty.request(
      `/api/robots/linebot-01/telemetry.csv?from=${FROM}&to=${TO}`,
    );
    assert.equal(download.status, 204);
  } finally {
    close(empty);
  }

  const limited = harness({ csvExportMaxRows: 1 });
  try {
    limited.database.insertTelemetry(row({ seq: 1, receivedAt: FROM }));
    limited.database.insertTelemetry(row({ seq: 2, receivedAt: '2026-10-23T10:30:00.000Z' }));
    const response = await limited.request(
      `/api/robots/linebot-01/telemetry.csv/info?from=${FROM}&to=${TO}`,
    );
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'export_too_large', maxRows: 1 });
    const download = await limited.request(
      `/api/robots/linebot-01/telemetry.csv?from=${FROM}&to=${TO}`,
    );
    assert.equal(download.status, 413);
  } finally {
    close(limited);
  }
});

test('configured CSV limits cannot exceed the hard row and page caps', async () => {
  const h = harness({ csvExportMaxRows: 100_001, csvExportPageSize: 501 });
  try {
    for (let seq = 1; seq <= 501; seq += 1) {
      h.database.insertTelemetry(row({ seq, receivedAt: FROM }));
    }
    const info = await h.request(
      `/api/robots/linebot-01/telemetry.csv/info?from=${FROM}&to=${TO}`,
    );
    assert.equal((await info.json()).maxRows, 100_000);

    const requestedLimits = [];
    const openTelemetryCsvExport = h.database.openTelemetryCsvExport;
    h.database.openTelemetryCsvExport = (...args) => {
      const snapshot = openTelemetryCsvExport(...args);
      const page = snapshot.page;
      snapshot.page = (after, limit) => {
        requestedLimits.push(limit);
        return page(after, limit);
      };
      return snapshot;
    };
    const response = await h.request(
      `/api/robots/linebot-01/telemetry.csv?from=${FROM}&to=${TO}`,
    );
    assert.equal(response.status, 200);
    const lines = (await response.text()).trimEnd().split('\r\n');
    assert.equal(lines.length, 502);
    assert.match(lines[1], /^linebot-01,boot-a,1,/);
    assert.match(lines.at(-1), /^linebot-01,boot-a,501,/);
    assert.deepEqual(requestedLimits, [500, 500]);
  } finally {
    close(h);
  }
});
