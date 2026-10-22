from __future__ import annotations

import json
import re
import sqlite3
import threading
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from .config import (
    CODE_RE,
    COMMENT_HEADERS,
    DOC_RE,
    INDEX_DB_FILE,
    NEW_DIR,
    OLD_DIR,
    QTY_RE,
    ROOT,
    ROW_START_RE,
    STOP_PREFIXES,
    SUPPORTED_EXTENSIONS,
)
from .models import Document, Item
from .storage import get_parser_profiles_bundle, load_projects
from .utils import doc_meta_from_name, normalize_code, normalize_space, parse_qty

_DB_LOCK = threading.Lock()
_SCHEMA_READY = False


def _db_conn() -> sqlite3.Connection:
    INDEX_DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(INDEX_DB_FILE))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _ensure_schema() -> None:
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    with _DB_LOCK:
        if _SCHEMA_READY:
            return
        with _db_conn() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    rel_path TEXT PRIMARY KEY,
                    location TEXT NOT NULL,
                    name TEXT NOT NULL,
                    number TEXT NOT NULL,
                    date TEXT NOT NULL,
                    ext TEXT NOT NULL,
                    modified TEXT NOT NULL,
                    warnings_json TEXT NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    size INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_documents_location ON documents(location);

                CREATE TABLE IF NOT EXISTS items (
                    rel_path TEXT NOT NULL,
                    row_idx INTEGER NOT NULL,
                    code TEXT NOT NULL,
                    name TEXT NOT NULL,
                    qty REAL NOT NULL,
                    comment TEXT NOT NULL,
                    row_ref TEXT NOT NULL,
                    PRIMARY KEY (rel_path, row_idx)
                );
                CREATE INDEX IF NOT EXISTS idx_items_rel_path ON items(rel_path);
                """
            )
        _SCHEMA_READY = True


def clear_index(location: str | None = None) -> None:
    _ensure_schema()
    with _DB_LOCK:
        with _db_conn() as conn:
            if location in {"new", "old"}:
                conn.execute("DELETE FROM items WHERE rel_path IN (SELECT rel_path FROM documents WHERE location = ?)", (location,))
                conn.execute("DELETE FROM documents WHERE location = ?", (location,))
            else:
                conn.execute("DELETE FROM items")
                conn.execute("DELETE FROM documents")


def _compile_regex(pattern: str, fallback: str, flags: int = 0) -> re.Pattern[str]:
    try:
        return re.compile(pattern, flags)
    except re.error:
        return re.compile(fallback, flags)


def _normalize_keywords(values: Any, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(values, list):
        return fallback
    clean = tuple(normalize_space(x).lower() for x in values if normalize_space(x))
    return clean or fallback


def _active_profile() -> tuple[str, dict[str, Any]]:
    bundle = get_parser_profiles_bundle()
    profiles = bundle.get("profiles") if isinstance(bundle.get("profiles"), dict) else {}
    active = normalize_space(bundle.get("active"))
    raw = profiles.get(active) if isinstance(profiles, dict) else None
    if not isinstance(raw, dict):
        active = "poscenter"
        raw = profiles.get(active) if isinstance(profiles, dict) else {}
    if not isinstance(raw, dict):
        raw = {}

    excel_raw = raw.get("excel_headers") if isinstance(raw.get("excel_headers"), dict) else {}
    default_headers = {
        "code": ("код товара", "артикул", "код"),
        "name": ("наимен", "номенклатура", "товар"),
        "qty": ("колич",),
        "comment": tuple(normalize_space(x).lower() for x in COMMENT_HEADERS),
    }
    stop_prefixes_default = tuple(normalize_space(x).lower() for x in STOP_PREFIXES)

    return active or "poscenter", {
        "code_re": _compile_regex(
            normalize_space(raw.get("code_pattern")) or CODE_RE.pattern,
            CODE_RE.pattern,
            re.IGNORECASE,
        ),
        "doc_re": _compile_regex(
            normalize_space(raw.get("doc_pattern")) or DOC_RE.pattern,
            DOC_RE.pattern,
            re.IGNORECASE,
        ),
        "row_start_re": _compile_regex(
            normalize_space(raw.get("row_start_pattern")) or ROW_START_RE.pattern,
            ROW_START_RE.pattern,
        ),
        "qty_re": _compile_regex(
            normalize_space(raw.get("qty_pattern")) or QTY_RE.pattern,
            QTY_RE.pattern,
            re.IGNORECASE | re.DOTALL,
        ),
        "stop_prefixes": _normalize_keywords(raw.get("stop_prefixes"), stop_prefixes_default),
        "excel_headers": {
            "code": _normalize_keywords(excel_raw.get("code"), default_headers["code"]),
            "name": _normalize_keywords(excel_raw.get("name"), default_headers["name"]),
            "qty": _normalize_keywords(excel_raw.get("qty"), default_headers["qty"]),
            "comment": _normalize_keywords(excel_raw.get("comment"), default_headers["comment"]),
        },
    }


def parse_pdf(path: Path) -> Document:
    try:
        from pypdf import PdfReader
    except ModuleNotFoundError:
        try:
            from PyPDF2 import PdfReader  # type: ignore
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "PDF parser module is missing (pypdf/PyPDF2). Install dependencies: "
                "python -m pip install -r requirements.txt"
            ) from exc

    _, profile = _active_profile()
    reader = PdfReader(str(path))
    text = "\n".join((page.extract_text() or "") for page in reader.pages).replace("\xa0", " ")
    display_name, number, date = doc_meta_from_name(path, text, doc_re=profile["doc_re"])
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    raw_items: list[dict[str, str]] = []
    current: dict[str, str] | None = None

    for line in lines:
        row_match = profile["row_start_re"].match(line)
        if row_match:
            if current:
                raw_items.append(current)
            current = {
                "row": row_match.group(1),
                "code": normalize_code(row_match.group(2)),
                "text": normalize_space(row_match.group(3)),
            }
            continue

        if current:
            if normalize_space(line).lower().startswith(profile["stop_prefixes"]):
                raw_items.append(current)
                current = None
            else:
                current["text"] = normalize_space(f"{current['text']} {line}")

    if current:
        raw_items.append(current)

    items: list[Item] = []
    warnings: list[str] = []
    for raw in raw_items:
        row_text = raw["text"]
        qty_match = profile["qty_re"].search(row_text)
        if qty_match:
            name = normalize_space(qty_match.group(1))
            qty = parse_qty(qty_match.group(2))
        else:
            name = row_text
            qty = 1.0
            warnings.append(f"Could not confidently parse quantity: {raw['code']}")
        items.append(Item(code=raw["code"], name=name, qty=qty, row=raw["row"]))

    return make_document(path, display_name, number, date, items, warnings)


def find_header_map(ws: Any, profile: dict[str, Any]) -> tuple[int, dict[str, int]]:
    best_row = 1
    best: dict[str, int] = {}
    best_score = -1
    header_tokens = profile.get("excel_headers", {})

    def matches(field: str, text: str) -> bool:
        tokens = header_tokens.get(field) if isinstance(header_tokens, dict) else ()
        if not isinstance(tokens, tuple):
            return False
        return any(token and token in text for token in tokens)

    for row in range(1, min(ws.max_row, 30) + 1):
        mapping: dict[str, int] = {}
        for col in range(1, ws.max_column + 1):
            parts = [
                normalize_space(ws.cell(scan_row, col).value)
                for scan_row in range(max(1, row - 1), min(ws.max_row, row + 1) + 1)
            ]
            text = normalize_space(" ".join(parts)).lower()
            if matches("code", text):
                mapping["code"] = col
            elif matches("name", text):
                mapping["name"] = col
            elif matches("qty", text):
                mapping["qty"] = col
            elif matches("comment", text):
                mapping["comment"] = col
        if "code" in mapping and ("name" in mapping or "qty" in mapping):
            return row, mapping
        score = len(mapping) + (4 if "code" in mapping else 0)
        if score > best_score:
            best_row, best, best_score = row, mapping, score
    return best_row, best


def resolve_merged_header_data_column(ws: Any, header_row: int, column: int | None) -> int | None:
    """Use the populated column inside a merged Excel header, when applicable."""
    if not column:
        return column

    candidates = [column]
    merged_candidates = [
        merged_range
        for merged_range in ws.merged_cells.ranges
        if (
            merged_range.min_row <= header_row + 1
            and merged_range.max_row >= header_row - 1
            and merged_range.min_col <= column <= merged_range.max_col
        )
    ]
    if merged_candidates:
        preferred_row = header_row + 1

        def row_distance(merged_range: Any) -> int:
            if merged_range.min_row <= preferred_row <= merged_range.max_row:
                return 0
            return min(
                abs(preferred_row - merged_range.min_row),
                abs(preferred_row - merged_range.max_row),
            )

        merged_range = min(merged_candidates, key=row_distance)
        candidates = list(range(merged_range.min_col, merged_range.max_col + 1))

    if len(candidates) == 1:
        return column

    sample_end = min(ws.max_row, header_row + 20)
    scores = {
        candidate: sum(
            1
            for row in range(header_row + 1, sample_end + 1)
            if normalize_space(ws.cell(row, candidate).value)
        )
        for candidate in candidates
    }
    return max(candidates, key=lambda candidate: (scores[candidate], candidate == column))


def excel_item_position(ws: Any, row: int, code_column: int) -> str:
    """Prefer the visible item number located before the code column."""
    for column in range(code_column - 1, 0, -1):
        value = normalize_space(ws.cell(row, column).value)
        if re.fullmatch(r"\d+", value):
            return value
    return f"{ws.title}!{row}"


def load_excel_workbook(path: Path) -> Any:
    """Load modern and legacy Excel files through the common worksheet interface."""
    if path.suffix.lower() != ".xls":
        from openpyxl import load_workbook

        return load_workbook(path, data_only=True, read_only=False)

    try:
        import xlrd
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "XLS parser module is missing. Install dependencies: "
            "python -m pip install -r requirements.txt"
        ) from exc

    class LegacySheet:
        def __init__(self, sheet: Any) -> None:
            self._sheet = sheet
            self.title = sheet.name
            self.max_row = sheet.nrows
            self.max_column = sheet.ncols
            self.merged_cells = SimpleNamespace(
                ranges=[
                    SimpleNamespace(
                        min_row=row_start + 1,
                        max_row=row_end,
                        min_col=column_start + 1,
                        max_col=column_end,
                    )
                    for row_start, row_end, column_start, column_end in sheet.merged_cells
                ]
            )

        def cell(self, row: int, column: int) -> Any:
            return SimpleNamespace(
                value=self._sheet.cell_value(row - 1, column - 1),
                comment=None,
            )

    workbook = xlrd.open_workbook(str(path), formatting_info=True)
    return SimpleNamespace(worksheets=[LegacySheet(sheet) for sheet in workbook.sheets()])


def parse_xlsx(path: Path) -> Document:
    _, profile = _active_profile()
    wb = load_excel_workbook(path)
    first_sheet = wb.worksheets[0]
    first_values = " ".join(normalize_space(first_sheet.cell(row, col).value) for row in range(1, 4) for col in range(1, 8))
    display_name, number, date = doc_meta_from_name(path, first_values, doc_re=profile["doc_re"])
    items: list[Item] = []
    warnings: list[str] = []

    for ws in wb.worksheets:
        header_row, headers = find_header_map(ws, profile)
        if "code" not in headers:
            continue

        code_col = resolve_merged_header_data_column(ws, header_row, headers["code"])
        name_col = resolve_merged_header_data_column(ws, header_row, headers.get("name"))
        qty_col = resolve_merged_header_data_column(ws, header_row, headers.get("qty"))
        comment_col = resolve_merged_header_data_column(ws, header_row, headers.get("comment"))

        for row in range(header_row + 1, ws.max_row + 1):
            code = normalize_code(ws.cell(row, code_col).value)
            if not profile["code_re"].match(code):
                continue

            name = normalize_space(ws.cell(row, name_col).value) if name_col else ""
            qty = parse_qty(ws.cell(row, qty_col).value if qty_col else None)
            comments: list[str] = []
            if comment_col:
                comment_text = normalize_space(ws.cell(row, comment_col).value)
                if comment_text:
                    comments.append(comment_text)
            for col in (code_col, name_col, qty_col, comment_col):
                if not col:
                    continue
                cell = ws.cell(row, col)
                if cell.comment and normalize_space(cell.comment.text):
                    comments.append(normalize_space(cell.comment.text))

            items.append(
                Item(
                    code=code,
                    name=name,
                    qty=qty,
                    comment="; ".join(dict.fromkeys(comments)),
                    row=excel_item_position(ws, row, code_col),
                )
            )

    if not items:
        warnings.append("No rows with valid UP/6+ digit codes were found.")
    return make_document(path, display_name, number, date, items, warnings)


def make_document(
    path: Path,
    display_name: str,
    number: str,
    date: str,
    items: list[Item],
    warnings: list[str],
    location: str = "new",
) -> Document:
    path = path.resolve()
    rel = path.relative_to(ROOT).as_posix()
    projects = load_projects()
    return Document(
        id=rel,
        file=rel,
        name=display_name,
        number=number,
        date=date,
        ext=path.suffix.lower(),
        modified=datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
        location=location,
        project=projects.get(rel, ""),
        items=items,
        warnings=warnings,
    )


def _iter_location_files(location: str) -> list[Path]:
    NEW_DIR.mkdir(parents=True, exist_ok=True)
    OLD_DIR.mkdir(parents=True, exist_ok=True)
    base_dir = OLD_DIR if location == "old" else NEW_DIR
    return [path for path in sorted(base_dir.rglob("*")) if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS]


def _upsert_document(conn: sqlite3.Connection, doc: Document, rel: str, location: str, mtime_ns: int, size: int) -> None:
    conn.execute(
        """
        INSERT INTO documents (rel_path, location, name, number, date, ext, modified, warnings_json, mtime_ns, size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
            location=excluded.location,
            name=excluded.name,
            number=excluded.number,
            date=excluded.date,
            ext=excluded.ext,
            modified=excluded.modified,
            warnings_json=excluded.warnings_json,
            mtime_ns=excluded.mtime_ns,
            size=excluded.size
        """,
        (
            rel,
            "old" if location == "old" else "new",
            doc.name,
            doc.number,
            doc.date,
            doc.ext,
            doc.modified,
            json.dumps(doc.warnings, ensure_ascii=False),
            int(mtime_ns),
            int(size),
        ),
    )
    conn.execute("DELETE FROM items WHERE rel_path = ?", (rel,))
    if doc.items:
        conn.executemany(
            """
            INSERT INTO items (rel_path, row_idx, code, name, qty, comment, row_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    rel,
                    idx,
                    item.code,
                    item.name,
                    float(item.qty or 0),
                    item.comment or "",
                    item.row or "",
                )
                for idx, item in enumerate(doc.items)
            ],
        )


