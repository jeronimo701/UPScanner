from __future__ import annotations

import base64
import io
import json
import os
import re
import shutil
import subprocess
import threading
import zipfile
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .config import EXPORTS_DIR, NEW_DIR, OLD_DIR, ROOT, SUPPORTED_EXTENSIONS, WEB_DIR
from .parsers import clear_index, document_to_dict, scan_documents
from .serial_io import (
    get_scan_events_since,
    list_serial_ports,
    serial_status,
    start_serial_reader,
    stop_serial_reader,
)
from .storage import (
    append_not_found_scan,
    get_parser_profiles_bundle,
    get_project_comments,
    get_project_parser_profile,
    get_project_scan_progress,
    get_project_item_states,
    load_not_found_scans,
    load_projects,
    rename_project,
    save_projects,
    set_active_parser_profile,
    set_project_comment,
    set_project_parser_profile,
    set_project_scan_progress,
    set_project_item_states,
)
from .utils import normalize_space

HTTP_SERVER: ThreadingHTTPServer | None = None
TRAY_ICON: Any = None
EXIT_EVENT = threading.Event()
DOCS_CACHE: dict[str, list[dict[str, Any]]] = {}
PROJECTS_SUMMARY_CACHE: list[dict[str, Any]] | None = None
CACHE_LOCK = threading.Lock()


