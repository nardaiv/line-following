import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { cors } from 'hono/cors';
import { Hono } from 'hono';

import { PayloadError, validatePidPost } from './validation.js';

function isAuthorized(header, expectedToken) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isAllowedRobot(config, robotId) {
  return config.robotIds.includes(robotId);
}

function isAllowedHost(hostHeader, config) {
  if (typeof hostHeader !== 'string' || hostHeader.length > 255 ||
      hostHeader.trim() !== hostHeader || /[\\/?#@]/.test(hostHeader)) return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  const configuredHost = (config.httpHost || '127.0.0.1').toLowerCase().replace(/^\\[|\\]$/g, '');
  return hostname === configuredHost || hostname === 'localhost' || hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
}

function parseLimit(value) {
  if (value === undefined || value === '') return 100;
  if (!/^\d+$/.test(value)) throw new PayloadError('invalid_limit');
  const limit = Number(value);
  if (limit < 1 || limit > 500) throw new PayloadError('limit_out_of_range');
  return limit;
}

function parseBefore(value) {
  if (value === undefined || value === '') return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new PayloadError('invalid_before');
  return new Date(timestamp).toISOString();
}

function parseCursor(value) {
  if (value === undefined || value === '') return null;
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PayloadError('invalid_cursor');
  }
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const receivedAt = parseBefore(cursor.receivedAt);
    if (receivedAt !== cursor.receivedAt ||
        !Number.isInteger(cursor.seq) || cursor.seq < 0 || cursor.seq > 0xffffffff ||
        typeof cursor.bootId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(cursor.bootId)) {
      throw new PayloadError('invalid_cursor');
    }
    return { receivedAt, seq: cursor.seq, bootId: cursor.bootId };
  } catch (error) {
    if (error instanceof PayloadError) throw error;
    throw new PayloadError('invalid_cursor');
  }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    receivedAt: row.received_at,
    seq: row.seq,
    bootId: row.boot_id,
  })).toString('base64url');
}

function clientOriginAllowed(origin, config) {
  return !origin || config.allowedOrigins.includes(origin);
}

async function readJsonLimited(request, maxBytes) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) throw new PayloadError('invalid_content_length');
    if (Number(declaredLength) > maxBytes) throw new PayloadError('body_too_large');
  }
  if (!request.body) throw new PayloadError('invalid_json');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PayloadError('body_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new PayloadError('invalid_json');
  }
}

export function createApp({ config, database, mqttBridge, eventHub, clock = () => new Date() }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (!isAllowedHost(c.req.header('host'), config)) return c.text('Invalid Host header', 400);
    await next();
  });
  app.use('/api/*', cors({
    origin: origin => config.allowedOrigins.includes(origin) ? origin : '',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  }));

  app.get('/health', c => c.json({
    ok: true,
    mqttConnected: mqttBridge.metrics.connected,
    databaseOpen: database.raw.open,
    robots: config.robotIds,
  }));

  app.get('/api/robots/:robotId/latest', c => {
    const robotId = c.req.param('robotId');
    if (!isAllowedRobot(config, robotId)) return c.json({ error: 'unknown_robot' }, 404);
    return c.json({
      telemetry: database.latestTelemetry(robotId),
      status: database.latestStatus(robotId),
      pid: database.latestPidState(robotId),
    });
  });

  app.get('/api/robots/:robotId/telemetry', c => {
    const robotId = c.req.param('robotId');
    if (!isAllowedRobot(config, robotId)) return c.json({ error: 'unknown_robot' }, 404);
    try {
      const limit = parseLimit(c.req.query('limit'));
      const before = parseBefore(c.req.query('before'));
      const cursor = parseCursor(c.req.query('cursor'));
      if (before !== null && cursor !== null) throw new PayloadError('cursor_conflict');
      const rows = database.telemetryPage(robotId, cursor ?? before, limit + 1);
      const hasMore = rows.length > limit;
      const telemetry = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = telemetry.at(-1);
      return c.json({
        telemetry,
        nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
      });
    } catch (error) {
      return c.json({ error: error.message }, 400);
    }
  });

  app.get('/api/robots/:robotId/pid', c => {
    const robotId = c.req.param('robotId');
    if (!isAllowedRobot(config, robotId)) return c.json({ error: 'unknown_robot' }, 404);
    return c.json({
      state: database.latestPidState(robotId),
      commands: database.pidCommands(robotId),
    });
  });

  app.post('/api/robots/:robotId/pid', async c => {
    const robotId = c.req.param('robotId');
    if (!isAllowedRobot(config, robotId)) return c.json({ error: 'unknown_robot' }, 404);
    if (!clientOriginAllowed(c.req.header('Origin'), config)) {
      return c.json({ error: 'origin_denied' }, 403);
    }
    if (!isAuthorized(c.req.header('Authorization'), config.adminToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let gains;
    try {
      gains = validatePidPost(await readJsonLimited(c.req.raw, 1024));
    } catch (error) {
      const status = error?.message === 'body_too_large'
        ? 413
        : error instanceof PayloadError || error instanceof SyntaxError ? 400 : 500;
      return c.json({ error: status < 500 ? error.message : 'invalid_request' }, status);
    }

    const current = database.latestPidState(robotId);
    if (!current) return c.json({ error: 'pid_state_unavailable' }, 503);
    if (!mqttBridge.metrics.connected) return c.json({ error: 'mqtt_disconnected' }, 503);

    const requestId = randomUUID();
    const requestedAt = clock().toISOString();
    const command = {
      v: 1,
      requestId,
      baseRevision: current.revision,
      kp: gains.kp,
      ki: gains.ki,
      kd: gains.kd,
    };
    database.createPidCommand({ robotId, requestId, ...gains, baseRevision: current.revision, requestedAt });
    try {
      await mqttBridge.publishPidCommand(robotId, command);
    } catch {
      database.updatePublishFailure({
        robotId,
        requestId,
        reason: 'broker_publish_failed',
        updatedAt: clock().toISOString(),
      });
      return c.json({ error: 'mqtt_publish_failed', requestId }, 503);
    }
    return c.json({ requestId, baseRevision: current.revision, status: 'pending' }, 202);
  });

  app.get('/api/robots/:robotId/events', c => {
    const robotId = c.req.param('robotId');
    if (!isAllowedRobot(config, robotId)) return c.json({ error: 'unknown_robot' }, 404);
    if (eventHub.clientCount >= 16) return c.json({ error: 'sse_client_limit' }, 503);
    let stream;
    try {
      stream = eventHub.createStream(robotId);
    } catch {
      return c.json({ error: 'sse_unavailable' }, 503);
    }
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  app.onError((error, c) => {
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}

export { isAuthorized, parseBefore, parseLimit };
