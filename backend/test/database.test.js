import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabase } from '../src/database.js';

const time = '2026-10-22T00:00:00.000Z';

function telemetryRow(seq = 1) {
  return {
    robotId: 'linebot-01', bootId: 'boot-a', seq, receivedAt: time,
    uptimeMs: seq * 10, mask: 4, position: 2, error: 0, correction: 0,
    frontMask: 4, frontPosition: 2, rearMask: 8, rearPosition: 3,
    controlSensor: 'front',
    leftPwm: 75, rightPwm: 75, mode: 'track', dtMs: 10,
    pidRevision: 0, droppedFrames: 0, droppedAcks: 0, droppedEvents: 0,
  };
}

test('SQLite deduplicates telemetry and returns bounded history', () => {
  const db = createDatabase(':memory:');
  try {
    assert.equal(db.insertTelemetry(telemetryRow(1)), true);
    assert.equal(db.insertTelemetry(telemetryRow(1)), false);
    assert.equal(db.insertTelemetry({ ...telemetryRow(2), receivedAt: '2026-10-22T00:00:01.000Z' }), true);
    assert.equal(db.raw.prepare('SELECT count(*) AS n FROM telemetry').get().n, 2);
    assert.equal(db.latestTelemetry('linebot-01').seq, 2);
    const latest = db.latestTelemetry('linebot-01');
    assert.deepEqual(
      [latest.front_mask, latest.front_position, latest.rear_mask,
        latest.rear_position, latest.control_sensor],
      [4, 2, 8, 3, 'front'],
    );
    assert.equal(db.telemetryPage('linebot-01', null, 1).length, 1);
  } finally {
    db.close();
  }
});

test('SQLite keeps a null front position when the rear row is selected', () => {
  const db = createDatabase(':memory:');
  try {
    const row = {
      ...telemetryRow(3),
      mask: 16,
      position: 4,
      error: 2,
      frontMask: 0,
      frontPosition: null,
      rearMask: 16,
      rearPosition: 4,
      controlSensor: 'rear',
    };
    db.insertTelemetry(row);
    const saved = db.latestTelemetry('linebot-01');
    assert.deepEqual(
      [saved.front_mask, saved.front_position, saved.rear_mask,
        saved.rear_position, saved.control_sensor],
      [0, null, 16, 4, 'rear'],
    );
  } finally {
    db.close();
  }
});

test('CSV telemetry pages are oldest-first with inclusive from and exclusive to', () => {
  const db = createDatabase(':memory:');
  const from = '2026-10-22T00:00:00.000Z';
  const to = '2026-10-22T00:00:02.000Z';
  try {
    const rows = [
      { ...telemetryRow(10), receivedAt: '2026-10-21T23:59:59.999Z' },
      { ...telemetryRow(1), receivedAt: from, bootId: 'boot-a' },
      { ...telemetryRow(1), receivedAt: from, bootId: 'boot-b' },
      { ...telemetryRow(2), receivedAt: '2026-10-22T00:00:01.000Z', bootId: 'boot-a' },
      { ...telemetryRow(3), receivedAt: to, bootId: 'boot-a' },
    ];
    for (const row of rows) db.insertTelemetry(row);

    assert.equal(db.telemetryCsvCount('linebot-01', from, to), 3);
    const snapshot = db.openTelemetryCsvExport('linebot-01', from, to, 100);
    try {
      assert.equal(snapshot.rowCount, 3);
      const first = snapshot.page(null, 2);
      assert.deepEqual(first.map(row => `${row.received_at}:${row.boot_id}:${row.seq}`), [
        `${from}:boot-a:1`, `${from}:boot-b:1`,
      ]);
      const last = first.at(-1);
      const second = snapshot.page({
        receivedAt: last.received_at, seq: last.seq, bootId: last.boot_id,
      }, 2);
      assert.deepEqual(second.map(row => row.seq), [2]);
    } finally {
      snapshot.close();
    }
  } finally {
    db.close();
  }
});

