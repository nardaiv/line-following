import mqtt from 'mqtt';

import {
  parseControlEvent,
  parseJsonPayload,
  parsePidAck,
  parsePidState,
  parseStatus,
  parseTelemetry,
} from './validation.js';

const TOPIC_RE = /^robots\/([A-Za-z0-9_-]{1,32})\/(telemetry|status|event|pid\/state|pid\/ack)$/;

export function startMqttBridge({ config, database, eventHub, logger = console }) {
  const allowedRobots = new Set(config.robotIds);
  const metrics = { connected: false, invalidMessages: 0, ignoredMessages: 0 };
  const subscriptions = config.robotIds.flatMap(robotId => [
    `robots/${robotId}/telemetry`,
    `robots/${robotId}/status`,
    `robots/${robotId}/event`,
    `robots/${robotId}/pid/state`,
    `robots/${robotId}/pid/ack`,
  ]);
  const client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    clientId: `linebot-backend-${process.pid}`,
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    connectTimeout: 5000,
    reconnectPeriod: 1000,
    resubscribe: true,
  });

  client.on('connect', () => {
    metrics.connected = true;
    client.subscribe(subscriptions, { qos: 1 }, error => {
      if (error) logger.error('MQTT subscribe failed:', error.message);
    });
    eventHub.publish('connection', { mqtt: 'connected' });
  });
  client.on('reconnect', () => {
    metrics.connected = false;
    eventHub.publish('connection', { mqtt: 'reconnecting' });
  });
  client.on('close', () => {
    metrics.connected = false;
    eventHub.publish('connection', { mqtt: 'disconnected' });
  });
  client.on('error', error => {
    metrics.connected = false;
    logger.error('MQTT client error:', error.message);
  });

  client.on('message', (topic, buffer) => {
    const topicMatch = TOPIC_RE.exec(topic);
    if (!topicMatch) {
      metrics.ignoredMessages += 1;
      return;
    }
    const [, robotId, kind] = topicMatch;
    if (!allowedRobots.has(robotId) || buffer.length > 512) {
      metrics.ignoredMessages += 1;
      return;
    }
    const receivedAt = new Date().toISOString();
    try {
      const payload = parseJsonPayload(buffer);
      if (kind === 'telemetry') {
        const row = parseTelemetry(payload, robotId, receivedAt);
        const inserted = database.insertTelemetry(row);
        if (inserted) eventHub.publish('telemetry', row);
      } else if (kind === 'status') {
        const status = parseStatus(payload, robotId, receivedAt);
        database.upsertStatus(status);
        eventHub.publish('status', status);
      } else if (kind === 'event') {
        const event = parseControlEvent(payload, robotId, receivedAt);
        const inserted = database.insertEvent(event);
        if (inserted) eventHub.publish('event', event);
      } else if (kind === 'pid/state') {
        const state = parsePidState(payload, robotId, receivedAt);
        database.upsertPidState(state);
        if (state.requestId) database.reconcilePidState(state);
        eventHub.publish('pid-state', state);
      } else if (kind === 'pid/ack') {
        const acknowledgement = parsePidAck(payload, robotId, receivedAt);
        const updated = database.updatePidAck(acknowledgement);
        if (updated) eventHub.publish('pid-ack', acknowledgement);
      }
    } catch (error) {
      metrics.invalidMessages += 1;
      logger.warn('Rejected MQTT payload', {
        topic,
        reason: error?.message || 'invalid_payload',
      });
    }
  });

  function publishPidCommand(robotId, payload) {
    if (!allowedRobots.has(robotId)) return Promise.reject(new Error('unknown_robot'));
    if (!client.connected) return Promise.reject(new Error('mqtt_disconnected'));
    const topic = `robots/${robotId}/pid/set`;
    return new Promise((resolve, reject) => {
      client.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function close() {
    return new Promise(resolve => client.end(true, {}, resolve));
  }

  return { client, metrics, publishPidCommand, close };
}
