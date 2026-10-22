from __future__ import annotations

import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from .config import DOC_RE


def safe_print(message: str) -> None:
    stream = getattr(sys, "stdout", None)
    if not stream:
        return
    try:
        stream.write(f"{message}\n")
        stream.flush()
    except Exception:
        pass


def normalize_space(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\xa0", " ")).strip()


def normalize_code(value: Any) -> str:
    return normalize_space(value).upper()


def parse_qty(value: Any, default: float = 1.0) -> float:
    if value in (None, ""):
        return default
    text = normalize_space(value).replace(",", ".")
    try:
        return float(Decimal(re.sub(r"[^\d.]", "", text)))
    except (InvalidOperation, ValueError):
        return default


def doc_meta_from_name(path: Path, text_hint: str = "", doc_re: re.Pattern[str] | None = None) -> tuple[str, str, str]:
    source = f"{path.stem} {text_hint[:250]}"
    pattern = doc_re or DOC_RE
    match = pattern.search(source)
    if match:
        number = normalize_space(match.group(1))
        date = normalize_space(match.group(2)).replace(" ", ".")
        return f"{number} от {date}", number, date
    return path.stem, "", ""
