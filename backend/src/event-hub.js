const encoder = new TextEncoder();
const MAX_SSE_CLIENTS = 16;
const SSE_HIGH_WATER_MARK = 16;

export class EventHub {
  #clients = new Set();

  get clientCount() {
    return this.#clients.size;
  }

  createStream(robotId) {
    let client = null;
    const hub = this;
    return new ReadableStream({
      start(controller) {
        if (hub.#clients.size >= MAX_SSE_CLIENTS) {
          controller.error(new Error('sse_client_limit'));
          return;
        }
        client = { controller, robotId, closed: false };
        hub.#clients.add(client);
        controller.enqueue(encoder.encode(': connected\n\n'));
      },
      cancel() {
        if (client) hub.#remove(client);
      },
    }, { highWaterMark: SSE_HIGH_WATER_MARK });
  }

  publish(type, data) {
    const chunk = encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const client of this.#clients) {
      if (client.closed) continue;
      if (data?.robotId && client.robotId !== data.robotId) continue;
      if (client.controller.desiredSize !== null && client.controller.desiredSize <= 0) {
        try { client.controller.close(); } catch {}
        this.#remove(client);
        continue;
      }
      try {
        client.controller.enqueue(chunk);
      } catch {
        this.#remove(client);
      }
    }
  }

  heartbeat() {
    this.publish('heartbeat', { at: new Date().toISOString() });
  }

  close() {
    for (const client of this.#clients) {
      try { client.controller.close(); } catch {}
      client.closed = true;
    }
    this.#clients.clear();
  }

  #remove(client) {
    client.closed = true;
    this.#clients.delete(client);
  }
}
