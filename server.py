#!/usr/bin/env python3
"""
Local baby monitor relay.

* Serves the two web pages (baby unit / parent unit) over HTTPS on your LAN.
* Relays small JSON messages (alerts, status, WebRTC handshakes) between devices.
* Never touches audio or video: media flows device-to-device over WebRTC.
* Never writes recordings, logs or request history to disk. The only files it
  creates are a self-signed TLS certificate and key in ./certs.
"""
import argparse
import asyncio
import datetime
import hmac
import ipaddress
import json
import secrets
import socket
import ssl
import threading
import time
import webbrowser
from dataclasses import dataclass
from pathlib import Path

from aiohttp import WSMsgType, web

PROJECT_FOLDER = Path(__file__).resolve().parent
STATIC_FOLDER = PROJECT_FOLDER / "static"
CERTIFICATE_FOLDER = PROJECT_FOLDER / "certs"

MAX_WRONG_PIN_ATTEMPTS = 3       # wrong PINs allowed before lockout
LOCKOUT_SECONDS = 300            # lockout length per client IP

ROLE_BABY_UNIT = "baby"
ROLE_PARENT = "parent"
ALERT_KINDS = ("sound", "movement")

MIN_SOUND_SENSITIVITY = 1
MAX_SOUND_SENSITIVITY = 10
DEFAULT_SOUND_SENSITIVITY = 6

MAX_BABY_UNIT_ID_LENGTH = 64

TALK_REFUSAL_REASONS = ("another-parent-is-talking",)


# --------------------------------------------------------------------------
# Networking helpers
# --------------------------------------------------------------------------
def find_local_ip_addresses():
    """List of this machine's IPv4 addresses (no traffic is sent)."""
    addresses = {"127.0.0.1"}
    try:
        probe_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe_socket.connect(("10.255.255.255", 1))  # UDP connect: just picks the LAN interface
        addresses.add(probe_socket.getsockname()[0])
        probe_socket.close()
    except OSError:
        pass
    try:
        for address_info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addresses.add(address_info[4][0])
    except OSError:
        pass
    return sorted(addresses)


