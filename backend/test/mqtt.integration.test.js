import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt from 'mqtt';

import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { EventHub } from '../src/event-hub.js';
import { startMqttBridge } from '../src/mqtt-bridge.js';

const ROBOT_ID = 'linebot-01';
const ADMIN_TOKEN = 't'.repeat(40);

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForPort(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(100);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for Mosquitto listener');
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function publish(client, topic, value, options = { qos: 0, retain: false }) {
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(value), options, error => error ? reject(error) : resolve());
  });
}

function connect(client) {
  return new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
}

test('local Mosquitto -> Hono -> SQLite ingests, deduplicates and reconciles PID status', async t => {
  const port = await getFreePort();
  const work = await mkdtemp(join(tmpdir(), 'linebot-mqtt-test-'));
  const brokerConfig = join(work, 'mosquitto.conf');
  const passwordFile = join(work, 'passwd');
  const aclFile = join(work, 'acl');
  const dataDirectory = join(work, 'data');
  const backendPassword = randomBytes(24).toString('hex');
  const devicePassword = randomBytes(24).toString('hex');
  let result = spawnSync('mosquitto_passwd',
    ['-c', '-b', passwordFile, 'backend', backendPassword], { stdio: 'ignore' });
  assert.equal(result.status, 0, 'create temporary backend broker user');
  result = spawnSync('mosquitto_passwd',
    ['-b', passwordFile, ROBOT_ID, devicePassword], { stdio: 'ignore' });
  assert.equal(result.status, 0, 'create temporary device broker user');
  await mkdir(dataDirectory);
  const aclTemplate = await readFile(
    new URL('../../infra/mosquitto/acl.example', import.meta.url), 'utf8',
  );
  await writeFile(aclFile, aclTemplate);
  const configTemplate = await readFile(
    new URL('../../infra/mosquitto/mosquitto.conf.example', import.meta.url), 'utf8',
  );
  const testBrokerConfig = configTemplate
    .replace('listener 1883 127.0.0.1', `listener ${port} 127.0.0.1`)
    .replace('./passwd', passwordFile)
    .replace('./acl', aclFile)
    .replace('./data/', `${dataDirectory}/`);
  await writeFile(brokerConfig, testBrokerConfig);
  const startBroker = () => spawn('mosquitto', ['-c', brokerConfig], {
    cwd: work,
    stdio: 'ignore',
  });
  let broker = startBroker();
  const database = createDatabase(':memory:');
  const eventHub = new EventHub();
  const acknowledgementEvents = [];
  const publishEvent = eventHub.publish.bind(eventHub);
  eventHub.publish = (type, data) => {
    if (type === 'pid-ack') acknowledgementEvents.push(data);
    publishEvent(type, data);
  };
  const config = {
    mqttUrl: `mqtt://127.0.0.1:${port}`,
    mqttUsername: 'backend',
    mqttPassword: backendPassword,
    robotIds: [ROBOT_ID],
    adminToken: ADMIN_TOKEN,
    allowedOrigins: ['http://localhost:5173'],
  };
  let bridge;
  let device;
  t.after(async () => {
    if (device) await new Promise(resolve => device.end(true, {}, resolve));
    if (bridge) await bridge.close();
    eventHub.close();
    database.close();
    if (broker?.exitCode === null) {
      broker.kill('SIGTERM');
      await new Promise(resolve => broker.once('exit', resolve));
    }
    await rm(work, { recursive: true, force: true });
  });

  await waitForPort(port);

  bridge = startMqttBridge({ config, database, eventHub });
  await waitFor(() => bridge.metrics.connected, 'backend MQTT connection');
  device = mqtt.connect(config.mqttUrl, {
    clientId: 'phase3-test-device',
    username: ROBOT_ID,
    password: devicePassword,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 250,
  });
  await connect(device);
  const pidSetTopic = `robots/${ROBOT_ID}/pid/set`;
  let receivedCommand;
  device.subscribe(pidSetTopic, { qos: 1 });
  device.on('message', (topic, payload, packet) => {
    if (topic === pidSetTopic) {
      receivedCommand = { body: JSON.parse(payload.toString()), packet };
    }
  });

  const telemetryTopic = `robots/${ROBOT_ID}/telemetry`;
  const telemetry = {
    v: 1, robotId: ROBOT_ID, bootId: 'boot-test-a', seq: 1,
    uptimeMs: 1500, mask: 4, position: 2, error: 0, correction: 0,
    leftPwm: 75, rightPwm: 75, mode: 'track', dtMs: 10,
    pidRevision: 0, droppedFrames: 0, droppedAcks: 0, droppedEvents: 0,
  };
  await publish(device, telemetryTopic, telemetry);
  await waitFor(() => database.latestTelemetry(ROBOT_ID)?.seq === 1, 'SQLite telemetry row');
  await publish(device, telemetryTopic, telemetry);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(database.raw.prepare('SELECT count(*) AS n FROM telemetry').get().n, 1);

  const pidStateTopic = `robots/${ROBOT_ID}/pid/state`;
  await publish(device, pidStateTopic, {
    v: 1, robotId: ROBOT_ID, kp: 12.5, ki: 1, kd: 0.15,
    revision: 0, persisted: true,
  }, { qos: 1, retain: true });
  await waitFor(() => database.latestPidState(ROBOT_ID)?.revision === 0, 'initial PID state');

  const app = createApp({ config, database, mqttBridge: bridge, eventHub });
  const response = await app.request(`/api/robots/${ROBOT_ID}/pid`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      host: '127.0.0.1:3000',
      origin: 'http://localhost:5173',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ kp: 10, ki: 1, kd: 0.1 }),
  });
  assert.equal(response.status, 202);
  const pending = await response.json();
  await waitFor(() => receivedCommand !== undefined, 'device PID set delivery');
  assert.equal(receivedCommand.body.requestId, pending.requestId);
  assert.equal(receivedCommand.body.baseRevision, 0);
  assert.equal(receivedCommand.packet.retain, false);
  assert.equal(receivedCommand.packet.qos, 1);

  await publish(device, `robots/${ROBOT_ID}/pid/ack`, {
    v: 1, robotId: ROBOT_ID, requestId: pending.requestId,
    status: 'applied', revision: 1,
  }, { qos: 1, retain: false });
  await publish(device, pidStateTopic, {
    v: 1, robotId: ROBOT_ID, kp: 10, ki: 1, kd: 0.1,
    revision: 1, requestId: pending.requestId, persisted: true,
  }, { qos: 1, retain: true });
  await waitFor(() => database.pidCommands(ROBOT_ID)[0]?.status === 'persisted',
                'PID command state reconciliation');
  assert.equal(acknowledgementEvents.length, 1);
  await publish(device, `robots/${ROBOT_ID}/pid/ack`, {
    v: 1, robotId: ROBOT_ID, requestId: pending.requestId,
    status: 'applied', revision: 1,
  }, { qos: 1, retain: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(database.pidCommands(ROBOT_ID)[0]?.status, 'persisted');
  assert.equal(acknowledgementEvents.length, 1);

  const latestResponse = await app.request(`/api/robots/${ROBOT_ID}/latest`, {
    headers: { host: '127.0.0.1:3000' },
  });
  const latest = await latestResponse.json();
  assert.equal(latest.telemetry.boot_id, 'boot-test-a');
  assert.equal(latest.pid.persisted, true);
  assert.equal(latest.pid.revision, 1);

  const stoppedBroker = broker;
  broker = undefined;
  await new Promise(resolve => {
    if (stoppedBroker.exitCode !== null) return resolve();
    stoppedBroker.once('exit', resolve);
    stoppedBroker.kill('SIGTERM');
  });
  await waitFor(() => !bridge.metrics.connected && !device.connected,
                'clients to observe broker outage');
  broker = startBroker();
  await waitForPort(port);
  await waitFor(() => bridge.metrics.connected && device.connected,
                'MQTT clients to reconnect');
  await publish(device, telemetryTopic, { ...telemetry, seq: 2, uptimeMs: 1600 });
  await waitFor(() => database.latestTelemetry(ROBOT_ID)?.seq === 2,
                'telemetry ingestion after broker recovery');
});
