import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TELEMETRY_CSV_COLUMNS,
  TELEMETRY_CSV_HEADER,
  csvFilename,
  escapeCsvCell,
  serializeTelemetryCsvRow,
} from '../src/telemetry-csv.js';

test('CSV header has a stable telemetry column order', () => {
  assert.deepEqual(TELEMETRY_CSV_COLUMNS, [
    'robot_id', 'boot_id', 'seq', 'received_at', 'uptime_ms', 'mask',
    'position', 'error', 'front_mask', 'front_position', 'rear_mask',
    'rear_position', 'control_sensor', 'correction', 'left_pwm', 'right_pwm',
    'mode', 'dt_ms', 'pid_revision', 'dropped_frames', 'dropped_acks',
    'dropped_events',
  ]);
  assert.equal(TELEMETRY_CSV_HEADER, `${TELEMETRY_CSV_COLUMNS.join(',')}\r\n`);
});

test('CSV escaping preserves nulls, quotes, newlines, and formula-like text', () => {
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell('a,"b"\r\nc'), '"a,""b""\r\nc"');
  assert.equal(escapeCsvCell('=1+1'), "'=1+1");
  assert.equal(escapeCsvCell('  @SUM(A1:A2)'), "'  @SUM(A1:A2)");
  assert.equal(escapeCsvCell('\u00a0=SUM(A1:A2)'), "'\u00a0=SUM(A1:A2)");
  assert.equal(escapeCsvCell(-2.5), '-2.5');
});

test('CSV row keeps nullable sensor readings empty and uses CRLF', () => {
  const line = serializeTelemetryCsvRow({
    robot_id: 'linebot-01', boot_id: 'boot-a', seq: 1,
    received_at: '2026-10-23T10:00:00.000Z', uptime_ms: 1000, mask: 0,
    position: null, error: null, front_mask: 0, front_position: null,
    rear_mask: 0, rear_position: null, control_sensor: 'none', correction: 0,
    left_pwm: 0, right_pwm: 0, mode: 'lost', dt_ms: 10,
    pid_revision: 0, dropped_frames: 0, dropped_acks: 0, dropped_events: 0,
  });
  assert.equal(line.split(',').length, TELEMETRY_CSV_COLUMNS.length);
  assert.ok(line.includes(',0,,,'));
  assert.ok(line.endsWith('\r\n'));
});

test('CSV filename sanitizes timestamps and keeps the robot ID safe', () => {
  assert.equal(
    csvFilename('linebot-01', '2026-10-23T09:00:00.000Z', '2026-10-23T10:00:00.000Z'),
    'linebot-01_telemetry_2026-10-23T09-00-00-000Z_2026-10-23T10-00-00-000Z.csv',
  );
});
