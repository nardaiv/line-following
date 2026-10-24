import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTelemetryCsvUrls,
  utcDateTimeInputValue,
} from './telemetry-export.js';

test('builds an exclusive UTC export range from UTC input fields', () => {
  assert.deepEqual(
    buildTelemetryCsvUrls(
      'linebot-01', '2026-10-23T10:00:00', '2026-10-23T11:00:00',
    ),
    {
      from: '2026-10-23T10:00:00.000Z',
      to: '2026-10-23T11:00:00.000Z',
      infoUrl: '/api/robots/linebot-01/telemetry.csv/info?from=2026-10-23T10%3A00%3A00.000Z&to=2026-10-23T11%3A00%3A00.000Z',
      csvUrl: '/api/robots/linebot-01/telemetry.csv?from=2026-10-23T10%3A00%3A00.000Z&to=2026-10-23T11%3A00%3A00.000Z',
    },
  );
});

test('rejects invalid, reversed, and malformed UTC export ranges', () => {
  assert.equal(buildTelemetryCsvUrls('linebot-01', 'not-a-date', '2026-10-23T11:00:00'), null);
  assert.equal(buildTelemetryCsvUrls('linebot-01', '2026-10-23T12:00:00', '2026-10-23T11:00:00'), null);
  assert.equal(buildTelemetryCsvUrls('linebot-01', '2026-02-30T10:00:00', '2026-03-01T11:00:00'), null);
});

test('formats default input values as UTC date-times without timezone conversion', () => {
  assert.equal(utcDateTimeInputValue(new Date('2026-10-23T10:20:30.000Z')), '2026-10-23T10:20:30');
});

test('preserves the backend-captured UTC upper bound', () => {
  const range = buildTelemetryCsvUrls(
    'linebot-01',
    '2026-10-23T10:00:00.000Z',
    '2026-10-23T10:20:00.000Z',
  );
  assert.equal(range.to, '2026-10-23T10:20:00.000Z');
});
