from __future__ import annotations

import json
from pathlib import Path

from saath_api.main import create_app


def export_openapi_schema(output_path: Path | None = None) -> Path:
    repo_root = Path(__file__).resolve().parents[4]
    target = output_path or (repo_root / "packages" / "contracts" / "openapi.json")
    target.parent.mkdir(parents=True, exist_ok=True)

    app = create_app()
    schema = app.openapi()
    target.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target


if __name__ == "__main__":
    written = export_openapi_schema()
    print(f"Exported OpenAPI schema to {written}")
