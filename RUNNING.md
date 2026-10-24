# Running the ESP32-S3 Line Follower

This guide starts the local broker, backend, dashboard, and robot. Run the host services in separate terminals and keep them running while using the dashboard.

## One-time setup

Requirements: Python 3, Node.js 20 LTS or newer supported by the backend dependencies, npm, PlatformIO, and Mosquitto.

From the repository root, install the host-side Python tools and PlatformIO if they are not already installed:

```sh
python -m venv .venv
source .venv/bin/activate
python -m pip install platformio
python -m pip install -r tools/requirements.txt
```

The Python provisioning utility is only for USB setup; the ESP32 firmware is C++.

### Configure Mosquitto

Create the local broker files once:

```sh
cp infra/mosquitto/mosquitto.conf.example infra/mosquitto/mosquitto.conf.local
cp infra/mosquitto/acl.example infra/mosquitto/acl
mkdir -p infra/mosquitto/data
```

Edit `infra/mosquitto/mosquitto.conf.local`: change the listener from `127.0.0.1` to the broker computer's actual LAN IPv4 address. Use that same address in the ESP32 provisioning and backend `.env`. Do not use `localhost`, `.local`, or `0.0.0.0`; restrict TCP port 1883 to the trusted local network and never expose it to the internet.

Create two Mosquitto accounts. These commands prompt for passwords; do not put password values in this file or in chat:

```sh
cd infra/mosquitto
mosquitto_passwd -c passwd linebot-01
mosquitto_passwd passwd backend
chmod 0700 acl
```

If you change the robot ID, update the matching ACL entries and `ROBOT_IDS` in `backend/.env`.

### Configure the backend

From the repository root, create the ignored local file:

```sh
cp backend/.env.example backend/.env
```

Set these values in `backend/.env`:

- `MQTT_URL=mqtt://<broker-LAN-IPv4>:1883`
- `MQTT_USERNAME=backend`
- `MQTT_PASSWORD` to the password created for the Mosquitto `backend` account
- `ROBOT_IDS=linebot-01`
- Keep `HTTP_HOST=127.0.0.1` for local use

Keep `backend/.env`, the Mosquitto `passwd` file, and real credentials private and untracked.

### Dual-row sensor wiring

The firmware samples two independent five-channel digital rows. Connect each row left-to-right from the robot's forward-facing perspective; bit 0 is the robot-left sensor on both rows:

| Row | Robot-left to robot-right GPIOs |
| --- | --- |
| Front (existing) | `40, 39, 38, 37, 36` |
| Rear (added) | `21, 47, 9, 8, 18` |

The rear GPIO order is the pin map supplied for this robot. Confirm every pin is actually exposed and unused on the exact ESP32-S3 board/revision, especially GPIO47, before wiring. Both rows default to active-low detection (`FRONT_SENSOR_LINE_ACTIVE_LOW` and `REAR_SENSOR_LINE_ACTIVE_LOW` in `hardware/include/config.h`); verify each board's polarity and set its constant independently if needed. Confirm the sensor outputs are 3.3 V-compatible and share ground with the ESP32. Do not connect a 5 V output directly to an ESP32 GPIO; check the module output circuit before adding pull-ups or level shifting.

During ordinary tracking, the front row is primary and the rear row is a fallback when the front is clear. Turn direction and the corner-pivot trigger use only the front row; a confirmed corner pivots after the front row is clear for two samples, even if the rear row still sees the old line. Pivot reacquisition also requires the front row. The dashboard shows a “STRAIGHT CUE” when both center sensors detect the line; this is diagnostic only and does not override motor control. The two masks are never merged into a ten-bit position.

### Build and flash firmware

With the robot safely supported and wheels lifted, from the repository root:

```sh
source .venv/bin/activate
cd hardware
python -m platformio test -e native
python -m platformio run -e esp32s3
python -m platformio run -e esp32s3 -t upload --upload-port /dev/ttyACM0
```

