from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from .config import (
    ACTIVE_PARSER_PROFILE_FILE,
    CODE_RE,
    DATA_DIR,
    DOC_RE,
    MANUAL_COMMENTS_FILE,
    NOT_FOUND_FILE,
    QTY_RE,
    PARSER_PROFILES_FILE,
    PROJECT_PARSER_PROFILES_FILE,
    PROJECTS_FILE,
    PROJECT_ITEM_STATES_FILE,
    ROW_START_RE,
    SCAN_PROGRESS_FILE,
    STOP_PREFIXES,
)
from .utils import normalize_space

DEFAULT_PARSER_PROFILE = "poscenter"


def _default_parser_profiles() -> dict[str, dict[str, Any]]:
    return {
        DEFAULT_PARSER_PROFILE: {
            "label": "POScenter",
            "description": "Default profile for current UP/POScenter exports.",
            "code_pattern": CODE_RE.pattern,
            "doc_pattern": DOC_RE.pattern,
            "row_start_pattern": ROW_START_RE.pattern,
            "qty_pattern": QTY_RE.pattern,
            "stop_prefixes": list(STOP_PREFIXES),
            "excel_headers": {
                "code": ["код товара", "артикул", "код", "РєРѕРґ С‚РѕРІР°СЂР°", "Р°СЂС‚РёРєСѓР»", "РєРѕРґ"],
                "name": ["наимен", "товар", "РЅР°РёРјРµРЅ", "С‚РѕРІР°СЂ"],
                "qty": ["колич", "РєРѕР»РёС‡"],
                "comment": ["\u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440", "\u043f\u0440\u0438\u043c\u0435\u0447", "\u043f\u043e\u043c\u0435\u0442", "\u0437\u0430\u043c\u0435\u0442"],
            },
        }
    }


