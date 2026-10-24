export async function shutdownRuntime({ server, eventHub, mqttBridge, database }) {
  const serverClosed = new Promise((resolve, reject) => {
    try {
      server.close(error => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });

  eventHub.close();
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
  const results = await Promise.allSettled([
    Promise.resolve().then(() => mqttBridge.close()),
    serverClosed,
  ]);
  database.close();
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