def json_response(handler: BaseHTTPRequestHandler, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def binary_response(
    handler: BaseHTTPRequestHandler,
    body: bytes,
    content_type: str,
    filename: str | None = None,
    extra_headers: dict[str, str] | None = None,
    status: HTTPStatus = HTTPStatus.OK,
) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    if filename:
        safe_name = re.sub(r"[^\w.\-]+", "_", filename)
        handler.send_header("Content-Disposition", f'attachment; filename="{safe_name}"')
    if extra_headers:
        for key, value in extra_headers.items():
            handler.send_header(key, value)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def load_ui_file(name: str) -> bytes:
    path = WEB_DIR / name
    if not path.exists():
        return f"Missing UI file: {name}".encode("utf-8")
    return path.read_bytes()


def _sanitize_folder_name(value: str) -> str:
    text = normalize_space(value)
    text = re.sub(r'[<>:"/\\|?*]+', "_", text)
    text = re.sub(r"\s+", "_", text).strip("._ ")
    return text or "project"


def _safe_doc_path(file_id: str, must_be_in: Path | None = None) -> Path:
    rel = normalize_space(file_id)
    if not rel:
        raise ValueError("Пустой идентификатор файла")
    source = (ROOT / rel).resolve()
    source.relative_to(ROOT.resolve())
    if must_be_in is not None:
        source.relative_to(must_be_in.resolve())
    return source


def _resolve_existing_doc_path(file_id: str) -> Path | None:
    try:
        direct = _safe_doc_path(file_id)
        if direct.exists() and direct.is_file():
            return direct
    except Exception:
        pass
    filename = Path(normalize_space(file_id)).name
    if not filename:
        return None
    for base in (NEW_DIR, OLD_DIR):
        for candidate in base.rglob(filename):
            if candidate.is_file():
                return candidate.resolve()
    return None


def _collect_project_files(project: str, location: str) -> list[str]:
    project_key = normalize_space(project)
    if not project_key:
        return []
    docs = scan_documents("old" if location == "old" else "new")
    return [doc.id for doc in docs if normalize_space(doc.project) == project_key]


def _projects_summary(refresh: bool = False) -> list[dict[str, Any]]:
    buckets: dict[tuple[str, str], dict[str, Any]] = {}
    for location in ("new", "old"):
        docs = scan_documents(location, force_refresh=refresh)
        for doc in docs:
            project = normalize_space(doc.project)
            if not project:
                continue
            key = (location, project)
            row = buckets.setdefault(
                key,
                {
                    "project": project,
                    "location": location,
                    "docs_count": 0,
                    "items_count": 0,
                    "files": [],
                    "parser_profile": get_project_parser_profile(project, location),
                },
            )
            row["docs_count"] += 1
            row["items_count"] += len(doc.items)
            row["files"].append(doc.id)
    return sorted(buckets.values(), key=lambda x: (x["location"], x["project"].lower()))


def _invalidate_cache(location: str | None = None) -> None:
    global PROJECTS_SUMMARY_CACHE
    with CACHE_LOCK:
        if location:
            DOCS_CACHE.pop("old" if location == "old" else "new", None)
        else:
            DOCS_CACHE.clear()
        PROJECTS_SUMMARY_CACHE = None


def _get_documents(location: str, refresh: bool = False) -> list[dict[str, Any]]:
    key = "old" if location == "old" else "new"
    with CACHE_LOCK:
        if not refresh and key in DOCS_CACHE:
            return DOCS_CACHE[key]
    docs = [document_to_dict(doc) for doc in scan_documents(key, force_refresh=refresh)]
    with CACHE_LOCK:
        DOCS_CACHE[key] = docs
    return docs


def _get_projects_summary(refresh: bool = False) -> list[dict[str, Any]]:
    global PROJECTS_SUMMARY_CACHE
    with CACHE_LOCK:
        if not refresh and PROJECTS_SUMMARY_CACHE is not None:
            return PROJECTS_SUMMARY_CACHE
    summary = _projects_summary(refresh=refresh)
    with CACHE_LOCK:
        PROJECTS_SUMMARY_CACHE = summary
    return summary


def _finish_project(files: list[str], project: str, parser_profile: str = "") -> dict[str, Any]:
    if not files:
        return {"ok": False, "error": "Не выбраны документы"}
    project_name = normalize_space(project)
    if not project_name:
        return {"ok": False, "error": "Не задано название проекта"}

    date_part = datetime.now().strftime("%Y-%m-%d")
    folder_name = f"{_sanitize_folder_name(project_name)}_{date_part}"
    target_root = OLD_DIR / folder_name
    target_root.mkdir(parents=True, exist_ok=True)

    projects = load_projects()
    moved: list[str] = []
    for file_id in files:
        rel = normalize_space(file_id)
        source = _safe_doc_path(rel, must_be_in=NEW_DIR)
        if not source.exists():
            return {"ok": False, "error": f"Файл не найден: {rel}"}

        target = target_root / source.name
        if target.exists():
            target = target.with_name(f"{target.stem}_{datetime.now():%Y%m%d_%H%M%S}{target.suffix}")
        source.replace(target)
        target_rel = target.relative_to(ROOT).as_posix()
        projects.pop(rel, None)
        projects[target_rel] = project_name
        moved.append(target_rel)

    save_projects(projects)
    chosen_profile = normalize_space(parser_profile) or get_project_parser_profile(project_name, "new")
    if chosen_profile:
        set_project_parser_profile(project_name, "old", chosen_profile)
    return {"ok": True, "folder": target_root.relative_to(ROOT).as_posix(), "moved": moved}


def _write_uploads(files: list[dict[str, Any]]) -> dict[str, Any]:
    if not files:
        return {"ok": False, "error": "Нет файлов для загрузки"}
    NEW_DIR.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
    skipped: list[str] = []
    for item in files:
        name = Path(normalize_space(item.get("name"))).name
        if not name:
            skipped.append("без имени")
            continue
        ext = Path(name).suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            skipped.append(name)
            continue
        raw_b64 = normalize_space(item.get("content_b64"))
        if not raw_b64:
            skipped.append(name)
            continue
        try:
            content = base64.b64decode(raw_b64, validate=True)
        except Exception:
            skipped.append(name)
            continue
        target = NEW_DIR / name
        if target.exists():
            target = target.with_name(f"{target.stem}_{datetime.now():%Y%m%d_%H%M%S}{target.suffix}")
        target.write_bytes(content)
        saved.append(target.relative_to(ROOT).as_posix())
    if not saved:
        return {"ok": False, "error": "Не удалось сохранить подходящие файлы в Acts/new", "saved": [], "skipped": skipped}
    return {"ok": True, "saved": saved, "skipped": skipped}


def _delete_documents(files: list[str]) -> dict[str, Any]:
    if not files:
        return {"ok": False, "error": "Не выбраны документы"}

    new_root = NEW_DIR.resolve()
    old_root = OLD_DIR.resolve()
    paths: list[tuple[str, Path]] = []
    seen: set[Path] = set()
    for file_id in files:
        rel = normalize_space(file_id)
        try:
            source = _safe_doc_path(rel)
            source.relative_to(new_root)
        except ValueError:
            try:
                source = _safe_doc_path(rel)
                source.relative_to(old_root)
            except ValueError:
                return {"ok": False, "error": f"Недопустимый путь: {rel}"}
        if not source.is_file() or source.suffix.lower() not in SUPPORTED_EXTENSIONS:
            return {"ok": False, "error": f"Документ не найден: {rel}"}
        if source not in seen:
            seen.add(source)
            paths.append((rel, source))

    projects = load_projects()
    deleted: list[str] = []
    for rel, source in paths:
        source.unlink()
        projects.pop(rel, None)
        deleted.append(rel)
        base_dir = new_root if source.is_relative_to(new_root) else old_root
        parent = source.parent
        while parent != base_dir:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent

    save_projects(projects)
    clear_index()
    return {"ok": True, "deleted": deleted}


def _zip_documents(files: list[str]) -> tuple[bytes, str] | None:
    if not files:
        return None
    buffer = io.BytesIO()
    unique_paths: list[Path] = []
    seen: set[str] = set()
    for file_id in files:
        source = _resolve_existing_doc_path(file_id)
        if not source:
            continue
        key = source.as_posix().lower()
        if key in seen:
            continue
        seen.add(key)
        unique_paths.append(source)
    if not unique_paths:
        return None
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for source in unique_paths:
            zf.write(source, arcname=source.name)
    name = f"up_docs_{datetime.now():%Y%m%d_%H%M%S}.zip"
    return buffer.getvalue(), name


def _build_print_rows(files: list[str], project: str, location: str) -> list[dict[str, Any]]:
    source_docs = scan_documents("old" if location == "old" else "new")
    by_id = {doc.id: doc for doc in source_docs}
    selected = [by_id[file_id] for file_id in files if file_id in by_id]
    if not selected and project:
        selected = [doc for doc in source_docs if normalize_space(doc.project) == normalize_space(project)]
    aggregate: dict[str, dict[str, Any]] = {}
    for doc in selected:
        for item in doc.items:
            row = aggregate.setdefault(
                item.code,
                {"code": item.code, "name": item.name, "qty": 0.0, "scanned": 0.0, "docs": [], "comment": ""},
            )
            row["qty"] += float(item.qty or 0)
            row["docs"].append(doc.name)
    return sorted(aggregate.values(), key=lambda r: str(r.get("code", "")))


def _make_print_pdf(rows: list[dict[str, Any]], project: str, location: str) -> bytes:
    def sanitize(text: str) -> str:
        plain = (text or "").replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        return plain.encode("ascii", "replace").decode("ascii")

    lines: list[str] = [f"Project: {project or '-'} ({location})", "", "Code | Name | Scanned/Need", "-" * 90]
    for row in rows:
        code = sanitize(str(row.get("code", "")))
        name = sanitize(str(row.get("name", "")))
        qty = float(row.get("qty") or 0)
        scanned = float(row.get("scanned") or 0)
        short_name = name[:60] + ("..." if len(name) > 60 else "")
        lines.append(f"{code} | {short_name} | {scanned:g}/{qty:g}")

    content_lines = ["BT", "/F1 10 Tf", "40 800 Td"]
    first = True
    for line in lines:
        if first:
            content_lines.append(f"({line}) Tj")
            first = False
        else:
            content_lines.append("0 -14 Td")
            content_lines.append(f"({line}) Tj")
    content_lines.append("ET")
    stream = ("\n".join(content_lines) + "\n").encode("latin-1", "replace")

    objects: list[bytes] = []
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objects.append(
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
    )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    objects.append(b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"endstream")

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
    offsets = [0]
    for i, obj in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode("ascii"))
        out.write(obj)
        out.write(b"\nendobj\n")
    xref_pos = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    out.write(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        out.write(f"{off:010d} 00000 n \n".encode("ascii"))
    out.write(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
    )
    return out.getvalue()


def _resolve_folder_for_open(payload: dict[str, Any]) -> Path:
    files = payload.get("files") or []
    project = normalize_space(payload.get("project"))
    location = normalize_space(payload.get("location")).lower() or "new"
    if files:
        path = _resolve_existing_doc_path(str(files[0]))
        if path:
            return path.parent
    if project and location == "old":
        slug = _sanitize_folder_name(project)
        for entry in sorted(OLD_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if entry.is_dir() and entry.name.startswith(f"{slug}_"):
                return entry
    return OLD_DIR if location == "old" else NEW_DIR


def _open_folder(path: Path) -> None:
    target = path.resolve()
    try:
        os.startfile(str(target))  # type: ignore[attr-defined]
        return
    except Exception:
        pass
    windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
    explorer = windir / "explorer.exe"
    if explorer.exists():
        subprocess.Popen([str(explorer), str(target)])
        return
    subprocess.Popen(["explorer", str(target)])


def _find_pdf_browser() -> str | None:
    candidates = [
        "msedge.exe",
        "msedge",
        "chrome.exe",
        "chrome",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for item in candidates:
        if "\\" in item:
            if Path(item).exists():
                return item
            continue
        found = shutil.which(item)
        if found:
            return found
    return None


def _render_pdf_from_html(html: str, project: str) -> tuple[bytes, str]:
    browser = _find_pdf_browser()
    if not browser:
        raise RuntimeError("Не найден Edge/Chrome для рендера PDF")
    filename = f"print_{_sanitize_folder_name(project or 'project')}_{datetime.now():%Y%m%d_%H%M%S}.pdf"
    tmp_root = EXPORTS_DIR / ".tmp_render"
    tmp_root.mkdir(parents=True, exist_ok=True)
    tmp = tmp_root / f"up_pdf_{datetime.now():%Y%m%d_%H%M%S_%f}_{os.getpid()}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        html_path = tmp / "print.html"
        pdf_path = tmp / filename
        user_data_dir = tmp / "browser_profile"
        user_data_dir.mkdir(parents=True, exist_ok=True)
        html_path.write_text(html, encoding="utf-8")
        cmd = [
            browser,
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-crashpad",
            "--disable-breakpad",
            "--allow-file-access-from-files",
            "--no-pdf-header-footer",
            f"--user-data-dir={user_data_dir}",
            f"--print-to-pdf={pdf_path}",
            html_path.resolve().as_uri(),
        ]
        run_env = os.environ.copy()
        tmp_env = str(tmp.resolve())
        run_env["TMP"] = tmp_env
        run_env["TEMP"] = tmp_env
        completed = subprocess.run(cmd, capture_output=True, text=True, timeout=60, env=run_env)
        if completed.returncode != 0 or (not pdf_path.exists()) or pdf_path.stat().st_size == 0:
            err = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(f"Рендер PDF не удался: {err or 'unknown error'}")
        return pdf_path.read_bytes(), filename
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/documents":
            query = parse_qs(parsed.query)
            location = query.get("location", ["new"])[0]
            refresh = normalize_space(query.get("refresh", ["0"])[0]).lower() in {"1", "true", "yes"}
            json_response(self, _get_documents(location, refresh=refresh))
            return
        if parsed.path == "/api/scans":
            query = parse_qs(parsed.query)
            since = int(query.get("since", ["0"])[0] or 0)
            json_response(self, get_scan_events_since(since))
            return
        if parsed.path == "/api/serial/ports":
            json_response(self, list_serial_ports())
            return
        if parsed.path == "/api/serial/status":
            json_response(self, serial_status())
            return
        if parsed.path == "/api/ping":
            json_response(self, {"ok": True})
            return
        if parsed.path == "/api/not-found":
            json_response(self, {"ok": True, "items": load_not_found_scans()})
            return
        if parsed.path == "/api/manual-comments":
            query = parse_qs(parsed.query)
            project = normalize_space(query.get("project", [""])[0])
            json_response(self, {"ok": True, "project": project, "comments": get_project_comments(project)})
            return
        if parsed.path == "/api/scan-progress":
            query = parse_qs(parsed.query)
            project = normalize_space(query.get("project", [""])[0])
            json_response(self, {"ok": True, "project": project, "scanned": get_project_scan_progress(project)})
            return
        if parsed.path == "/api/item-states":
            query = parse_qs(parsed.query)
            project = normalize_space(query.get("project", [""])[0])
            json_response(self, {"ok": True, "project": project, "states": get_project_item_states(project)})
            return
        if parsed.path == "/api/projects-summary":
            query = parse_qs(parsed.query)
            refresh = normalize_space(query.get("refresh", ["0"])[0]).lower() in {"1", "true", "yes"}
            json_response(self, {"ok": True, "items": _get_projects_summary(refresh=refresh)})
            return
        if parsed.path == "/api/parser/profiles":
            bundle = get_parser_profiles_bundle()
            json_response(self, {"ok": True, "active": bundle.get("active"), "profiles": bundle.get("profiles", {})})
            return
        if parsed.path == "/":
            body = load_ui_file("index.html")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/static/style.css":
            body = load_ui_file("style.css")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/css; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/static/app.js":
            body = load_ui_file("app.js")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/project/bulk":
            payload = self.read_json()
            files = payload.get("files") or []
            project = normalize_space(payload.get("project"))
            parser_profile = normalize_space(payload.get("parser_profile"))
            projects = load_projects()
            for file_id in files:
                key = normalize_space(file_id)
                if not key:
                    continue
                if project:
                    projects[key] = project
                else:
                    projects.pop(key, None)
            save_projects(projects)
            if project:
                set_project_parser_profile(project, "new", parser_profile or "")
            _invalidate_cache()
            json_response(self, {"ok": True})
            return
        if parsed.path == "/api/project/rename":
            payload = self.read_json()
            ok, result = rename_project(payload.get("old_project"), payload.get("new_project"))
            if ok:
                _invalidate_cache()
                json_response(self, {"ok": True, "changed": int(result or 0)})
            else:
                json_response(self, {"ok": False, "error": result}, HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/project/finish":
            payload = self.read_json()
            files = payload.get("files") or []
            project = payload.get("project") or ""
            parser_profile = normalize_space(payload.get("parser_profile"))
            result = _finish_project(files, project, parser_profile=parser_profile)
            if result.get("ok"):
                _invalidate_cache()
            json_response(self, result, HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/project":
            payload = self.read_json()
            file_id = normalize_space(payload.get("file"))
            project = normalize_space(payload.get("project"))
            projects = load_projects()
            if project:
                projects[file_id] = project
            else:
                projects.pop(file_id, None)
            save_projects(projects)
            _invalidate_cache()
            json_response(self, {"ok": True})
            return
        if parsed.path == "/api/parser/profile":
            payload = self.read_json()
            ok, result = set_active_parser_profile(payload.get("name"))
            if not ok:
                json_response(self, {"ok": False, "error": result}, HTTPStatus.BAD_REQUEST)
                return
            clear_index()
            _invalidate_cache()
            json_response(self, {"ok": True, "active": result})
            return
        if parsed.path == "/api/manual-comments":
            payload = self.read_json()
            ok = set_project_comment(payload.get("project"), payload.get("code"), payload.get("comment"))
            if not ok:
                json_response(self, {"ok": False, "error": "Нужны project и code"}, HTTPStatus.BAD_REQUEST)
                return
            json_response(self, {"ok": True})
            return
        if parsed.path == "/api/scan-progress":
            payload = self.read_json()
            ok = set_project_scan_progress(payload.get("project"), payload.get("scanned") or {})
            if not ok:
                json_response(self, {"ok": False, "error": "Нужны project и scanned"}, HTTPStatus.BAD_REQUEST)
                return
            json_response(self, {"ok": True})
            return
        if parsed.path == "/api/item-states":
            payload = self.read_json()
            ok = set_project_item_states(payload.get("project"), payload.get("states") or {})
            if not ok:
                json_response(self, {"ok": False, "error": "Нужны project и states"}, HTTPStatus.BAD_REQUEST)
                return
            json_response(self, {"ok": True})
            return
        if parsed.path == "/api/upload":
            payload = self.read_json()
            result = _write_uploads(payload.get("files") or [])
            if result.get("ok"):
                _invalidate_cache("new")
            json_response(self, result, HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/documents/delete":
            payload = self.read_json()
            result = _delete_documents(payload.get("files") or [])
            if result.get("ok"):
                _invalidate_cache()
            json_response(self, result, HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/download":
            payload = self.read_json()
            files = payload.get("files") or []
            project = normalize_space(payload.get("project"))
            location = normalize_space(payload.get("location")).lower() or "new"
            kind = normalize_space(payload.get("kind")).lower()
            if kind == "print_pdf":
                rows = payload.get("rows") or []
                if not rows:
                    base_rows = _build_print_rows(files, project, location)
                    progress = get_project_scan_progress(project) if project else {}
                    for row in base_rows:
                        row["scanned"] = float(progress.get(str(row.get("code", "")).upper(), 0))
                    rows = base_rows
                try:
                    pdf = _make_print_pdf(rows, project, location)
                except Exception as exc:
                    json_response(self, {"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
                    return
                filename = f"print_{_sanitize_folder_name(project or 'project')}_{datetime.now():%Y%m%d_%H%M%S}.pdf"
                EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
                saved_path = EXPORTS_DIR / filename
                saved_path.write_bytes(pdf)
                rel_saved = saved_path.relative_to(ROOT).as_posix()
                binary_response(
                    self,
                    pdf,
                    "application/pdf",
                    filename=filename,
                    extra_headers={"X-Saved-Path": rel_saved},
                )
                return
            if (not files) and project:
                files = _collect_project_files(project, location)
            bundle = _zip_documents(files)
            if not bundle:
                json_response(self, {"ok": False, "error": "Нет файлов для скачивания"}, HTTPStatus.BAD_REQUEST)
                return
            body, filename = bundle
            binary_response(self, body, "application/zip", filename=filename)
            return
        if parsed.path == "/api/download-print-pdf":
            payload = self.read_json()
            html = payload.get("html")
            project = normalize_space(payload.get("project"))
            if not isinstance(html, str) or not html.strip():
                json_response(self, {"ok": False, "error": "Пустой HTML для рендера"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                pdf_bytes, filename = _render_pdf_from_html(html, project)
            except Exception as exc:
                json_response(self, {"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            binary_response(self, pdf_bytes, "application/pdf", filename=filename)
            return
        if parsed.path == "/api/open-project-folder":
            payload = self.read_json()
            try:
                target = _resolve_folder_for_open(payload).resolve()
                target.relative_to(ROOT.resolve())
            except Exception:
                json_response(self, {"ok": False, "error": "Некорректный путь"}, HTTPStatus.BAD_REQUEST)
                return
            target.mkdir(parents=True, exist_ok=True)
            try:
                _open_folder(target)
            except Exception as exc:
                json_response(self, {"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            json_response(self, {"ok": True, "folder": target.relative_to(ROOT).as_posix()})
            return
        if parsed.path == "/api/open-exports-folder":
            try:
                EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
                _open_folder(EXPORTS_DIR)
            except Exception as exc:
                json_response(self, {"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            json_response(self, {"ok": True, "folder": EXPORTS_DIR.relative_to(ROOT).as_posix()})
            return
        if parsed.path == "/api/serial/start":
            payload = self.read_json()
            port = normalize_space(payload.get("port"))
            baudrate = int(payload.get("baudrate") or 9600)
            result = start_serial_reader(port, baudrate)
            json_response(self, result, HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/serial/stop":
            stop_serial_reader()
            json_response(self, {"ok": True})
            return
        if parsed.path == "/api/move-to-old":
            payload = self.read_json()
            file_id = normalize_space(payload.get("file"))
            try:
                source = _safe_doc_path(file_id, must_be_in=NEW_DIR)
            except Exception:
                json_response(self, {"ok": False, "error": "Файл не внутри Acts/new"}, HTTPStatus.BAD_REQUEST)
                return
            if not source.exists():
                json_response(self, {"ok": False, "error": "Файл не найден"}, HTTPStatus.NOT_FOUND)
                return
            target = OLD_DIR / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target = target.with_name(f"{target.stem}_{datetime.now():%Y%m%d_%H%M%S}{target.suffix}")
            source.replace(target)
            _invalidate_cache()
            json_response(self, {"ok": True, "target": target.relative_to(ROOT).as_posix()})
            return
        if parsed.path == "/api/shutdown":
            json_response(self, {"ok": True})
            threading.Thread(target=shutdown_app, daemon=True).start()
            return
        if parsed.path == "/api/not-found":
            payload = self.read_json()
            append_not_found_scan(payload)
            json_response(self, {"ok": True})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def log_message(self, fmt: str, *args: Any) -> None:
        return


def set_tray_icon(icon: Any) -> None:
    global TRAY_ICON
    TRAY_ICON = icon


def get_exit_event() -> threading.Event:
    return EXIT_EVENT


def shutdown_app() -> None:
    global HTTP_SERVER, TRAY_ICON
    stop_serial_reader()
    EXIT_EVENT.set()
    if TRAY_ICON:
        try:
            TRAY_ICON.stop()
        except Exception:
            pass
        TRAY_ICON = None
    if HTTP_SERVER:
        threading.Thread(target=HTTP_SERVER.shutdown, daemon=True).start()
        HTTP_SERVER = None


def run_server(host: str, port: int) -> tuple[ThreadingHTTPServer, str]:
    global HTTP_SERVER
    NEW_DIR.mkdir(parents=True, exist_ok=True)
    OLD_DIR.mkdir(parents=True, exist_ok=True)
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((host, port), Handler)
    HTTP_SERVER = server
    url = f"http://{host}:{port}/"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, url
