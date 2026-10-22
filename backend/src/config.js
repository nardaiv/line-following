import { isIP } from 'node:net';
import { URL } from 'node:url';

const ROBOT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function requiredString(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} must be set in backend/.env`);
  return value;
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' ||
    (isIP(host) === 4 && host.split('.')[0] === '127');
}

export function validateEnvironment(env) {
  const mqttUrl = requiredString(env, 'MQTT_URL');
  const mqttParsed = new URL(mqttUrl);
  if (!['mqtt:', 'mqtts:'].includes(mqttParsed.protocol)) {
    throw new Error('MQTT_URL must use mqtt:// or mqtts://');
  }
  const mqttUsername = requiredString(env, 'MQTT_USERNAME');
  const mqttPassword = requiredString(env, 'MQTT_PASSWORD');
  const dbPath = requiredString(env, 'DB_PATH');
  const httpHost = env.HTTP_HOST?.trim() || '127.0.0.1';
  const httpPort = Number(env.HTTP_PORT || 3000);
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error('HTTP_PORT must be an integer from 1 to 65535');
  }
  const adminToken = requiredString(env, 'ADMIN_TOKEN');
  if (Buffer.byteLength(adminToken) < 32) {
    throw new Error('ADMIN_TOKEN must contain at least 32 bytes');
  }
  const robotIds = [...new Set(requiredString(env, 'ROBOT_IDS').split(',').map(x => x.trim()))];
  if (robotIds.length === 0 || robotIds.some(id => !ROBOT_ID_RE.test(id))) {
    throw new Error('ROBOT_IDS must be comma-separated safe robot IDs');
  }
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',').map(x => x.trim()).filter(Boolean);
  if (allowedOrigins.includes('*')) throw new Error('ALLOWED_ORIGINS cannot contain *');
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Invalid origin in ALLOWED_ORIGINS: ${origin}`);
    }
  }
  if (!isLoopbackHost(httpHost)) {
    throw new Error('HTTP_HOST must be a loopback address; use a TLS proxy/VPN for remote access');
  }
  const retentionDays = Number(env.RETENTION_DAYS || 30);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error('RETENTION_DAYS must be an integer from 1 to 3650');
  }
  return {
    mqttUrl,
    mqttUsername,
    mqttPassword,
    dbPath,
    httpHost,
    httpPort,
    adminToken,
    allowedOrigins,
    robotIds,
    retentionDays,
  };
}

export { ROBOT_ID_RE };
