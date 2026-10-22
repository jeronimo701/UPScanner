from __future__ import annotations

import threading
from datetime import datetime
from typing import Any

from .config import CODE_IN_TEXT_RE
from .utils import normalize_code

SCAN_EVENTS: list[dict[str, Any]] = []
SCAN_LOCK = threading.Lock()
SERIAL_READER: "SerialReader | None" = None
LAST_SERIAL_PACKET = ""
LAST_SERIAL_PACKET_TIME = ""
LAST_SERIAL_PACKET_META: dict[str, Any] = {}


def append_scan_event(code: str, source: str, raw: str = "", meta: dict[str, Any] | None = None) -> None:
    code = normalize_code(code)
    if not code:
        return
    with SCAN_LOCK:
        SCAN_EVENTS.append({
            "id": len(SCAN_EVENTS) + 1,
            "code": code,
            "raw": raw or code,
            "source": source,
            "time": datetime.now().isoformat(),
            "meta": meta or {},
        })
        del SCAN_EVENTS[:-500]


def _packet_meta(raw: bytes) -> dict[str, Any]:
    cr_count = raw.count(b"\r")
    lf_count = raw.count(b"\n")
    return {
        "cr_count": cr_count,
        "lf_count": lf_count,
        "enter_count": cr_count + lf_count,
        "ending": "CR+LF" if raw.endswith(b"\r\n") else "CR" if raw.endswith(b"\r") else "LF" if raw.endswith(b"\n") else "none",
    }


def _set_last_packet(text: str, meta: dict[str, Any] | None = None) -> None:
    global LAST_SERIAL_PACKET, LAST_SERIAL_PACKET_TIME, LAST_SERIAL_PACKET_META
    LAST_SERIAL_PACKET = (text or "").strip()[:240]
    LAST_SERIAL_PACKET_TIME = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    LAST_SERIAL_PACKET_META = meta or {}


def get_scan_events_since(since: int) -> list[dict[str, Any]]:
    with SCAN_LOCK:
        return [event for event in SCAN_EVENTS if event["id"] > since]


def list_serial_ports() -> dict[str, Any]:
    try:
        from serial.tools import list_ports
    except Exception as exc:
        return {"ok": False, "error": f"pyserial не установлен: {exc}", "ports": []}
    ports = [{"device": port.device, "description": port.description} for port in list_ports.comports()]
    return {"ok": True, "ports": ports}


class SerialReader:
    def __init__(self, port: str, baudrate: int) -> None:
        self.port = port
        self.baudrate = baudrate
        self.error = ""
        self.running = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._serial: Any = None

    def start(self) -> None:
        self.running = True
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._serial:
            try:
                self._serial.close()
            except Exception:
                pass
        self._thread.join(timeout=2)
        self.running = False

    def status(self) -> dict[str, Any]:
        return {"running": self.running and self._thread.is_alive(), "port": self.port, "baudrate": self.baudrate, "error": self.error}

    def _run(self) -> None:
        try:
            import serial

            with serial.Serial(self.port, self.baudrate, timeout=0.3) as ser:
                self._serial = ser
                while not self._stop.is_set():
                    raw = ser.readline()
                    if not raw:
                        continue
                    meta = _packet_meta(raw)
                    text = raw.decode("utf-8", errors="ignore")
                    cleaned_text = text.strip()
                    _set_last_packet(text, meta)
                    match = CODE_IN_TEXT_RE.search(cleaned_text)
                    append_scan_event(match.group(1) if match else cleaned_text, f"VCOM {self.port}", raw=text, meta=meta)
        except Exception as exc:
            self.error = str(exc)
        finally:
            self.running = False
            self._serial = None


def start_serial_reader(port: str, baudrate: int) -> dict[str, Any]:
    global SERIAL_READER
    if not port:
        return {"ok": False, "error": "Не выбран COM-порт"}
    stop_serial_reader()
    reader = SerialReader(port, baudrate)
    SERIAL_READER = reader
    reader.start()
    return {"ok": True, **reader.status()}


def stop_serial_reader() -> None:
    global SERIAL_READER
    if SERIAL_READER:
        SERIAL_READER.stop()
        SERIAL_READER = None


def serial_status() -> dict[str, Any]:
    reader = SERIAL_READER
    if reader:
        status = reader.status()
    else:
        status = {"running": False}
    status["captured"] = bool(status.get("running"))
    status["last_packet"] = LAST_SERIAL_PACKET
    status["last_packet_time"] = LAST_SERIAL_PACKET_TIME
    status["last_packet_meta"] = LAST_SERIAL_PACKET_META
    return status
