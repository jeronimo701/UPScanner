from __future__ import annotations

import re
import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
if getattr(sys, "frozen", False):
    APP_ROOT = Path(sys.executable).resolve().parent
else:
    APP_ROOT = PACKAGE_DIR.parent

ROOT = APP_ROOT
WEB_DIR = PACKAGE_DIR / "web"
ACTS_DIR = APP_ROOT / "Acts"
NEW_DIR = ACTS_DIR / "new"
OLD_DIR = ACTS_DIR / "old"
EXPORTS_DIR = ACTS_DIR / "exports"
DATA_DIR = APP_ROOT / "data"
PROJECTS_FILE = DATA_DIR / "projects.json"
NOT_FOUND_FILE = DATA_DIR / "not_found_scans.jsonl"
MANUAL_COMMENTS_FILE = DATA_DIR / "manual_comments.json"
SCAN_PROGRESS_FILE = DATA_DIR / "scan_progress.json"
PROJECT_ITEM_STATES_FILE = DATA_DIR / "project_item_states.json"
INDEX_DB_FILE = DATA_DIR / "index.db"
PARSER_PROFILES_FILE = DATA_DIR / "parser_profiles.json"
ACTIVE_PARSER_PROFILE_FILE = DATA_DIR / "active_parser_profile.json"
PROJECT_PARSER_PROFILES_FILE = DATA_DIR / "project_parser_profiles.json"
SUPPORTED_EXTENSIONS = {".pdf", ".xls", ".xlsx", ".xlsm"}

CODE_RE = re.compile(r"^(?:УП-\d{8}|\d{6,})$")
CODE_IN_TEXT_RE = re.compile(r"(УП-\d{8}|\b\d{6,}\b)")
DOC_RE = re.compile(
    r"(?:№\s*)?(УП-\d+).*?(?:от\s+(\d{2}[.\s]\d{2}[.\s]\d{4}|\d{1,2}\s+[А-Яа-я]+\s+\d{4}))",
    re.IGNORECASE,
)
ROW_START_RE = re.compile(r"^(\d+)\s+((?:УП-\d{8})|(?:\d{6,}))\s*(.*)$")
QTY_RE = re.compile(r"(.+?)\s+(\d+(?:[,.]\d+)?)\s*шт(?:\s|$)", re.IGNORECASE | re.DOTALL)
STOP_PREFIXES = (
    "Итого",
    "В том числе",
    "Всего наименований",
    "Товарно-материальные",
    "Сдал:",
    "Принял:",
)
COMMENT_HEADERS = ("комментар", "примеч", "помет", "замет")
