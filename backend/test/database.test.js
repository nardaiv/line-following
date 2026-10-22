import test from 'node:test';
import assert from 'node:assert/strict';

import { createDatabase } from '../src/database.js';

const time = '2026-10-22T00:00:00.000Z';

function telemetryRow(seq = 1) {
  return {
    robotId: 'linebot-01', bootId: 'boot-a', seq, receivedAt: time,
    uptimeMs: seq * 10, mask: 4, position: 2, error: 0, correction: 0,
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
    assert.equal(db.telemetryPage('linebot-01', null, 1).length, 1);
  } finally {
    db.close();
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