def _refresh_index(location: str, force_refresh: bool = False) -> None:
    _ensure_schema()
    loc = "old" if location == "old" else "new"
    files = _iter_location_files(loc)

    with _DB_LOCK:
        with _db_conn() as conn:
            rows = conn.execute("SELECT rel_path, mtime_ns, size FROM documents WHERE location = ?", (loc,)).fetchall()
            known = {str(row[0]): (int(row[1]), int(row[2])) for row in rows}
            seen: set[str] = set()

            for path in files:
                stat = path.stat()
                rel = path.resolve().relative_to(ROOT).as_posix()
                seen.add(rel)
                signature = (int(stat.st_mtime_ns), int(stat.st_size))
                if (not force_refresh) and known.get(rel) == signature:
                    continue
                try:
                    doc = parse_pdf(path) if path.suffix.lower() == ".pdf" else parse_xlsx(path)
                    doc.location = loc
                except Exception as exc:
                    doc = make_document(path, path.stem, "", "", [], [f"Read error: {exc}"], location=loc)
                _upsert_document(conn, doc, rel, loc, signature[0], signature[1])

            stale = [rel for rel in known if rel not in seen]
            if stale:
                conn.executemany("DELETE FROM items WHERE rel_path = ?", [(rel,) for rel in stale])
                conn.executemany("DELETE FROM documents WHERE rel_path = ?", [(rel,) for rel in stale])


