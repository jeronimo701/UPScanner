from __future__ import annotations

import argparse
import shutil
import subprocess
import webbrowser
from pathlib import Path

from .config import NEW_DIR, OLD_DIR
from .tray import create_tray_icon
from .utils import safe_print
from .web_server import get_exit_event, run_server, set_tray_icon, shutdown_app


def _find_kiosk_browser() -> tuple[str, str] | tuple[None, None]:
    edge_candidates = [
        "msedge.exe",
        "msedge",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    chrome_candidates = [
        "chrome.exe",
        "chrome",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]

    for candidate in edge_candidates:
        resolved = shutil.which(candidate) if "\\" not in candidate else (candidate if Path(candidate).exists() else None)
        if resolved:
            return "edge", resolved
    for candidate in chrome_candidates:
        resolved = shutil.which(candidate) if "\\" not in candidate else (candidate if Path(candidate).exists() else None)
        if resolved:
            return "chrome", resolved
    return None, None


def open_browser(url: str, kiosk: bool = True) -> None:
    kind, exe = _find_kiosk_browser()
    if kiosk and exe:
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if kind == "edge":
            args = [exe, "--kiosk", url, "--edge-kiosk-type=fullscreen", "--no-first-run", "--new-window"]
            safe_print("Браузер: Edge kiosk")
        else:
            args = [exe, "--kiosk", "--new-window", "--no-first-run", url]
            safe_print("Браузер: Chrome kiosk")
        try:
            subprocess.Popen(
                args,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creation_flags,
            )
            return
        except Exception as exc:
            safe_print(f"Не удалось открыть kiosk-режим, fallback в обычный браузер: {exc}")
    webbrowser.open(url)


def main() -> None:
    parser = argparse.ArgumentParser(description="Локальный сканер актов УП")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--no-tray", action="store_true")
    parser.add_argument("--no-kiosk", action="store_true")
    args = parser.parse_args()

    server, url = run_server(args.host, args.port)
    safe_print(f"Открывай: {url}")
    safe_print(f"Новые документы: {NEW_DIR}")
    safe_print(f"Старые документы: {OLD_DIR}")
    if not args.no_browser:
        webbrowser.open(url)

    exit_event = get_exit_event()
    exit_event.clear()
    tray = None if args.no_tray else create_tray_icon(
        url,
        shutdown_app,
        on_open=lambda: webbrowser.open(url),
        on_open_kiosk=lambda: open_browser(url, kiosk=True),
    )
    set_tray_icon(tray)
    try:
        if tray:
            tray.run()
        else:
            while not exit_event.is_set():
                exit_event.wait(3600)
    except KeyboardInterrupt:
        pass
    finally:
        shutdown_app()
        server.server_close()