def ensure_self_signed_certificate(ip_addresses):
    """Create (or reuse) a self-signed certificate valid for this machine's IP addresses.

    Browsers only allow camera/microphone access on https pages, so even a
    LAN-only app needs a certificate. Each device will show a one-time warning.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    CERTIFICATE_FOLDER.mkdir(exist_ok=True)
    certificate_path = CERTIFICATE_FOLDER / "cert.pem"
    private_key_path = CERTIFICATE_FOLDER / "key.pem"
    required_addresses = {ipaddress.ip_address(address) for address in ip_addresses}
    current_time = datetime.datetime.now(datetime.timezone.utc)

    if certificate_path.exists() and private_key_path.exists():
        try:
            existing_certificate = x509.load_pem_x509_certificate(certificate_path.read_bytes())
            alternative_names = existing_certificate.extensions.get_extension_for_class(
                x509.SubjectAlternativeName
            ).value
            covered_addresses = set(alternative_names.get_values_for_type(x509.IPAddress))
            is_valid_long_enough = (
                existing_certificate.not_valid_after_utc > current_time + datetime.timedelta(days=14)
            )
            if required_addresses <= covered_addresses and is_valid_long_enough:
                return certificate_path, private_key_path
        except Exception:
            pass  # unreadable or outdated: regenerate below

    private_key = ec.generate_private_key(ec.SECP256R1())
    certificate_owner = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "baby-monitor.local")])
    covered_names = [x509.DNSName("localhost")]
    try:
        covered_names.append(x509.DNSName(socket.gethostname()))
    except ValueError:
        pass
    covered_names += [x509.IPAddress(address) for address in sorted(required_addresses, key=str)]
    certificate = (
        x509.CertificateBuilder()
        .subject_name(certificate_owner)
        .issuer_name(certificate_owner)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(current_time - datetime.timedelta(days=1))
        .not_valid_after(current_time + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(covered_names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(private_key, hashes.SHA256())
    )
    private_key_path.write_bytes(
        private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    try:
        private_key_path.chmod(0o600)
    except OSError:
        pass
    certificate_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return certificate_path, private_key_path


# --------------------------------------------------------------------------
# Message hub (in memory only)
# --------------------------------------------------------------------------
@dataclass(eq=False)
class ConnectedDevice:
    websocket: web.WebSocketResponse
    role: str          # ROLE_BABY_UNIT or ROLE_PARENT
    device_id: str     # identifies this connection
    baby_unit_id: str = ""   # identifies the physical baby device across reconnects (empty for parents)


async def send_json(websocket, payload):
    try:
        await websocket.send_str(json.dumps(payload, separators=(",", ":")))
    except Exception:
        pass  # the device has gone away; nothing useful to do


_background_tasks = set()


def close_in_background(websocket):
    """Closing waits for the other side to answer, which can take seconds if it has vanished."""
    async def close_quietly():
        try:
            await websocket.close()
        except Exception:
            pass

    task = asyncio.ensure_future(close_quietly())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def is_valid_baby_unit_id(value):
    return isinstance(value, str) and 0 < len(value) <= MAX_BABY_UNIT_ID_LENGTH


def clamp_number(value, minimum, maximum, default=0):
    """Turns untrusted input into a number between minimum and maximum."""
    try:
        return max(minimum, min(maximum, float(value)))
    except (TypeError, ValueError):
        return default


def read_movement_box(untrusted_box):
    """Turns an untrusted box (fractions of the picture) into a valid one, or None when there is no box."""
    if not isinstance(untrusted_box, dict):
        return None
    box = {}
    for field in ("left", "top", "width", "height"):
        value = clamp_number(untrusted_box.get(field), 0, 1, default=None)
        if value is None:
            return None
        box[field] = round(value, 3)
    box["width"] = min(box["width"], round(1 - box["left"], 3))    # keep the box inside the picture
    box["height"] = min(box["height"], round(1 - box["top"], 3))
    return box if box["width"] > 0 and box["height"] > 0 else None


def read_sound_sensitivity(message):
    return int(clamp_number(message.get("soundSensitivity"), MIN_SOUND_SENSITIVITY,
                            MAX_SOUND_SENSITIVITY, DEFAULT_SOUND_SENSITIVITY))


class MessageHub:
    def __init__(self, pin):
        self.pin = pin
        self.baby_device = None
        self.parent_devices = {}            # device id -> ConnectedDevice
        self.wrong_pin_attempts_by_ip = {}  # client ip -> (wrong attempts so far, locked out until)

    # --- PIN handling ----------------------------------------------------
    def is_correct_pin(self, submitted_pin):
        return hmac.compare_digest(submitted_pin.encode(), self.pin.encode())

    def is_locked_out(self, client_ip):
        record = self.wrong_pin_attempts_by_ip.get(client_ip)
        return bool(record and record[1] > time.monotonic())

    def record_wrong_pin(self, client_ip):
        attempts_so_far = self.wrong_pin_attempts_by_ip.get(client_ip, (0, 0))[0] + 1
        if attempts_so_far >= MAX_WRONG_PIN_ATTEMPTS:
            self.wrong_pin_attempts_by_ip[client_ip] = (0, time.monotonic() + LOCKOUT_SECONDS)
        else:
            self.wrong_pin_attempts_by_ip[client_ip] = (attempts_so_far, 0)

    def clear_wrong_pins(self, client_ip):
        self.wrong_pin_attempts_by_ip.pop(client_ip, None)

    # --- who is connected ------------------------------------------------
    async def broadcast_to_parents(self, payload):
        await asyncio.gather(*(send_json(parent.websocket, payload)
                               for parent in list(self.parent_devices.values())))

    async def send_to_parent(self, parent_device_id, payload):
        if not isinstance(parent_device_id, str):
            return
        target_parent = self.parent_devices.get(parent_device_id)
        if target_parent:
            await send_json(target_parent.websocket, payload)

    async def tell_baby_how_many_parents(self):
        if self.baby_device:
            await send_json(self.baby_device.websocket,
                            {"type": "parent-count", "count": len(self.parent_devices)})

    async def register_device(self, device):
        """Adds a device. Returns False if it is refused because a different device is already the baby unit."""
        if device.role == ROLE_BABY_UNIT:
            current_baby_unit = self.baby_device
            if current_baby_unit and current_baby_unit.baby_unit_id != device.baby_unit_id:
                return False
            self.baby_device = device
            if current_baby_unit:
                # The same device came back (or was opened in a second window): the older connection steps down.
                await send_json(current_baby_unit.websocket, {"type": "denied", "reason": "replaced-by-newer-session"})
                close_in_background(current_baby_unit.websocket)
            await send_json(device.websocket, {"type": "joined", "deviceId": device.device_id})
            await self.broadcast_to_parents({"type": "baby-online"})
            await self.tell_baby_how_many_parents()
        else:
            self.parent_devices[device.device_id] = device
            await send_json(device.websocket, {
                "type": "joined",
                "deviceId": device.device_id,
                "isBabyUnitOnline": self.baby_device is not None,
            })
            await self.tell_baby_how_many_parents()
        return True

    async def unregister_device(self, device):
        if device.role == ROLE_BABY_UNIT:
            if self.baby_device is device:
                self.baby_device = None
                await self.broadcast_to_parents({"type": "baby-offline"})
        else:
            if self.parent_devices.pop(device.device_id, None):
                if self.baby_device:
                    await send_json(self.baby_device.websocket,
                                    {"type": "stop-live-view", "parentDeviceId": device.device_id})
                    await send_json(self.baby_device.websocket,
                                    {"type": "stop-talking", "parentDeviceId": device.device_id})
                    await send_json(self.baby_device.websocket,
                                    {"type": "stop-clips", "parentDeviceId": device.device_id})
                await self.tell_baby_how_many_parents()

    # --- passing messages on ---------------------------------------------
    async def route_message(self, sender, message):
        message_type = message.get("type")
        if sender.role == ROLE_BABY_UNIT:
            if message_type == "status":
                await self.broadcast_to_parents({
                    "type": "status",
                    "soundLevelDb": clamp_number(message.get("soundLevelDb"), -200, 20),
                    "alertThresholdDb": clamp_number(message.get("alertThresholdDb"), -200, 20),
                    "movementPercent": clamp_number(message.get("movementPercent"), 0, 100),
                    "soundSensitivity": read_sound_sensitivity(message),
                    "movementAlertsEnabled": bool(message.get("movementAlertsEnabled")),
                    "recordClipsEnabled": bool(message.get("recordClipsEnabled")),
                    "isCalibrating": bool(message.get("isCalibrating")),
                    "isMicrophoneWorking": message.get("isMicrophoneWorking") is not False,
                })
            elif message_type == "alert" and message.get("alertKind") in ALERT_KINDS:
                await self.broadcast_to_parents({"type": "alert", "alertKind": message["alertKind"]})
            elif message_type == "movement-box":
                await self.broadcast_to_parents(
                    {"type": "movement-box", "box": read_movement_box(message.get("box"))})
            elif message_type == "webrtc-signal":
                await self.send_to_parent(message.get("parentDeviceId"),
                                          {"type": "webrtc-signal", "signal": message.get("signal")})
            elif message_type == "talk-signal":
                await self.send_to_parent(message.get("parentDeviceId"),
                                          {"type": "talk-signal", "signal": message.get("signal")})
            elif message_type == "clip-signal":
                await self.send_to_parent(message.get("parentDeviceId"),
                                          {"type": "clip-signal", "signal": message.get("signal")})
            elif message_type == "talk-refused" and message.get("reason") in TALK_REFUSAL_REASONS:
                await self.send_to_parent(message.get("parentDeviceId"),
                                          {"type": "talk-refused", "reason": message["reason"]})
        else:
            if not self.baby_device:
                if message_type == "dismiss-alarm":
                    await self._tell_other_parents_alarm_was_dismissed(sender)
                return
            if message_type == "start-live-view":
                await send_json(self.baby_device.websocket, {
                    "type": "start-live-view",
                    "parentDeviceId": sender.device_id,
                    "includeVideo": bool(message.get("includeVideo")),
                })
            elif message_type == "stop-live-view":
                await send_json(self.baby_device.websocket,
                                {"type": "stop-live-view", "parentDeviceId": sender.device_id})
            elif message_type == "webrtc-signal":
                await send_json(self.baby_device.websocket, {
                    "type": "webrtc-signal",
                    "parentDeviceId": sender.device_id,
                    "signal": message.get("signal"),
                })
            elif message_type == "talk-signal":
                await send_json(self.baby_device.websocket, {
                    "type": "talk-signal",
                    "parentDeviceId": sender.device_id,
                    "signal": message.get("signal"),
                })
            elif message_type == "stop-talking":
                await send_json(self.baby_device.websocket,
                                {"type": "stop-talking", "parentDeviceId": sender.device_id})
            elif message_type == "clip-signal":
                await send_json(self.baby_device.websocket, {
                    "type": "clip-signal",
                    "parentDeviceId": sender.device_id,
                    "signal": message.get("signal"),
                })
            elif message_type == "change-settings":
                await send_json(self.baby_device.websocket, {
                    "type": "change-settings",
                    "soundSensitivity": read_sound_sensitivity(message),
                    "movementAlertsEnabled": bool(message.get("movementAlertsEnabled")),
                    "recordClipsEnabled": bool(message.get("recordClipsEnabled")),
                })
            elif message_type == "dismiss-alarm":
                await self._tell_other_parents_alarm_was_dismissed(sender)

    async def _tell_other_parents_alarm_was_dismissed(self, dismissing_parent):
        await asyncio.gather(*(
            send_json(other_parent.websocket, {"type": "alarm-dismissed"})
            for other_parent in list(self.parent_devices.values())
            if other_parent is not dismissing_parent
        ))


# --------------------------------------------------------------------------
# HTTP / WebSocket handlers
# --------------------------------------------------------------------------
async def handle_websocket(request):
    hub = request.app["hub"]
    websocket = web.WebSocketResponse(heartbeat=15, max_msg_size=64 * 1024)
    await websocket.prepare(request)
    client_ip = request.remote or "?"

    if hub.is_locked_out(client_ip):
        await send_json(websocket, {"type": "denied", "reason": "locked"})
        await websocket.close()
        return websocket

    join_message = {}
    try:
        first_message = await asyncio.wait_for(websocket.receive(), 10)
        if first_message.type == WSMsgType.TEXT:
            join_message = json.loads(first_message.data)
    except Exception:
        join_message = {}
    if not isinstance(join_message, dict):
        join_message = {}

    role = join_message.get("role")
    submitted_pin = join_message.get("pin")
    is_valid_join = (
        join_message.get("type") == "join"
        and role in (ROLE_BABY_UNIT, ROLE_PARENT)
        and isinstance(submitted_pin, str)
        and hub.is_correct_pin(submitted_pin)
    )
    if not is_valid_join:
        hub.record_wrong_pin(client_ip)
        await send_json(websocket, {"type": "denied", "reason": "wrong-pin"})
        await websocket.close()
        return websocket

    hub.clear_wrong_pins(client_ip)
    baby_unit_id = join_message.get("babyUnitId")
    if role == ROLE_BABY_UNIT and not is_valid_baby_unit_id(baby_unit_id):
        await send_json(websocket, {"type": "denied", "reason": "invalid-request"})
        await websocket.close()
        return websocket

    device = ConnectedDevice(websocket, role, secrets.token_hex(4),
                             baby_unit_id if role == ROLE_BABY_UNIT else "")
    try:
        was_accepted = await hub.register_device(device)
        if not was_accepted:
            await send_json(websocket, {"type": "denied", "reason": "baby-unit-already-in-use"})
            await websocket.close()
            return websocket
        async for incoming in websocket:
            if incoming.type != WSMsgType.TEXT:
                continue
            try:
                message = json.loads(incoming.data)
            except ValueError:
                continue
            if isinstance(message, dict):
                await hub.route_message(device, message)
    finally:
        await hub.unregister_device(device)
    return websocket


def serve_page(file_name):
    async def send_page(request):
        return web.FileResponse(STATIC_FOLDER / file_name)
    return send_page


async def add_security_headers(request, response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()"
    # Everything is served from this server: the pages can't load anything external.
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "connect-src 'self' wss: ws:; media-src 'self' blob: mediastream:; img-src 'self' data:; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )


def create_application(pin):
    application = web.Application()
    application["hub"] = MessageHub(pin)
    application.on_response_prepare.append(add_security_headers)
    application.router.add_get("/", serve_page("index.html"))
    application.router.add_get("/baby", serve_page("baby.html"))
    application.router.add_get("/parent", serve_page("parent.html"))
    application.router.add_get("/ws", handle_websocket)
    application.router.add_static("/static", STATIC_FOLDER, follow_symlinks=False)
    return application


# --------------------------------------------------------------------------
def main():
    argument_parser = argparse.ArgumentParser(description="Local-only baby monitor")
    argument_parser.add_argument("--host", default="0.0.0.0",
                                 help="address to listen on (default: all interfaces)")
    argument_parser.add_argument("--port", type=int, default=8443)
    argument_parser.add_argument("--pin", help="fixed PIN (default: a new random 6-digit PIN each run)")
    argument_parser.add_argument("--open-browser", action="store_true",
                                 help="open the monitor in this computer's browser once the server is running")
    options = argument_parser.parse_args()

    pin = options.pin or f"{secrets.randbelow(10**6):06d}"
    ip_addresses = find_local_ip_addresses()
    certificate_path, private_key_path = ensure_self_signed_certificate(ip_addresses)
    tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls_context.minimum_version = ssl.TLSVersion.TLSv1_2
    tls_context.load_cert_chain(certificate_path, private_key_path)

    lan_addresses = [address for address in ip_addresses if not address.startswith("127.")] or ["127.0.0.1"]
    monitor_url = f"https://{lan_addresses[0]}:{options.port}/"
    print("\nBaby monitor running (local network only; nothing is recorded)\n")
    print(f"  Open on BOTH devices:  {monitor_url}")
    for other_address in lan_addresses[1:]:
        print(f"  (other interface):     https://{other_address}:{options.port}/")
    print(f"\n  PIN (type it on each device when asked):  {pin}")
    print("  The PIN is not part of the link or the QR code, so sharing the link does not share access.")
    print("\n  Each device shows a certificate warning once; accept it to continue.")
    try:
        import qrcode  # optional, makes phone setup easier

        qr_code = qrcode.QRCode(border=1)
        qr_code.add_data(monitor_url)
        qr_code.print_ascii(invert=True)
    except Exception:
        pass
    print("\n  To stop the monitor, close this window (or press Ctrl+C).\n")

    if options.open_browser:
        # Wait briefly so the server is accepting connections when the browser loads the page.
        browser_opener = threading.Timer(1.5, webbrowser.open, args=[f"https://localhost:{options.port}/"])
        browser_opener.daemon = True
        browser_opener.start()

    web.run_app(create_application(pin), host=options.host, port=options.port, ssl_context=tls_context,
                access_log=None, print=None)


if __name__ == "__main__":
    main()
