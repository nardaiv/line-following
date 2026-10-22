import { serve } from '@hono/node-server';

import dotenv from 'dotenv';
import { createApp } from './app.js';
import { validateEnvironment } from './config.js';
import { createDatabase } from './database.js';
import { EventHub } from './event-hub.js';
import { startMqttBridge } from './mqtt-bridge.js';
import { shutdownRuntime } from './shutdown.js';

dotenv.config();
const config = validateEnvironment(process.env);
const database = createDatabase(config.dbPath);
const eventHub = new EventHub();
const mqttBridge = startMqttBridge({ config, database, eventHub });
const app = createApp({ config, database, mqttBridge, eventHub });
const server = serve({
  fetch: app.fetch,
  hostname: config.httpHost,
  port: config.httpPort,
});

const prune = () => {
  const cutoff = new Date(Date.now() - config.retentionDays * 86400000).toISOString();
  database.pruneBefore(cutoff);
};
prune();
const retentionTimer = setInterval(prune, 60 * 60 * 1000);
retentionTimer.unref();
const heartbeatTimer = setInterval(() => eventHub.heartbeat(), 15000);
heartbeatTimer.unref();

console.log(`Bridge listening at http://${config.httpHost}:${config.httpPort}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${signal})`);
  clearInterval(retentionTimer);
  clearInterval(heartbeatTimer);
  const forceExit = setTimeout(() => process.exit(1), 3000);
  forceExit.unref();
  try {
    await shutdownRuntime({ server, eventHub, mqttBridge, database });
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    console.error('Shutdown failed:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
