from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

_TRAIN_NO_RE = re.compile(r"^[1-9][0-9]{4}$")


@dataclass(frozen=True)
class TrainCatalogEntry:
    train_no: str
    train_name: str
    from_code: str
    to_code: str
    departure_ist: str
    classes: tuple[str, ...]


def _catalog_path() -> Path:
    return Path(__file__).resolve().parents[3] / "config" / "trains_catalog.json"


@lru_cache(maxsize=1)
def load_train_catalog() -> dict[str, TrainCatalogEntry]:
    path = _catalog_path()
    raw = json.loads(path.read_text(encoding="utf-8"))
    catalog: dict[str, TrainCatalogEntry] = {}
    for row in raw:
        tno = str(row["train_no"]).strip()
        catalog[tno] = TrainCatalogEntry(
            train_no=tno,
            train_name=str(row["train_name"]),
            from_code=str(row["from_code"]),
            to_code=str(row["to_code"]),
            departure_ist=str(row["departure_ist"]),
            classes=tuple(str(c) for c in row.get("classes", ())),
        )
    return catalog


def is_valid_train_no(train_no: str) -> bool:
    cleaned = train_no.strip()
    if cleaned == "00000":
        return False
    return bool(_TRAIN_NO_RE.fullmatch(cleaned))


def get_train_entry(train_no: str) -> TrainCatalogEntry | None:
    cleaned = train_no.strip()
    if not is_valid_train_no(cleaned):
        return None
    return load_train_catalog().get(cleaned)


def list_train_numbers() -> list[str]:
    return list(load_train_catalog().keys())


def train_catalog_count() -> int:
    return len(load_train_catalog())
