import unittest
from unittest.mock import patch

from provision import (
    config_frame,
    expected_reply_prefixes,
    prompt_for_manual_reset,
    send_command,
)


class FakeSerial:
    def __init__(self, response):
        self.response = response
        self.written = b""

    def write(self, data):
        self.written += data

    def flush(self):
        pass

    def readline(self):
        response = self.response
        self.response = b""
        return response


class ProvisionFrameTests(unittest.TestCase):
    def test_manual_reset_prompt_explains_to_reset_after_opening_port(self):
        with patch("builtins.input", return_value="") as mocked_input:
            prompt_for_manual_reset()

        prompt = mocked_input.call_args.args[0]
        self.assertIn("EN/RESET", prompt)
        self.assertIn("press Enter", prompt)

    def test_configuration_frame_keeps_port_decimal_and_hex_encodes_text(self):
        frame = config_frame(
            "lab", "password", "192.168.1.2", 1883, "bot", "mqttpass", "linebot-01"
        )
        self.assertEqual(
            "CFG|6c6162|70617373776f7264|3139322e3136382e312e32|1883|626f74|"
            "6d71747470617373|6c696e65626f742d3031",
            frame,
        )


    def test_info_mode_accepts_info_response(self):
        device = FakeSerial(b"INFO|configured=0|kp=12.5|ki=1|kd=0.15|revision=0\n")
        reply = send_command(
            device, "INFO", expected_reply_prefixes("info"), timeout_seconds=0.01
        )
        self.assertTrue(reply.startswith("INFO|"))
        self.assertEqual(b"INFO\n", device.written)

    def test_rejects_mdns_local_host(self):
        with self.assertRaises(ValueError):
            config_frame(
                "lab", "password", "broker.local", 1883, "bot", "mqttpass", "linebot-01"
            )

    def test_rejects_localhost_broker_host(self):
        with self.assertRaises(ValueError):
            config_frame(
                "lab", "password", "localhost", 1883, "bot", "mqttpass", "linebot-01"
            )

    def test_allows_an_open_wifi_network(self):
        frame = config_frame(
            "lab", "", "192.168.1.2", 1883, "bot", "mqttpass", "linebot-01"
        )
        self.assertIn("CFG|6c6162||3139322e3136382e312e32|1883|", frame)


if __name__ == "__main__":
    unittest.main()
