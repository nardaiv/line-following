# Local Mosquitto

Do not expose port 1883 to the internet. This config uses authenticated MQTT
and an ACL; plain TCP is intended only on a trusted private LAN. The firmware
requires a LAN IPv4 address or DNS name resolvable by the board (not localhost
or an mDNS `.local` name).

From the repository root, create private runtime files and the broker data directory:

```sh
cp infra/mosquitto/mosquitto.conf.example infra/mosquitto/mosquitto.conf.local
cp infra/mosquitto/acl.example infra/mosquitto/acl
mkdir -p infra/mosquitto/data
```

Before starting the broker, edit `infra/mosquitto/mosquitto.conf.local`: change
`listener 1883 127.0.0.1` to `listener 1883 <broker-host-LAN-IPv4>` (for example,
`listener 1883 192.168.1.20`). Use the host's real LAN address, not the example
address, `0.0.0.0`, `localhost`, or `.local`. Limit inbound TCP 1883 in the host
firewall to the robot/backend subnet. If you changed the robot ID, update both
the ACL entries and `ROBOT_IDS` in `backend/.env` to match.

Then create hashed credentials and start Mosquitto:

```sh
cd infra/mosquitto
mosquitto_passwd -c passwd linebot-01
mosquitto_passwd passwd backend
mosquitto -c mosquitto.conf.local -v
```

`mosquitto_passwd` prompts without putting passwords in shell history. Provision
the device with the `linebot-01` credentials and use the `backend` credentials
in `backend/.env`. Edit the ACL blocks and backend `ROBOT_IDS` together when
you add a robot. `passwd`, `acl`, `mosquitto.conf.local`, and broker data are local-only and ignored by Git. The committed examples contain no secrets.

Set `MQTT_URL` in `backend/.env` to the listener's LAN IPv4 and provision the ESP32 with that same address and port. Keep TCP 1883 limited to the trusted robot/backend subnet; never expose it to the internet. The firmware currently uses plain MQTT, so use only a trusted private Wi-Fi/LAN; use TLS/VPN or a stronger boundary for untrusted networks. The ACL gives each device write access only to its own telemetry/status/PID state/ack/event topics and read access only to its PID command topic; backend permissions are separately scoped.
