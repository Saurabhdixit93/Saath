from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

API_ROOT = Path(__file__).resolve().parents[1]

# alembic_version.version_num is VARCHAR(32); longer ids fail mid-upgrade.
MAX_REVISION_ID_LENGTH = 32


def _script_directory() -> ScriptDirectory:
    config = Config(str(API_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(API_ROOT / "alembic"))
    return ScriptDirectory.from_config(config)


def test_revision_ids_fit_alembic_version_column() -> None:
    too_long = [
        rev.revision
        for rev in _script_directory().walk_revisions()
        if len(rev.revision) > MAX_REVISION_ID_LENGTH
    ]
    assert too_long == []


def test_migrations_have_single_head() -> None:
    assert len(_script_directory().get_heads()) == 1
