from __future__ import annotations

import webbrowser
import sys
from pathlib import Path
from typing import Any, Callable

from .config import ROOT
from .utils import safe_print


def create_tray_icon(
    url: str,
    on_exit: Callable[[], None],
    on_open: Callable[[], None] | None = None,
    on_open_kiosk: Callable[[], None] | None = None,
) -> Any:
    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception as exc:
        safe_print(f"Tray недоступен, работаю в консоли: {exc}")
        return None

    resource_root = Path(getattr(sys, "_MEIPASS", ROOT))
    icon_path = resource_root / "assets" / "up_scanner_duck.png"
    if not icon_path.exists():
        icon_path = ROOT / "assets" / "up_scanner_duck.png"
    try:
        icon = Image.open(icon_path).convert("RGBA")
        icon.thumbnail((64, 64), Image.Resampling.LANCZOS)
        image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        image.paste(icon, ((64 - icon.width) // 2, (64 - icon.height) // 2), icon)
    except Exception:
        image = Image.new("RGBA", (64, 64), (23, 107, 135, 255))
        draw = ImageDraw.Draw(image)
        draw.rectangle((10, 10, 54, 54), outline=(255, 255, 255, 255), width=4)
        draw.text((20, 22), "UP", fill=(255, 255, 255, 255))

    def open_app(_: Any = None) -> None:
        if on_open:
            on_open()
        else:
            webbrowser.open(url)

    def open_kiosk(_: Any = None) -> None:
        if on_open_kiosk:
            on_open_kiosk()
        else:
            webbrowser.open(url)

    def exit_app(icon: Any, _: Any = None) -> None:
        on_exit()
        icon.stop()

    return pystray.Icon(
        "UP scanner",
        image,
        "Сканирование УП",
        menu=pystray.Menu(
            pystray.MenuItem("Открыть приложение", open_app),
            pystray.MenuItem("Kiosk mode (Edge/Chrome)", open_kiosk),
            pystray.MenuItem("Выход", exit_app),
        ),
    )
