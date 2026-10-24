import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getSensorStates,
  getSensorState,
  hasDualCenterLineCue,
  chooseRobotId,
  normalizePidAck,
  normalizePidState,
  normalizeStatus,
  normalizeTelemetry,
  parseGainDraft,
} from './robot-data.js';

const databaseRow = {
  robot_id: 'linebot-01',
  boot_id: 'boot-a',
  seq: 5,
  received_at: '2026-10-22T01:00:00.000Z',
  uptime_ms: 1500,
  mask: 5,
  position: 1,
  error: -1,
  correction: -12.5,
  left_pwm: 62,
  right_pwm: 88,
  mode: 'track',
  dt_ms: 10,
  pid_revision: 3,
  dropped_frames: 2,
  dropped_acks: 0,
  dropped_events: 1,
};

test('selects the configured robot when the initial/default ID is unavailable', () => {
  assert.equal(chooseRobotId(['linebot-02', 'linebot-03'], 'linebot-01'), 'linebot-02');
  assert.equal(chooseRobotId(['linebot-01', 'linebot-02'], 'linebot-01'), 'linebot-01');
  assert.equal(chooseRobotId([], 'linebot-01'), 'linebot-01');
});

test('normalizes database telemetry fields into dashboard telemetry', () => {
  const telemetry = normalizeTelemetry(databaseRow);
  assert.deepEqual(
    [telemetry.robotId, telemetry.bootId, telemetry.sequence, telemetry.receivedAt],
    ['linebot-01', 'boot-a', 5, '2026-10-22T01:00:00.000Z'],
  );
  assert.deepEqual(
    [telemetry.mask, telemetry.position, telemetry.error, telemetry.leftPwm, telemetry.rightPwm],
    [5, 1, -1, 62, 88],
  );
  assert.equal(telemetry.droppedFrames, 2);
});

test('normalizes both sensor rows while treating old records as front-only', () => {
  const legacy = normalizeTelemetry(databaseRow);
  assert.deepEqual(
    [legacy.frontMask, legacy.frontPosition, legacy.rearMask,
      legacy.rearPosition, legacy.controlSensor],
    [5, 1, null, null, 'front'],
  );

  const dual = normalizeTelemetry({
    ...databaseRow,
    mask: 4,
    position: 2,
    error: 0,
    front_mask: 4,
    front_position: 2,
    rear_mask: 8,
    rear_position: 3,
    control_sensor: 'front',
  });
  assert.deepEqual(
    [dual.frontMask, dual.frontPosition, dual.rearMask,
      dual.rearPosition, dual.controlSensor],
    [4, 2, 8, 3, 'front'],
  );
  const rearFallback = normalizeTelemetry({
    ...databaseRow,
    mask: 8,
    position: 3,
    error: 1,
    front_mask: 0,
    front_position: null,
    rear_mask: 8,
    rear_position: 3,
    control_sensor: 'rear',
  });
  assert.equal(rearFallback.controlSensor, 'rear');
  assert.equal(rearFallback.frontPosition, null);
  assert.equal(normalizeTelemetry({
    ...databaseRow, front_mask: 0, front_position: 2,
  }), null);
  assert.equal(normalizeTelemetry({
    ...databaseRow,
    mask: 8,
    position: 3,
    error: 1,
    front_mask: 4,
    front_position: 2,
    rear_mask: 8,
    rear_position: 3,
    control_sensor: 'rear',
  }), null);
  assert.equal(normalizeTelemetry({
    ...databaseRow,
    mask: 0,
    position: null,
    error: null,
    front_mask: 4,
    front_position: 2,
    rear_mask: 0,
    rear_position: null,
    control_sensor: 'none',
  }), null);
  assert.equal(normalizeTelemetry({
    ...databaseRow,
    mask: 0,
    position: null,
    error: null,
    front_mask: 0,
    front_position: null,
    rear_mask: 8,
    rear_position: 3,
    control_sensor: 'none',
  }), null);
  assert.equal(normalizeTelemetry({
    ...databaseRow,
    mask: 0,
    position: null,
    error: null,
    front_mask: 0,
    front_position: null,
    control_sensor: 'none',
  }), null);
  assert.equal(normalizeTelemetry({
    ...databaseRow,
    mask: 0,
    position: null,
    error: null,
    front_mask: 0,
    front_position: null,
    rear_mask: null,
    rear_position: null,
    control_sensor: 'none',
  }), null);
  assert.equal(normalizeTelemetry({
    ...databaseRow,
    mask: 4,
    position: 1,
    error: -1,
    front_mask: 4,
    front_position: 2,
    rear_mask: 0,
    rear_position: null,
    control_sensor: 'front',
  }), null);
  assert.equal(normalizeTelemetry({
    ...databaseRow,
    mask: 8,
    position: 1,
    error: -1,
    front_mask: 0,
    front_position: null,
    rear_mask: 8,
    rear_position: 3,
    control_sensor: 'rear',
  }), null);
});

