from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Item:
    code: str
    name: str
    qty: float
    unit: str = "шт"
    comment: str = ""
    row: str = ""


@dataclass
class Document:
    id: str
    file: str
    name: str
    number: str
    date: str
    ext: str
    modified: str
    location: str = "new"
    project: str = ""
    items: list[Item] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
