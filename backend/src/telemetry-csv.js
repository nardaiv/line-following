const COLUMNS = [
  'robot_id', 'boot_id', 'seq', 'received_at', 'uptime_ms', 'mask',
  'position', 'error', 'front_mask', 'front_position', 'rear_mask',
  'rear_position', 'control_sensor', 'correction', 'left_pwm', 'right_pwm',
  'mode', 'dt_ms', 'pid_revision', 'dropped_frames', 'dropped_acks',
  'dropped_events',
];

export const TELEMETRY_CSV_COLUMNS = Object.freeze(COLUMNS);
export const TELEMETRY_CSV_HEADER = `${COLUMNS.join(',')}\r\n`;

export function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^\s*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function serializeTelemetryCsvRow(row) {
  return `${COLUMNS.map(column => escapeCsvCell(row[column])).join(',')}\r\n`;
}

function safeFilenamePart(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-');
}

export function csvFilename(robotId, from, to) {
  const safeRobotId = safeFilenamePart(robotId) || 'robot';
  const safeFrom = safeFilenamePart(from);
  const safeTo = safeFilenamePart(to);
  return `${safeRobotId}_telemetry_${safeFrom}_${safeTo}.csv`;
}
