# Local React dashboard

The dashboard has no runtime font/CDN dependency, so the UI itself can load offline with local services. The Vite/React interface reads telemetry, robot status, PID state and history from the Hono bridge, and streams robot-scoped SSE updates. It does not send motor commands; PID writes only update gains through the protected backend API. The admin token is typed into the page for the current tab and kept in component memory only. It is never added to a Vite environment file or bundled build.

## Run locally

Use the broker and backend setup documented in `../infra/mosquitto/README.md` and `../backend/README.md`. Start the backend first, with `HTTP_HOST=127.0.0.1` and `ALLOWED_ORIGINS` including `http://127.0.0.1:5173` (the example also allows `http://localhost:5173`). Then run the UI in another terminal:

```sh
cd frontend
npm ci
npm test
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` and `/health` to the loopback backend at `127.0.0.1:3000`; no browser MQTT credentials or broker connection are used. Enter the local backend `ADMIN_TOKEN` in the PID panel before submitting gains. The UI displays device-confirmed gains separately from the editable draft and reports `pending`, `applied`, `persisted`, `rejected` or failed states.

The UI shows separate front and rear five-bit digital IR rows, ordered left-to-right (bit 0 is robot-left on both rows), plus line position/error, the selected control row, a straightness cue when both center sensors detect the line, PID correction, signed motor PWM, mode, control period, drop counts, Wi-Fi/MQTT status, and a bounded recent telemetry history. The cue is informational only. Legacy single-row telemetry is displayed as front-only. Data is marked stale after 2.5 seconds without a sample.

## Checks and build

```sh
npm test
npm run check
npm run build
npm audit
```

`npm run build` creates `dist/`. `npm run dev` includes the backend proxy; `npm run preview` is a static preview and does not proxy API traffic. To serve the built UI with the API, use a same-origin reverse proxy that forwards `/api` and `/health` to the loopback Hono process, or keep the Vite dev server for local development. Do not expose the backend directly: it enforces loopback binding. No physical ESP32 was available during software verification; use synthetic MQTT data for UI checks and complete the hardware acceptance in `plan.md` before driving.
