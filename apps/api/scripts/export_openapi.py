from __future__ import annotations

from saath_api.export_openapi import export_openapi_schema

if __name__ == "__main__":
    written = export_openapi_schema()
    print(f"Exported OpenAPI schema to {written}")