test('SQLite v2 telemetry rows migrate as front-only samples', () => {
  const directory = mkdtempSync(join(tmpdir(), 'linebot-db-'));
  const path = join(directory, 'telemetry.sqlite');
  try {
    const initial = createDatabase(path);
    for (const column of [
      'front_mask', 'front_position', 'rear_mask', 'rear_position', 'control_sensor',
    ]) {
      initial.raw.exec(`ALTER TABLE telemetry DROP COLUMN ${column}`);
    }
    const row = telemetryRow(1);
    initial.raw.prepare(`
      INSERT INTO telemetry (
        robot_id, boot_id, seq, received_at, uptime_ms, mask, position, error,
        correction, left_pwm, right_pwm, mode, dt_ms, pid_revision,
        dropped_frames, dropped_acks, dropped_events
      ) VALUES (
        @robotId, @bootId, @seq, @receivedAt, @uptimeMs, @mask, @position, @error,
        @correction, @leftPwm, @rightPwm, @mode, @dtMs, @pidRevision,
        @droppedFrames, @droppedAcks, @droppedEvents
      )
    `).run(row);
    initial.raw.pragma('user_version = 2');
    initial.close();

    const migrated = createDatabase(path);
    assert.equal(migrated.raw.pragma('user_version', { simple: true }), 3);
    const saved = migrated.latestTelemetry('linebot-01');
    assert.deepEqual(
      [saved.front_mask, saved.front_position, saved.rear_mask,
        saved.rear_position, saved.control_sensor],
      [4, 2, null, null, 'front'],
    );
    migrated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PID state reconciles command acknowledgements without trusting publish success', () => {
  const db = createDatabase(':memory:');
  try {
    db.createPidCommand({
      robotId: 'linebot-01', requestId: 'req-1', baseRevision: 0,
      kp: 12, ki: 1, kd: 0.1, requestedAt: time,
    });
    assert.equal(db.pidCommands('linebot-01')[0].status, 'pending');
    db.updatePidAck({
      robotId: 'linebot-01', requestId: 'req-1', status: 'applied',
      revision: 1, reason: null, receivedAt: time,
    });
    assert.equal(db.pidCommands('linebot-01')[0].status, 'applied');
    db.upsertPidState({
      robotId: 'linebot-01', kp: 12, ki: 1, kd: 0.1, revision: 1,
      requestId: 'req-1', persisted: true, receivedAt: time,
    });
    db.reconcilePidState({
      robotId: 'linebot-01', requestId: 'req-1', revision: 1,
      persisted: true, receivedAt: time,
    });
    assert.equal(db.pidCommands('linebot-01')[0].status, 'persisted');
    assert.equal(db.latestPidState('linebot-01').persisted, true);
  } finally {
    db.close();
  }
});

test('PID command status never regresses when acknowledgements arrive out of order', () => {
  const db = createDatabase(':memory:');
  try {
    db.createPidCommand({
      robotId: 'linebot-01', requestId: 'req-persisted', baseRevision: 0,
      kp: 12, ki: 1, kd: 0.1, requestedAt: time,
    });
    const persisted = {
      robotId: 'linebot-01', requestId: 'req-persisted', status: 'persisted',
      revision: 1, reason: null, receivedAt: '2026-10-22T00:00:02.000Z',
    };
    assert.equal(db.updatePidAck(persisted), 1);
    assert.equal(db.updatePidAck({
      ...persisted, status: 'applied', receivedAt: '2026-10-22T00:00:03.000Z',
    }), 0);
    assert.equal(db.pidCommands('linebot-01')[0].status, 'persisted');

    db.createPidCommand({
      robotId: 'linebot-01', requestId: 'req-failed', baseRevision: 1,
      kp: 10, ki: 1, kd: 0.1, requestedAt: time,
    });
    const applied = {
      robotId: 'linebot-01', requestId: 'req-failed', status: 'applied',
      revision: 2, reason: null, receivedAt: time,
    };
    assert.equal(db.updatePidAck(applied), 1);
    assert.equal(db.updatePidAck({
      ...applied, status: 'failed', reason: 'persist_failed',
      receivedAt: '2026-10-22T00:00:02.000Z',
    }), 1);
    assert.equal(db.updatePidAck({
      ...applied, receivedAt: '2026-10-22T00:00:03.000Z',
    }), 0);
    assert.equal(db.pidCommands('linebot-01')[0].status, 'failed');
  } finally {
    db.close();
  }
});

test('control events are deduplicated and retention prunes old rows', () => {
  const db = createDatabase(':memory:');
  try {
    const event = {
      robotId: 'linebot-01', bootId: 'boot-a', seq: 1, receivedAt: time,
      uptimeMs: 100, event: 'pivot_started', mask: 0, mode: 'pivot', position: null,
    };
    assert.equal(db.insertEvent(event), true);
    assert.equal(db.insertEvent(event), false);
    db.insertTelemetry(telemetryRow(1));
    assert.equal(db.pruneBefore('2026-10-22T00:00:01.000Z'), 2);
  } finally {
    db.close();
  }
});