test('normalizes live MQTT telemetry and nullable lost-line readings', () => {
  const live = normalizeTelemetry({
    robotId: 'linebot-01', bootId: 'boot-b', seq: 6,
    receivedAt: '2026-10-22T01:00:00.100Z', uptimeMs: 1600,
    mask: 0, position: null, error: null, correction: 0,
    leftPwm: 0, rightPwm: 0, mode: 'lost', dtMs: 10,
    pidRevision: 3, droppedFrames: 0,
  });
  assert.equal(live.mode, 'lost');
  assert.equal(live.position, null);
  assert.equal(live.error, null);
});

test('sensor states preserve the firmware bit-0-is-left ordering', () => {
  assert.deepEqual(getSensorStates(0b00101), [true, false, true, false, false]);
  assert.deepEqual(getSensorStates(0b10000), [false, false, false, false, true]);
});

test('sensor state is unknown until telemetry has been received', () => {
  assert.equal(getSensorState(0, 0, false), 'unknown');
  assert.equal(getSensorState(0, 0, true), 'clear');
  assert.equal(getSensorState(1, 0, true), 'line');
  assert.equal(getSensorState(1, 5, true), 'unknown');
});

test('straightness cue requires both front and rear center sensors to see line', () => {
  assert.equal(hasDualCenterLineCue(0b00100, 0b00100), true);
  assert.equal(hasDualCenterLineCue(0b01100, 0b00100), true);
  assert.equal(hasDualCenterLineCue(0b00100, 0), false);
  assert.equal(hasDualCenterLineCue(0, 0b00100), false);
  assert.equal(hasDualCenterLineCue(0b00100, null), false);
  assert.equal(hasDualCenterLineCue(32, 0b00100), false);
});

test('PID draft parsing accepts finite bounded gains and rejects invalid values', () => {
  assert.deepEqual(parseGainDraft({ kp: '12.5', ki: '1', kd: '0.15' }), {
    kp: 12.5, ki: 1, kd: 0.15,
  });
  assert.equal(parseGainDraft({ kp: '', ki: '1', kd: '0.1' }), null);
  assert.equal(parseGainDraft({ kp: '61', ki: '1', kd: '0.1' }), null);
  assert.equal(parseGainDraft({ kp: '12', ki: 'Infinity', kd: '0.1' }), null);
  assert.equal(parseGainDraft({ kp: '12', ki: '1', kd: '0.31' }), null);
});

test('normalizes persisted PID state, device status and command acknowledgements', () => {
  assert.deepEqual(normalizePidState({
    robot_id: 'linebot-01', kp: 12.5, ki: 1, kd: 0.15, revision: 4,
    request_id: 'web-4', persisted: 1, received_at: '2026-10-22T01:00:00.000Z',
  }), {
    kp: 12.5, ki: 1, kd: 0.15, revision: 4, requestId: 'web-4',
    persisted: true, receivedAt: '2026-10-22T01:00:00.000Z',
  });
  assert.deepEqual(normalizeStatus({
    state: 'online', wifi: 'connected', rssi: -48,
    received_at: '2026-10-22T01:00:00.000Z',
  }), {
    state: 'online', wifi: 'connected', rssi: -48,
    receivedAt: '2026-10-22T01:00:00.000Z',
  });
  assert.deepEqual(normalizePidAck({
    request_id: 'web-4', status: 'persisted', applied_revision: 4, reason: null,
  }), { requestId: 'web-4', status: 'persisted', revision: 4, reason: null });
  assert.equal(normalizePidAck({ requestId: 'bad', status: 'unknown', revision: 1 }), null);
});
