const GAIN_LIMITS = Object.freeze({ kp: 60, ki: 12, kd: 0.3 });
const MODES = new Set(['track', 'pivot', 'lost']);
const ACK_STATUSES = new Set(['applied', 'persisted', 'rejected', 'failed']);

/** @param {Record<string, unknown>} source @param {string} camel @param {string} [snake=camel] */
function pick(source, camel, snake = camel) {
  return source[camel] !== undefined ? source[camel] : source[snake];
}

/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** @param {unknown} value @param {number} min @param {number} max */
function finite(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** @param {unknown} value @param {number} min @param {number} max */
function nullableFinite(value, min, max) {
  return value === null || finite(value, min, max);
}

/** @param {unknown} value */
export function normalizeTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = /** @type {Record<string, unknown>} */ (value);
  const robotId = pick(row, 'robotId', 'robot_id');
  const bootId = pick(row, 'bootId', 'boot_id');
  const sequence = pick(row, 'seq');
  const receivedAt = pick(row, 'receivedAt', 'received_at');
  const uptimeMs = pick(row, 'uptimeMs', 'uptime_ms');
  const mask = pick(row, 'mask');
  const position = pick(row, 'position');
  const error = pick(row, 'error');
  const rawFrontMask = pick(row, 'frontMask', 'front_mask');
  const frontMask = rawFrontMask === undefined ? mask : rawFrontMask;
  const rawFrontPosition = pick(row, 'frontPosition', 'front_position');
  const frontPosition = rawFrontPosition === undefined ? position : rawFrontPosition;
  const rearMask = pick(row, 'rearMask', 'rear_mask') ?? null;
  const rearPosition = pick(row, 'rearPosition', 'rear_position') ?? null;
  const rawControlSensor = pick(row, 'controlSensor', 'control_sensor');
  const controlSensorExplicit = rawControlSensor !== undefined;
  const controlSensor = rawControlSensor === undefined
    ? (mask === 0 ? 'none' : 'front') : rawControlSensor;
  const correction = pick(row, 'correction');
  const leftPwm = pick(row, 'leftPwm', 'left_pwm');
  const rightPwm = pick(row, 'rightPwm', 'right_pwm');
  const mode = pick(row, 'mode');
  const dtMs = pick(row, 'dtMs', 'dt_ms');
  const pidRevision = pick(row, 'pidRevision', 'pid_revision');
  const droppedFrames = pick(row, 'droppedFrames', 'dropped_frames');
  const droppedAcks = pick(row, 'droppedAcks', 'dropped_acks') ?? 0;
  const droppedEvents = pick(row, 'droppedEvents', 'dropped_events') ?? 0;

  if (typeof robotId !== 'string' || typeof bootId !== 'string' ||
      typeof receivedAt !== 'string' || !Number.isFinite(Date.parse(receivedAt)) ||
      !integer(sequence, 0, 0xffffffff) || !integer(uptimeMs, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(mask, 0, 31) || !nullableFinite(position, 0, 4) ||
      !integer(frontMask, 0, 31) || !nullableFinite(frontPosition, 0, 4) ||
      rearMask !== null && !integer(rearMask, 0, 31) ||
      !nullableFinite(rearPosition, 0, 4) ||
      !nullableFinite(error, -2, 2) || !finite(correction, -120, 120) ||
      !integer(leftPwm, -180, 180) || !integer(rightPwm, -180, 180) ||
      typeof mode !== 'string' || !MODES.has(mode) || !integer(dtMs, 1, 60000) ||
      !integer(pidRevision, 0, 0xffffffff) ||
      !integer(droppedFrames, 0, 0xffffffff) || !integer(droppedAcks, 0, 0xffffffff) ||
      !integer(droppedEvents, 0, 0xffffffff) || typeof controlSensor !== 'string' ||
      !['none', 'front', 'rear'].includes(controlSensor)) {
    return null;
  }
  if ((mask === 0) !== (position === null && error === null)) return null;
  if ((frontMask === 0) !== (frontPosition === null) ||
      (rearMask === null && rearPosition !== null) ||
      (rearMask !== null && (rearMask === 0) !== (rearPosition === null)) ||
      (controlSensor === 'none' &&
        (mask !== 0 || frontMask !== 0 || (rearMask !== null && rearMask !== 0) ||
          (controlSensorExplicit && rearMask !== 0))) ||
      (controlSensor === 'front' &&
        (mask === 0 || mask !== frontMask || position !== frontPosition)) ||
      (controlSensor === 'rear' &&
        (frontMask !== 0 || rearMask === null || mask === 0 || mask !== rearMask ||
          position !== rearPosition))) {
    return null;
  }

  return {
    robotId, bootId, sequence, receivedAt, uptimeMs, mask, position, error,
    frontMask, frontPosition, rearMask, rearPosition, controlSensor,
    correction, leftPwm, rightPwm, mode, dtMs, pidRevision,
    droppedFrames, droppedAcks, droppedEvents,
  };
}

/** @param {string[]} available @param {string} current */
export function chooseRobotId(available, current) {
  if (available.includes(current)) return current;
  return available.find(id => typeof id === 'string' && id.length > 0) ?? current;
}

/** @param {number} mask */
export function getSensorStates(mask) {
  if (!integer(mask, 0, 31)) return [false, false, false, false, false];
  return [0, 1, 2, 3, 4].map(index => (mask & (1 << index)) !== 0);
}

/** @param {number} frontMask @param {number | null} rearMask */
export function hasDualCenterLineCue(frontMask, rearMask) {
  return integer(frontMask, 0, 31) && rearMask !== null && integer(rearMask, 0, 31) &&
    (frontMask & (1 << 2)) !== 0 && (rearMask & (1 << 2)) !== 0;
}

/** @param {number} mask @param {number} index @param {boolean} hasSample */
export function getSensorState(mask, index, hasSample) {
  if (!hasSample || !integer(mask, 0, 31) || !integer(index, 0, 4)) return 'unknown';
  return (mask & (1 << index)) !== 0 ? 'line' : 'clear';
}

/** @param {{kp: string, ki: string, kd: string}} draft */
export function parseGainDraft(draft) {
  const gains = {
    kp: Number(draft.kp),
    ki: Number(draft.ki),
    kd: Number(draft.kd),
  };
  if (Object.entries(gains).some(([key, value]) =>
    !Number.isFinite(value) || value < 0 || value > GAIN_LIMITS[/** @type {keyof typeof GAIN_LIMITS} */ (key)])) {
    return null;
  }
  if (![draft.kp, draft.ki, draft.kd].every(value => value.trim() !== '')) return null;
  return gains;
}

/** @param {unknown} value */
export function normalizePidState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = /** @type {Record<string, unknown>} */ (value);
  const kp = pick(row, 'kp');
  const ki = pick(row, 'ki');
  const kd = pick(row, 'kd');
  const revision = pick(row, 'revision');
  const persisted = pick(row, 'persisted');
  const requestId = pick(row, 'requestId', 'request_id') ?? null;
  const receivedAt = pick(row, 'receivedAt', 'received_at') ?? null;
  if (!finite(kp, 0, GAIN_LIMITS.kp) || !finite(ki, 0, GAIN_LIMITS.ki) ||
      !finite(kd, 0, GAIN_LIMITS.kd) || !integer(revision, 0, 0xffffffff) ||
      typeof persisted !== 'boolean' && persisted !== 0 && persisted !== 1) return null;
  return { kp, ki, kd, revision, persisted: Boolean(persisted), requestId, receivedAt };
}

/** @param {unknown} value */
export function normalizeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = /** @type {Record<string, unknown>} */ (value);
  const state = pick(row, 'state');
  const wifi = pick(row, 'wifi') ?? null;
  const rssi = pick(row, 'rssi') ?? null;
  const receivedAt = pick(row, 'receivedAt', 'received_at') ?? null;
  if (state !== 'online' && state !== 'offline') return null;
  if (wifi !== null && typeof wifi !== 'string') return null;
  if (rssi !== null && !integer(rssi, -127, 0)) return null;
  return { state, wifi, rssi, receivedAt };
}

/** @param {unknown} value */
export function normalizePidAck(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = /** @type {Record<string, unknown>} */ (value);
  const requestId = pick(row, 'requestId', 'request_id');
  const status = pick(row, 'status');
  const revision = pick(row, 'revision', 'applied_revision');
  const reason = pick(row, 'reason') ?? null;
  if (typeof requestId !== 'string' || typeof status !== 'string' ||
      !ACK_STATUSES.has(status) || !integer(revision, 0, 0xffffffff) ||
      reason !== null && typeof reason !== 'string') return null;
  return { requestId, status, revision, reason };
}

export { GAIN_LIMITS };