Replace `/dev/ttyACM0` if your board uses a different port; Windows ports look like `COM5`. The upload command builds and flashes the ESP32-S3 firmware. Do not use a full-flash erase for a normal update.

### Provision Wi-Fi and MQTT once

If the ESP32 has not already been configured, open a terminal at the repository root (or run `cd ..` first if you are still in `hardware/`), activate the project environment, and run:

```sh
source .venv/bin/activate
python tools/provision.py --port /dev/ttyACM0 --mode configure
```

Enter the Wi-Fi details, the broker's LAN IPv4 address, port `1883`, MQTT username `linebot-01`, its Mosquitto password, and robot ID `linebot-01`. The utility stores these settings in ESP32 NVS, so changing them does not require recompiling. At its reset prompt, press and release the board's EN/RESET button, then press Enter in the terminal. Keep the robot's wheels lifted. If settings are already stored, do not run configure again unless they changed.

To read non-secret status and both sensor-row snapshots:

```sh
source .venv/bin/activate
python tools/provision.py --port /dev/ttyACM0 --mode info
```

At the prompt, press and release EN/RESET, then press Enter. `sensorMask` is the five-bit front-row snapshot and `rearSensorMask` is the five-bit rear-row snapshot; bit 0 is the robot-left sensor in each. These are single snapshots during the startup window. The dashboard shows both rows from live telemetry.

## Normal startup

Start each service in its own terminal, in this order.

Terminal 1 — Mosquitto:

```sh
cd infra/mosquitto
mosquitto -c mosquitto.conf.local -v
```

Terminal 2 — backend:

```sh
cd backend
npm ci       # first run only, or after dependencies change
npm start
```

Terminal 3 — dashboard:

```sh
cd frontend
npm ci       # first run only, or after dependencies change
npm run dev
```

Terminal 4 — verify the backend:

```sh
curl http://127.0.0.1:3000/health
```

A healthy response should show `ok: true`, `mqttConnected: true`, `databaseOpen: true`, and the configured robot ID.

Open `http://127.0.0.1:5173`. The robot connects automatically when it is powered on or reset and its saved Wi-Fi/MQTT settings are valid. The dashboard can submit PID changes from an origin listed in `ALLOWED_ORIGINS`; it does not send motor commands. The backend has no admin-token authentication, so keep it loopback-only and do not expose it to untrusted local users or networks.

## NVS persistence when updating firmware

This project stores Wi-Fi/MQTT settings in the `linebot_net` NVS namespace and PID data in `linebot_pid`. An ordinary firmware upload should preserve those values when it writes only the application image and leaves the NVS partition layout intact. NVS is a separate flash data partition; esptool's `erase_flash` operation erases the entire flash, unlike writing selected flash regions.[6][7]

Persistence is not guaranteed if you erase all flash, overwrite/erase the NVS region, change or truncate the partition layout, run this project's `--mode reset`, or flash another program that clears the same NVS namespaces. Another program may leave the bytes intact but not understand this project's keys. If you return to this firmware and settings are missing or invalid, provision again with `--mode configure`. NVS is not encrypted by default, so physical access to the flash can expose stored values.

## If telemetry does not appear

- Check the Mosquitto terminal for the device connection and telemetry publications.
- Check `/health` for `mqttConnected` and `databaseOpen`.
- Confirm that `MQTT_URL` and the ESP32 broker address use the same reachable LAN address and port.
- Confirm `ROBOT_IDS` matches the device robot ID (`linebot-01`).
- Use `--mode info` to check `configured=1` and inspect `sensorMask` / `rearSensorMask`; do not share passwords or tokens in logs.
- Keep the wheels lifted during first testing. Use a physical power cutoff before any track trial; software tests/builds do not verify real sensor contrast, motor polarity, stopping distance, or turn behavior.

## Sources

[6] https://docs.espressif.com/projects/esptool/en/release-v4/esp32s3/esptool/basic-commands.html — Espressif esptool ESP32-S3 Basic Commands
[7] https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/storage/nvs_flash.html — Espressif ESP32-S3 NVS Flash API
