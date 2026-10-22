#!/usr/bin/env python3
"""Provision ESP32-S3 device settings over its local USB serial port."""

import argparse
import getpass
import math
import re
import sys
import time

try:
    import serial
except ImportError as exc:  # pragma: no cover - exercised by CLI setup
    raise SystemExit(
        "Missing pyserial; install it with: "
        "python -m pip install -r tools/requirements.txt"
    ) from exc

BAUD_DEFAULT = 115200
KP_MAX = 60.0
KI_MAX = 12.0
KD_MAX = 0.3


def utf8_hex(value: str, label: str, minimum: int, maximum: int) -> str:
    encoded = value.encode("utf-8")
    if not minimum <= len(encoded) <= maximum:
        raise ValueError(f"{label} must be {minimum}..{maximum} UTF-8 bytes")
    if any(byte < 0x20 or byte == 0x7F for byte in encoded):
        raise ValueError(f"{label} cannot contain control characters")
    return encoded.hex()


def validate_settings(ssid, wifi_password, host, port, user, mqtt_password, robot_id):
    utf8_hex(ssid, "SSID", 1, 32)
    if wifi_password:
        utf8_hex(wifi_password, "Wi-Fi password", 8, 63)
    if not host or len(host) > 253:
        raise ValueError("Broker host must contain 1..253 characters")
    if (
        host.lower() == "localhost"
        or host.startswith("127.")
        or host.lower().endswith(".local")
    ):
        raise ValueError(
            "Use a LAN IPv4 address or resolvable DNS hostname, not loopback or mDNS .local"
        )
    labels = host.split(".")
    if any(
        not label
        or len(label) > 63
        or label.startswith("-")
        or label.endswith("-")
        or re.fullmatch(r"[A-Za-z0-9-]+", label) is None
        for label in labels
    ):
        raise ValueError("Broker host must be a hostname or IPv4 address")
    if not 1 <= port <= 65535:
        raise ValueError("Broker port must be 1..65535")
    utf8_hex(user, "MQTT username", 1, 64)
    utf8_hex(mqtt_password, "MQTT password", 1, 64)
    if re.fullmatch(r"[A-Za-z0-9_-]{1,32}", robot_id) is None:
        raise ValueError("Robot ID must be 1..32 letters, digits, '_' or '-'")


def config_frame(ssid, wifi_password, host, port, user, mqtt_password, robot_id):
    validate_settings(
        ssid, wifi_password, host, port, user, mqtt_password, robot_id
    )
    encoded = [
        utf8_hex(ssid, "SSID", 1, 32),
        utf8_hex(wifi_password, "Wi-Fi password", 0, 63),
        utf8_hex(host, "Broker host", 1, 253),
        str(port),
        utf8_hex(user, "MQTT username", 1, 64),
        utf8_hex(mqtt_password, "MQTT password", 1, 64),
        utf8_hex(robot_id, "Robot ID", 1, 32),
    ]
    return "CFG|" + "|".join(encoded)


def read_protocol_line(device, prefixes, timeout_seconds=8.0):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        raw = device.readline()
        if not raw:
            continue
        line = raw.decode("ascii", errors="replace").strip()
        if line.startswith(prefixes):
            return line
    raise TimeoutError("No device acknowledgement; check the selected port and firmware")


def expected_reply_prefixes(mode):
    if mode == "info":
        return ("INFO|",)
    return ("ACK|", "ERR|")


def send_command(
    device, command, expected_prefixes=("ACK|", "ERR|"), timeout_seconds=8.0
):
    device.write(command.encode("ascii") + b"\n")
    device.flush()
    response = read_protocol_line(device, expected_prefixes, timeout_seconds)
    if response.startswith("ERR|"):
        raise RuntimeError(f"Device rejected command: {response}")
    return response


def prompt_configuration():
    ssid = input("Wi-Fi SSID: ")
    wifi_password = getpass.getpass("Wi-Fi password (blank for open network): ")
    host = input("Local Mosquitto hostname/IPv4 address: ")
    port_text = input("Mosquitto port [1883]: ").strip() or "1883"
    if not port_text.isdecimal():
        raise ValueError("Broker port must be a decimal integer")
    port = int(port_text)
    user = input("MQTT username: ")
    mqtt_password = getpass.getpass("MQTT password: ")
    robot_id = input("Robot ID [linebot-01]: ").strip() or "linebot-01"
    return config_frame(
        ssid, wifi_password, host, port, user, mqtt_password, robot_id
    )


def prompt_pid():
    kp = float(input("Kp [12.5]: ").strip() or "12.5")
    ki = float(input("Ki [1.0]: ").strip() or "1.0")
    kd = float(input("Kd [0.15]: ").strip() or "0.15")
    if not all(math.isfinite(value) for value in (kp, ki, kd)):
        raise ValueError("PID gains must be finite numbers")
    if not (0 <= kp <= KP_MAX and 0 <= ki <= KI_MAX and 0 <= kd <= KD_MAX):
        raise ValueError(
            f"PID gains must satisfy 0<=Kp<={KP_MAX:g}, "
            f"0<=Ki<={KI_MAX:g}, 0<=Kd<={KD_MAX:g}"
        )
    return f"PID|{kp:.9g}|{ki:.9g}|{kd:.9g}"


def prompt_for_manual_reset():
    input(
        "Serial port is open. Press and release the board's EN/RESET button, "
        "then press Enter here to send the command: "
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="USB serial port, e.g. /dev/ttyACM0")
    parser.add_argument("--baud", type=int, default=BAUD_DEFAULT)
    parser.add_argument(
        "--mode",
        choices=("configure", "pid", "defaults", "reset", "info"),
        default="configure",
    )
    args = parser.parse_args()

    try:
        if args.mode == "configure":
            command = prompt_configuration()
        elif args.mode == "pid":
            command = prompt_pid()
        elif args.mode == "defaults":
            command = "PID|DEFAULT"
        elif args.mode == "reset":
            command = "RESET"
        else:
            command = "INFO"

        # The firmware polls USB provisioning only during its startup window.
        # Do not assume opening this USB-UART port resets the ESP32.
        with serial.Serial(args.port, args.baud, timeout=0.25, write_timeout=2) as device:
            prompt_for_manual_reset()
            time.sleep(0.5)
            device.reset_input_buffer()
            response = send_command(
                device, command, expected_reply_prefixes(args.mode)
            )
            print(response)
            if args.mode in ("configure", "pid", "defaults", "reset"):
                if args.mode == "configure":
                    # Firmware emits INFO immediately after CFG acknowledgement.
                    info = read_protocol_line(device, ("INFO|",))
                else:
                    info = send_command(device, "INFO", ("INFO|",))
                print(info)
        return 0
    except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
        print(f"Provisioning failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
