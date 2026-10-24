# Local MQTT-to-HTTP bridge

This small Node.js service subscribes to the local Mosquitto broker, validates robot messages, stores telemetry and PID command history in SQLite, and exposes HTTP/SSE endpoints for the React dashboard. It does not run the robot's control loop. The ESP32 continues tracking locally if this process, Wi-Fi, Mosquitto, or SQLite is unavailable.

## Local setup

Requirements: Node.js 20 LTS or newer supported by the pinned `better-sqlite3`, npm, and local Mosquitto tools (`mosquitto`, `mosquitto_passwd`). Start Mosquitto first using [`../infra/mosquitto/README.md`](../infra/mosquitto/README.md). The ESP32 must be provisioned with the broker's LAN address, not `127.0.0.1` or `.local`; `MQTT_URL` here is the address from the host running this backend.

From the repository root:

```sh
cp backend/.env.example backend/.env
```

Set `MQTT_PASSWORD` to the backend user's Mosquitto password. Keep `HTTP_HOST=127.0.0.1` for host-local use. The sample `ALLOWED_ORIGINS` matches the planned Vite development server. `DB_PATH=./data/telemetry.sqlite3` resolves from `backend/` and the service creates the directory automatically.

```sh
cd backend
npm ci
npm test
npm start
```

The integration test starts a temporary authenticated Mosquitto broker and exercises telemetry ingestion, SQLite deduplication, PID command delivery and persistence reconciliation. It requires the local Mosquitto executables noted above.

Health check: `GET http://127.0.0.1:3000/health`.

## HTTP API

- `GET /api/robots/:robotId/latest` — latest stored telemetry, device status, and PID state.
- `GET /api/robots/:robotId/telemetry?limit=100&cursor=<opaque-cursor>` — bounded telemetry history; limit is capped at 500. The response includes `nextCursor` (`null` when there are no more rows). A legacy `before=<ISO-time>` filter is also accepted for the first page.
- `GET /api/robots/:robotId/telemetry.csv/info?from=<UTC>&to=<UTC>` — validates an export interval and returns its effective UTC bounds and row count. `GET /api/robots/:robotId/telemetry.csv?from=<UTC>&to=<UTC>` streams matching SQLite telemetry as a CSV attachment; bounds must be millisecond ISO UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`), `from` is inclusive, `to` exclusive, and downloads are capped at 100,000 rows. A future `to` is capped to server time; each download snapshots its rows before streaming, and an empty download returns `204`.
- `GET /api/robots/:robotId/pid` — current device-reported PID state and recent command records.
- `POST /api/robots/:robotId/pid` — full-gain update `{ "kp": 12.5, "ki": 1, "kd": 0.15 }`. Requires an `Origin` in `ALLOWED_ORIGINS` and returns `202` with a request ID and `pending` status. There is no bearer-token authentication; keep the backend loopback-only and do not expose it to untrusted networks or users. Only device acknowledgements and retained PID state can confirm application/persistence; ACK transitions are monotonic, so late `applied` messages cannot overwrite `persisted` or terminal failure/rejection outcomes.
- `GET /api/robots/:robotId/events` — robot-scoped SSE stream (`telemetry`, `status`, `event`, `pid-state`, `pid-ack`) with heartbeat and bounded client/backpressure behavior.

Only IDs in `ROBOT_IDS` are accepted. Gains are bounded and finite, request bodies are capped, and MQTT payloads are capped at 512 bytes. The HTTP service refuses non-loopback binds and validates `Host` against loopback names/addresses; keep `HTTP_HOST=127.0.0.1`. PID writes rely on loopback binding plus the strict `Origin` allowlist, not authentication; local processes can call the API. A TLS/authenticated reverse proxy must rewrite its upstream `Host` to the loopback backend authority (for example `127.0.0.1:3000`). Keep port 1883 on a trusted private LAN with a firewall limited to the robot/backend subnet; the current ESP32 firmware uses plain MQTT and should not connect over untrusted networks.

SQLite uses WAL, prepared statements, deduplication keys and a configurable retention window (`RETENTION_DAYS`). Keep `backend/data/` local and back it up only if telemetry history matters. Credentials, database contents and generated broker files are ignored by Git; commit only the example templates.