def load_parser_profiles() -> dict[str, dict[str, Any]]:
    profiles = _default_parser_profiles()
    if not PARSER_PROFILES_FILE.exists():
        return profiles
    try:
        raw = json.loads(PARSER_PROFILES_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return profiles
    if not isinstance(raw, dict):
        return profiles
    merged = dict(profiles)
    for name, body in raw.items():
        key = normalize_space(name)
        if not key or not isinstance(body, dict):
            continue
        merged[key] = {**merged.get(key, {}), **body}
    if DEFAULT_PARSER_PROFILE not in merged:
        merged[DEFAULT_PARSER_PROFILE] = profiles[DEFAULT_PARSER_PROFILE]
    return merged


def save_parser_profiles(profiles: dict[str, dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PARSER_PROFILES_FILE.write_text(json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8")


def load_active_parser_profile() -> str:
    if not ACTIVE_PARSER_PROFILE_FILE.exists():
        return DEFAULT_PARSER_PROFILE
    try:
        raw = json.loads(ACTIVE_PARSER_PROFILE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return DEFAULT_PARSER_PROFILE
    if isinstance(raw, dict):
        return normalize_space(raw.get("active")) or DEFAULT_PARSER_PROFILE
    if isinstance(raw, str):
        return normalize_space(raw) or DEFAULT_PARSER_PROFILE
    return DEFAULT_PARSER_PROFILE


def save_active_parser_profile(name: str) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"active": normalize_space(name) or DEFAULT_PARSER_PROFILE}
    ACTIVE_PARSER_PROFILE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def get_parser_profiles_bundle() -> dict[str, Any]:
    profiles = load_parser_profiles()
    active = load_active_parser_profile()
    if active not in profiles:
        active = DEFAULT_PARSER_PROFILE
    return {"active": active, "profiles": profiles}


def set_active_parser_profile(name: str) -> tuple[bool, str]:
    profiles = load_parser_profiles()
    key = normalize_space(name)
    if key not in profiles:
        return False, f"Unknown profile: {key or name}"
    save_active_parser_profile(key)
    return True, key


def _project_profile_key(project: str, location: str) -> str:
    return f"{normalize_space(location).lower() or 'new'}::{normalize_space(project)}"


def load_project_parser_profiles() -> dict[str, str]:
    if not PROJECT_PARSER_PROFILES_FILE.exists():
        return {}
    try:
        raw = json.loads(PROJECT_PARSER_PROFILES_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, str] = {}
    for key, value in raw.items():
        k = normalize_space(key)
        v = normalize_space(value)
        if k and v:
            clean[k] = v
    return clean


def save_project_parser_profiles(mapping: dict[str, str]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PROJECT_PARSER_PROFILES_FILE.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")


def get_project_parser_profile(project: str, location: str) -> str:
    key = _project_profile_key(project, location)
    return load_project_parser_profiles().get(key, "")


def set_project_parser_profile(project: str, location: str, parser_profile: str) -> bool:
    project_key = normalize_space(project)
    location_key = normalize_space(location).lower() or "new"
    profile_key = normalize_space(parser_profile)
    if not project_key:
        return False
    mapping = load_project_parser_profiles()
    key = _project_profile_key(project_key, location_key)
    if profile_key:
        mapping[key] = profile_key
    else:
        mapping.pop(key, None)
    save_project_parser_profiles(mapping)
    return True


def load_projects() -> dict[str, str]:
    if not PROJECTS_FILE.exists():
        return {}
    try:
        return json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_projects(projects: dict[str, str]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PROJECTS_FILE.write_text(json.dumps(projects, ensure_ascii=False, indent=2), encoding="utf-8")


def append_not_found_scan(entry: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "time": datetime.now().isoformat(),
        "raw": normalize_space(entry.get("raw")),
        "normalized": normalize_space(entry.get("normalized")),
        "location": normalize_space(entry.get("location")),
        "selected": entry.get("selected", []),
    }
    with NOT_FOUND_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def load_not_found_scans(limit: int = 200) -> list[dict[str, Any]]:
    if not NOT_FOUND_FILE.exists():
        return []
    rows: list[dict[str, Any]] = []
    with NOT_FOUND_FILE.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows[-limit:]


def load_manual_comments() -> dict[str, dict[str, str]]:
    if not MANUAL_COMMENTS_FILE.exists():
        return {}
    try:
        data = json.loads(MANUAL_COMMENTS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    clean: dict[str, dict[str, str]] = {}
    for project, items in data.items():
        if not isinstance(items, dict):
            continue
        key = normalize_space(project)
        if not key:
            continue
        clean[key] = {normalize_space(code): normalize_space(text) for code, text in items.items() if normalize_space(code)}
    return clean


def save_manual_comments(data: dict[str, dict[str, str]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MANUAL_COMMENTS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_project_comments(project: str) -> dict[str, str]:
    key = normalize_space(project)
    if not key:
        return {}
    return load_manual_comments().get(key, {})


def set_project_comment(project: str, code: str, comment: str) -> bool:
    project_key = normalize_space(project)
    code_key = normalize_space(code).upper()
    if not project_key or not code_key:
        return False
    text = normalize_space(comment)
    data = load_manual_comments()
    bucket = data.setdefault(project_key, {})
    if text:
        bucket[code_key] = text
    else:
        bucket.pop(code_key, None)
        if not bucket:
            data.pop(project_key, None)
    save_manual_comments(data)
    return True


def load_scan_progress() -> dict[str, dict[str, float]]:
    if not SCAN_PROGRESS_FILE.exists():
        return {}
    try:
        data = json.loads(SCAN_PROGRESS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    clean: dict[str, dict[str, float]] = {}
    for project, items in data.items():
        key = normalize_space(project)
        if not key or not isinstance(items, dict):
            continue
        bucket: dict[str, float] = {}
        for code, value in items.items():
            code_key = normalize_space(code).upper()
            if not code_key:
                continue
            try:
                bucket[code_key] = float(value)
            except (TypeError, ValueError):
                continue
        clean[key] = bucket
    return clean


def save_scan_progress(data: dict[str, dict[str, float]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SCAN_PROGRESS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_project_scan_progress(project: str) -> dict[str, float]:
    key = normalize_space(project)
    if not key:
        return {}
    return load_scan_progress().get(key, {})


def set_project_scan_progress(project: str, scanned: dict[str, Any]) -> bool:
    project_key = normalize_space(project)
    if not project_key:
        return False
    bucket: dict[str, float] = {}
    for code, value in (scanned or {}).items():
        code_key = normalize_space(code).upper()
        if not code_key:
            continue
        try:
            num = float(value)
        except (TypeError, ValueError):
            continue
        if num > 0:
            bucket[code_key] = num
    data = load_scan_progress()
    if bucket:
        data[project_key] = bucket
    else:
        data.pop(project_key, None)
    save_scan_progress(data)
    return True


def _clean_project_item_states(states: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(states, dict):
        return {"statuses": {}, "missing": {}}
    statuses: dict[str, str] = {}
    for code, status in (states.get("statuses") or {}).items():
        code_key = normalize_space(code).upper()
        if code_key and normalize_space(status).lower() == "defect":
            statuses[code_key] = "defect"
    missing: dict[str, dict[str, str]] = {}
    for code, item in (states.get("missing") or {}).items():
        code_key = normalize_space(code).upper()
        if not code_key:
            continue
        created = normalize_space(item.get("created")) if isinstance(item, dict) else ""
        missing[code_key] = {"created": created}
    return {"statuses": statuses, "missing": missing}


def load_project_item_states() -> dict[str, dict[str, dict[str, Any]]]:
    if not PROJECT_ITEM_STATES_FILE.exists():
        return {}
    try:
        data = json.loads(PROJECT_ITEM_STATES_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    clean: dict[str, dict[str, dict[str, Any]]] = {}
    for project, states in data.items():
        key = normalize_space(project)
        if key:
            clean[key] = _clean_project_item_states(states)
    return clean


def save_project_item_states(data: dict[str, dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PROJECT_ITEM_STATES_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_project_item_states(project: str) -> dict[str, dict[str, Any]]:
    key = normalize_space(project)
    if not key:
        return {"statuses": {}, "missing": {}}
    return load_project_item_states().get(key, {"statuses": {}, "missing": {}})


def set_project_item_states(project: str, states: dict[str, Any]) -> bool:
    key = normalize_space(project)
    if not key:
        return False
    cleaned = _clean_project_item_states(states)
    data = load_project_item_states()
    if cleaned["statuses"] or cleaned["missing"]:
        data[key] = cleaned
    else:
        data.pop(key, None)
    save_project_item_states(data)
    return True


def rename_project(old_project: str, new_project: str) -> tuple[bool, str]:
    old_key = normalize_space(old_project)
    new_key = normalize_space(new_project)
    if not old_key or not new_key:
        return False, "Нужно указать старое и новое имя проекта"
    if old_key == new_key:
        return False, "Название не изменилось"

    projects = load_projects()
    changed = 0
    for file_id, project in list(projects.items()):
        if normalize_space(project) == old_key:
            projects[file_id] = new_key
            changed += 1
    save_projects(projects)

    comments = load_manual_comments()
    if old_key in comments:
        merged = comments.setdefault(new_key, {})
        merged.update(comments.pop(old_key))
        save_manual_comments(comments)

    progress = load_scan_progress()
    if old_key in progress:
        merged_progress = progress.setdefault(new_key, {})
        merged_progress.update(progress.pop(old_key))
        save_scan_progress(progress)

    item_states = load_project_item_states()
    if old_key in item_states:
        old_states = item_states.pop(old_key)
        new_states = item_states.setdefault(new_key, {"statuses": {}, "missing": {}})
        new_states.setdefault("statuses", {}).update(old_states.get("statuses", {}))
        new_states.setdefault("missing", {}).update(old_states.get("missing", {}))
        save_project_item_states(item_states)

    profiles = load_project_parser_profiles()
    for location in ("new", "old"):
        old_profile_key = _project_profile_key(old_key, location)
        new_profile_key = _project_profile_key(new_key, location)
        if old_profile_key in profiles:
            profiles[new_profile_key] = profiles.pop(old_profile_key)
    save_project_parser_profiles(profiles)

    return True, str(changed)
