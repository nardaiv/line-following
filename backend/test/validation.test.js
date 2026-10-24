import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PayloadError,
  parseControlEvent,
  parseJsonPayload,
  parsePidAck,
  parsePidState,
  parseStatus,
  parseTelemetry,
  validatePidPost,
} from '../src/validation.js';

const receivedAt = '2026-10-22T00:00:00.000Z';

const telemetry = {
  v: 1,
  robotId: 'linebot-01',
  bootId: 'A1B2C3D4',
  seq: 12,
  uptimeMs: 1234,
  mask: 4,
  position: 2,
  error: 0,
  correction: 1.5,
  leftPwm: 76,
  rightPwm: 74,
  mode: 'track',
  dtMs: 10,
  pidRevision: 3,
  droppedFrames: 0,
  droppedAcks: 0,
  droppedEvents: 0,
};

test('telemetry validates and preserves device sequence/time separately', () => {
  const row = parseTelemetry(telemetry, 'linebot-01', receivedAt);
  assert.equal(row.seq, 12);
  assert.equal(row.uptimeMs, 1234);
  assert.equal(row.receivedAt, receivedAt);
  assert.equal(row.mask, 4);
});

test('telemetry preserves dual front/rear sensor rows and accepts legacy payloads', () => {
  const dual = parseTelemetry({
    ...telemetry,
    frontMask: 4,
    frontPosition: 2,
    rearMask: 8,
    rearPosition: 3,
    controlSensor: 'front',
  }, 'linebot-01', receivedAt);
  assert.deepEqual(
    [dual.frontMask, dual.frontPosition, dual.rearMask, dual.rearPosition, dual.controlSensor],
    [4, 2, 8, 3, 'front'],
  );
  const rearFallback = parseTelemetry({
    ...telemetry,
    mask: 8,
    position: 3,
    error: 1,
    frontMask: 0,
    frontPosition: null,
    rearMask: 8,
    rearPosition: 3,
    controlSensor: 'rear',
  }, 'linebot-01', receivedAt);
  assert.equal(rearFallback.controlSensor, 'rear');
  assert.equal(rearFallback.frontPosition, null);

  const legacy = parseTelemetry(telemetry, 'linebot-01', receivedAt);
  assert.deepEqual(
    [legacy.frontMask, legacy.frontPosition, legacy.rearMask, legacy.rearPosition,
      legacy.controlSensor],
    [4, 2, null, null, 'front'],
  );
  assert.throws(() => parseTelemetry({
    ...telemetry, frontMask: 0, frontPosition: 2,
  }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({
    ...telemetry, rearMask: 8, rearPosition: null, controlSensor: 'rear',
    mask: 8, position: 3, error: 1,
  }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({
    ...telemetry, mask: 8, position: 3, error: 1,
    frontMask: 4, frontPosition: 2, rearMask: 8, rearPosition: 3,
    controlSensor: 'rear',
  }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({
    ...telemetry, mask: 0, position: null, error: null,
    frontMask: 4, frontPosition: 2, rearMask: 0, rearPosition: null,
    controlSensor: 'none',
  }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({
    ...telemetry, mask: 0, position: null, error: null,
    frontMask: 0, frontPosition: null, rearMask: 8, rearPosition: 3,
    controlSensor: 'none',
  }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({
    ...telemetry, mask: 0, position: null, error: null,
    frontMask: 0, frontPosition: null, controlSensor: 'none',
  }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({
    ...telemetry, mask: 0, position: null, error: null,
    frontMask: 0, frontPosition: null, rearMask: null, rearPosition: null,
    controlSensor: 'none',
  }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({
    ...telemetry, mask: 4, position: 1, error: -1,
    frontMask: 4, frontPosition: 2, rearMask: 0, rearPosition: null,
    controlSensor: 'front',
  }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({
    ...telemetry, mask: 8, position: 1, error: -1,
    frontMask: 0, frontPosition: null, rearMask: 8, rearPosition: 3,
    controlSensor: 'rear',
  }, 'linebot-01', receivedAt), PayloadError);
});

test('telemetry rejects robot mismatch and impossible sensor data', () => {
  assert.throws(() => parseTelemetry(telemetry, 'other', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({ ...telemetry, mask: 0 }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({ ...telemetry, seq: -1 }, 'linebot-01', receivedAt), PayloadError);
  assert.throws(() => parseTelemetry({ ...telemetry, correction: Infinity }, 'linebot-01', receivedAt), PayloadError);
});

test('status, PID state, ACK and control events enforce their schemas', () => {
  assert.equal(parseStatus({ v: 1, robotId: 'linebot-01', state: 'online', wifi: 'connected', rssi: -42 }, 'linebot-01', receivedAt).rssi, -42);
  assert.equal(parsePidState({ v: 1, robotId: 'linebot-01', kp: 12.5, ki: 1, kd: 0.15, revision: 3, requestId: 'req-3', persisted: true }, 'linebot-01', receivedAt).requestId, 'req-3');
  assert.equal(parsePidAck({ v: 1, robotId: 'linebot-01', requestId: 'req-3', status: 'persisted', revision: 3 }, 'linebot-01', receivedAt).status, 'persisted');
  assert.equal(parseControlEvent({ v: 1, robotId: 'linebot-01', bootId: 'A1B2C3D4', seq: 13, uptimeMs: 1240, event: 'pivot_started', mask: 0, mode: 'pivot', position: null }, 'linebot-01', receivedAt).event, 'pivot_started');
  assert.throws(() => parsePidState({ v: 1, robotId: 'linebot-01', kp: 1000, ki: 1, kd: 0, revision: 1, persisted: true }, 'linebot-01', receivedAt), PayloadError);
});

test('payload parser rejects oversized and malformed JSON', () => {
  assert.throws(() => parseJsonPayload(Buffer.alloc(513, 0x20)), PayloadError);
  assert.throws(() => parseJsonPayload(Buffer.from('{bad')), PayloadError);
});

test('HTTP PID validation rejects nonfinite and out-of-range gains', () => {
  assert.deepEqual(validatePidPost({ kp: 12.5, ki: 1, kd: 0.15 }), { kp: 12.5, ki: 1, kd: 0.15 });
  assert.throws(() => validatePidPost({ kp: NaN, ki: 1, kd: 0.15 }), PayloadError);
  assert.throws(() => validatePidPost({ kp: 12.5, ki: 13, kd: 0.15 }), PayloadError);
});
