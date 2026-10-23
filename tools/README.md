# ESP32-S3 USB provisioning

This utility configures runtime Wi-Fi/Mosquitto settings and PID gains over the
USB serial console. It does not compile or flash firmware. Device secrets are
prompted with `getpass`, sent only to the attached board, stored in ESP32 NVS,
and never printed by the utility or firmware. The serial frame hex-encodes fields
for reliable framing, **not confidentiality**; anyone able to observe that USB
serial session can recover the credentials. Use a trusted host/cable and do not
record or forward serial logs. Default NVS is not encrypted; physical access to
the board/flash may expose stored credentials. NVS encryption and secure boot
require device-specific provisioning and are outside this phase.

Install and run from the repository root:

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r tools/requirements.txt
python tools/provision.py --port /dev/ttyACM0 --mode configure
```

Use `--mode pid` to set gains, `--mode defaults` to restore compiled-in gains,
`--mode info` to read back non-secret status, or `--mode reset` to clear stored
network settings and PID data. On Windows, specify the COM port (for example
`COM5`). The utility opens the serial port and then explicitly asks you to
press and release the board's EN/RESET button before it sends a command; opening
the USB serial port alone is not guaranteed to reset every USB-UART adapter.
The non-secret `INFO` response includes one-time five-bit front and rear mask
snapshots (`sensorMask` and `rearSensorMask`; bit 0 = robot-left on both rows);
take them with the robot safely supported.

On every boot, the firmware holds the motors in standby for a five-second USB
provisioning window. Missing network settings keep it in standby after that
window instead of starting control tasks. `tools/provision.py` opens the serial
port and asks you to reset the ESP32 while the port is open. Press and release
EN/RESET, then press Enter in the utility; it sends the command during the
startup window. Keep the robot's wheels lifted and sensors off the line while
connecting and provisioning. Once the window closes, use MQTT for tuning; USB
changes require a serial reconnect/reboot. The firmware does not echo the SSID,
Wi-Fi password, MQTT username, or MQTT password; `INFO` only shows whether
configuration exists, robot ID, broker host/port, PID values, revision and the
current front/rear five-bit line-detection masks.

The serial protocol is newline-delimited ASCII. `CFG` fields are hex-encoded to
avoid delimiter/newline injection; do not send secrets in command-line
arguments or logs. PID ranges (`Kp <= 60`, `Ki <= 12`, `Kd <= 0.3`) are derived
from the configured sensor-error span, integral clamp, 10 ms minimum loop
period, and maximum PWM correction so no individual term exceeds the output
limit. These bounds are numeric/actuator guards, not a proven stable tuning
range; bench-tune with wheels lifted and a physical power cutoff before driving.

NVS stores a schema version with each data set and falls back to defaults when
missing, incompatible, invalid or unreadable. PID updates are a single NVS blob;
network settings use a versioned multi-key record and fail closed if interrupted.
Use `--mode defaults` to save the PID defaults without clearing network settings.
Use `--mode reset` to clear both namespaces; if NVS itself is unavailable, use
the board's documented ESP32 flash-erase/reflash recovery procedure.