def _load_from_index(location: str) -> list[Document]:
    _ensure_schema()
    loc = "old" if location == "old" else "new"
    projects = load_projects()
    with _DB_LOCK:
        with _db_conn() as conn:
            doc_rows = conn.execute(
                """
                SELECT rel_path, name, number, date, ext, modified, warnings_json
                FROM documents
                WHERE location = ?
                ORDER BY rel_path
                """,
                (loc,),
            ).fetchall()
            if not doc_rows:
                return []

            rel_paths = [str(row[0]) for row in doc_rows]
            placeholders = ",".join("?" for _ in rel_paths)
            item_rows = conn.execute(
                f"""
                SELECT rel_path, code, name, qty, comment, row_ref
                FROM items
                WHERE rel_path IN ({placeholders})
                ORDER BY rel_path, row_idx
                """,
                rel_paths,
            ).fetchall()

    items_map: dict[str, list[Item]] = {}
    for rel, code, name, qty, comment, row_ref in item_rows:
        key = str(rel)
        items_map.setdefault(key, []).append(
            Item(
                code=str(code or ""),
                name=str(name or ""),
                qty=float(qty or 0),
                comment=str(comment or ""),
                row=str(row_ref or ""),
            )
        )

    docs: list[Document] = []
    for rel, name, number, date, ext, modified, warnings_json in doc_rows:
        key = str(rel)
        warnings = []
        try:
            loaded = json.loads(str(warnings_json or "[]"))
            if isinstance(loaded, list):
                warnings = [str(x) for x in loaded]
        except Exception:
            warnings = []
        docs.append(
            Document(
                id=key,
                file=key,
                name=str(name or ""),
                number=str(number or ""),
                date=str(date or ""),
                ext=str(ext or ""),
                modified=str(modified or ""),
                location=loc,
                project=projects.get(key, ""),
                items=items_map.get(key, []),
                warnings=warnings,
            )
        )
    return docs


def scan_documents(location: str = "new", force_refresh: bool = False) -> list[Document]:
    _refresh_index(location, force_refresh=force_refresh)
    return _load_from_index(location)


def document_to_dict(doc: Document) -> dict[str, Any]:
    data = asdict(doc)
    data["items"] = [asdict(item) for item in doc.items]
    return data
