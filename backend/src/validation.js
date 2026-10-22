export const MAX_MQTT_PAYLOAD_BYTES = 512;
export const PID_GAIN_LIMITS = Object.freeze({ kp: 60, ki: 12, kd: 0.3 });

const CONTROL_MODES = new Set(['track', 'pivot', 'lost']);
const CONTROL_EVENTS = new Set([
  'corner_cluster', 'pivot_started', 'line_reacquired', 'pivot_timeout',
]);
const ACK_STATUSES = new Set(['applied', 'persisted', 'rejected', 'failed']);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,36}$/;

export class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadError';
  }
}

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PayloadError('expected_json_object');
  }
  return value;
}

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PayloadError(`invalid_${name}`);
  }
  return value;
}

function finiteNumber(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new PayloadError(`invalid_${name}`);
  }
  return value;
}

function nullableNumber(value, min, max, name) {
  return value === null ? null : finiteNumber(value, min, max, name);
}

function text(value, maxBytes, name, pattern = null) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1 ||
      Buffer.byteLength(value, 'utf8') > maxBytes || (pattern && !pattern.test(value))) {
    throw new PayloadError(`invalid_${name}`);
  }
  return value;
}

export function parseJsonPayload(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length === 0 || buffer.length > MAX_MQTT_PAYLOAD_BYTES) {
    throw new PayloadError('payload_size');
  }
  try {
    return object(JSON.parse(buffer.toString('utf8')));
  } catch (error) {
    if (error instanceof PayloadError) throw error;
    throw new PayloadError('invalid_json');
  }
}

function requireVersionAndRobot(payload, expectedRobotId) {
  if (payload.v !== 1) throw new PayloadError('unsupported_version');
  const robotId = text(payload.robotId, 32, 'robot_id', SAFE_ID_RE);
  if (robotId !== expectedRobotId) throw new PayloadError('robot_id_mismatch');
}

export function parseTelemetry(payload, robotId, receivedAt) {
  object(payload);
  requireVersionAndRobot(payload, robotId);
  const bootId = text(payload.bootId, 32, 'boot_id', SAFE_ID_RE);
  const seq = integer(payload.seq, 0, 0xffffffff, 'seq');
  const uptimeMs = integer(payload.uptimeMs, 0, Number.MAX_SAFE_INTEGER, 'uptime');
  const mask = integer(payload.mask, 0, 31, 'mask');
  const position = nullableNumber(payload.position, 0, 4, 'position');
  const error = nullableNumber(payload.error, -2, 2, 'error');
  if ((mask === 0) !== (position === null && error === null)) {
    throw new PayloadError('sensor_position_mismatch');
  }
  if (mask !== 0 && (position === null || error === null)) {
    throw new PayloadError('sensor_position_mismatch');
  }
  const mode = text(payload.mode, 8, 'mode');
  if (!CONTROL_MODES.has(mode)) throw new PayloadError('invalid_mode');
  return {
    robotId,
    bootId,
    seq,
    receivedAt,
    uptimeMs,
    mask,
    position,
    error,
    correction: finiteNumber(payload.correction, -120, 120, 'correction'),
    leftPwm: integer(payload.leftPwm, -180, 180, 'left_pwm'),
    rightPwm: integer(payload.rightPwm, -180, 180, 'right_pwm'),
    mode,
    dtMs: integer(payload.dtMs, 1, 60000, 'dt_ms'),
    pidRevision: integer(payload.pidRevision, 0, 0xffffffff, 'pid_revision'),
    droppedFrames: integer(payload.droppedFrames, 0, 0xffffffff, 'dropped_frames'),
    droppedAcks: integer(payload.droppedAcks ?? 0, 0, 0xffffffff, 'dropped_acks'),
    droppedEvents: integer(payload.droppedEvents ?? 0, 0, 0xffffffff, 'dropped_events'),
  };
}

export function parseStatus(payload, robotId, receivedAt) {
  object(payload);
  requireVersionAndRobot(payload, robotId);
  if (!['online', 'offline'].includes(payload.state)) {
    throw new PayloadError('invalid_status');
  }
  const wifi = payload.wifi === undefined ? null : text(payload.wifi, 16, 'wifi');
  const rssi = payload.rssi === undefined ? null : integer(payload.rssi, -127, 0, 'rssi');
  return { robotId, state: payload.state, wifi, rssi, receivedAt };
}

export function parsePidState(payload, robotId, receivedAt) {
  object(payload);
  requireVersionAndRobot(payload, robotId);
  if (typeof payload.persisted !== 'boolean') throw new PayloadError('invalid_persisted');
  return {
    robotId,
    kp: finiteNumber(payload.kp, 0, PID_GAIN_LIMITS.kp, 'kp'),
    ki: finiteNumber(payload.ki, 0, PID_GAIN_LIMITS.ki, 'ki'),
    kd: finiteNumber(payload.kd, 0, PID_GAIN_LIMITS.kd, 'kd'),
    revision: integer(payload.revision, 0, 0xffffffff, 'revision'),
    requestId: payload.requestId === undefined || payload.requestId === ''
      ? null : text(payload.requestId, 36, 'request_id', REQUEST_ID_RE),
    persisted: payload.persisted,
    receivedAt,
  };
}

export function parsePidAck(payload, robotId, receivedAt) {
  object(payload);
  requireVersionAndRobot(payload, robotId);
  const status = text(payload.status, 16, 'ack_status');
  if (!ACK_STATUSES.has(status)) throw new PayloadError('invalid_ack_status');
  return {
    robotId,
    requestId: text(payload.requestId, 36, 'request_id', REQUEST_ID_RE),
    status,
    revision: integer(payload.revision, 0, 0xffffffff, 'revision'),
    reason: payload.reason === undefined ? null : text(payload.reason, 31, 'reason'),
    receivedAt,
  };
}

export function parseControlEvent(payload, robotId, receivedAt) {
  object(payload);
  requireVersionAndRobot(payload, robotId);
  const event = text(payload.event, 24, 'event');
  if (!CONTROL_EVENTS.has(event)) throw new PayloadError('invalid_event');
  const mode = text(payload.mode, 8, 'mode');
  if (!CONTROL_MODES.has(mode)) throw new PayloadError('invalid_mode');
  return {
    robotId,
    bootId: text(payload.bootId, 32, 'boot_id', SAFE_ID_RE),
    seq: integer(payload.seq, 0, 0xffffffff, 'seq'),
    receivedAt,
    uptimeMs: integer(payload.uptimeMs, 0, Number.MAX_SAFE_INTEGER, 'uptime'),
    event,
    mask: integer(payload.mask, 0, 31, 'mask'),
    mode,
    position: nullableNumber(payload.position, 0, 4, 'position'),
  };
}

export function validatePidPost(body) {
  object(body);
  return {
    kp: finiteNumber(body.kp, 0, PID_GAIN_LIMITS.kp, 'kp'),
    ki: finiteNumber(body.ki, 0, PID_GAIN_LIMITS.ki, 'ki'),
    kd: finiteNumber(body.kd, 0, PID_GAIN_LIMITS.kd, 'kd'),
  };
}
