# ESP32-S3 Line Follower

The ESP32 handles steering locally. Mosquitto, the Node backend, and the web dashboard provide optional telemetry, CSV export, and PID tuning; they are not required for the robot to follow a line.

## Requirements

- ESP32-S3 DevKitC-1 and PlatformIO (CLI or VS Code extension)
- Node.js 20+ and npm
- Mosquitto (`mosquitto`, `mosquitto_passwd`)
- Python 3 and `pyserial` for USB provisioning

## 1. Set up Mosquitto and the backend

From the repository root, create local config files and the broker data directory.

Linux/macOS:

```sh
cp infra/mosquitto/mosquitto.conf.example infra/mosquitto/mosquitto.conf.local
cp infra/mosquitto/acl.example infra/mosquitto/acl
mkdir -p infra/mosquitto/data
cp backend/.env.example backend/.env
```

Windows PowerShell:

```powershell
Copy-Item infra\mosquitto\mosquitto.conf.example infra\mosquitto\mosquitto.conf.local
Copy-Item infra\mosquitto\acl.example infra\mosquitto\acl
New-Item -ItemType Directory -Force infra\mosquitto\data
Copy-Item backend\.env.example backend\.env
```

Edit `infra/mosquitto/mosquitto.conf.local`: bind the listener to the broker host's LAN IPv4 address so the ESP32 can reach it. Restrict port 1883 to the trusted robot/backend network; never expose it to the internet. Keep the broker config, password file, ACL, and `backend/.env` private and untracked.

Create separate device and backend broker accounts. Run from `infra/mosquitto`; both commands prompt for the password:

```sh
mosquitto_passwd -c passwd linebot-01
mosquitto_passwd passwd backend
```

Set `MQTT_URL` to the same address as the Mosquitto listener (use its LAN IPv4 if the listener is bound there), `MQTT_USERNAME=backend`, and `MQTT_PASSWORD` to that account's password. Keep `HTTP_HOST=127.0.0.1`; set `ROBOT_IDS` and `ALLOWED_ORIGINS` to match your robot and dashboard. The ESP32 must use the broker's LAN address, not `localhost` or `.local`.

## 2. Build, flash, and provision the robot

Create a Python environment and install PlatformIO plus the USB provisioning dependency.

Linux/macOS:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install platformio
python -m pip install -r tools/requirements.txt
```

Windows PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install platformio
python -m pip install -r tools\requirements.txt
```

From `hardware/`, build/test and flash:

```sh
python -m platformio test -e native
python -m platformio run -e esp32s3
python -m platformio run -e esp32s3 -t upload --upload-port <PORT>
```

Use `/dev/ttyACM0` or `/dev/ttyUSB0` on Linux, `/dev/cu.usbmodem*` on macOS, and `COM5` (or the assigned port) on Windows. From the repository root, provision once:

```sh
python tools/provision.py --port <PORT> --mode configure
```

Follow the prompt to press and release EN/RESET. Wi-Fi and MQTT settings are stored in ESP32 NVS; changing them does not require a rebuild. Use `--mode info` to check configuration and sensor masks without printing credentials. USB provisioning is not encrypted (hex is framing only) and NVS is not encrypted by default; use a trusted host/cable and do not save or share serial logs.

Sensor pins are ordered robot-left to robot-right: front `40, 39, 38, 37, 36`; rear `21, 47, 9, 8, 18`. Verify pin exposure on your board revision (especially GPIO47) and confirm sensor outputs are 3.3 V-safe before wiring. Both rows default to active-low.

## 3. Start the services

Run each command in a separate terminal, in this order. On Windows use `Set-Location` with backslash paths; the service commands are otherwise the same.

Terminal 1 — Mosquitto (working directory must be `infra/mosquitto` because config paths are relative):

```sh
cd infra/mosquitto
mosquitto -c mosquitto.conf.local -v
```

Terminal 2 — backend:

```sh
cd backend
npm ci
npm start
```

Terminal 3 — dashboard:

```sh
cd frontend
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Check the backend with `http://127.0.0.1:3000/health`. The dashboard connects to the backend, not directly to MQTT. Then power/reset the robot; keep the wheels lifted for initial checks and use a physical cutoff for track tests.

PID writes have no bearer-token authentication. They require an `Origin` listed in `ALLOWED_ORIGINS`, but that is not authentication—a local process can forge the header. Keep the backend loopback-only and do not expose it to untrusted local users or networks.

## Platform notes

- Install Mosquitto and add its executable directory to `PATH`; on Windows this may require adding the Mosquitto install folder. Restrict broker files with Windows file permissions; on Linux/macOS, use `chmod 0700 infra/mosquitto/acl`.
- Use `py -3` to select Python on Windows if `python` is not on `PATH`; after activating `.venv`, `python` works on all platforms.
- Install dependencies separately on each OS with `npm ci`. Do not copy `node_modules` between Windows, macOS, and Linux: the backend uses the native `better-sqlite3` addon.
- The USB port name differs by OS as listed above. PlatformIO upload commands otherwise remain the same; native tests require a working C++ compiler (including on Windows).

## Tests

Run from the indicated directory: `backend/` — `npm test`; `frontend/` — `npm test` and `npm run build`; `hardware/` — `python -m platformio test -e native`.
