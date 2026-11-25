.PHONY: dev test lint migrate seed contracts

SHELL := /bin/zsh

dev:
	@if command -v docker >/dev/null 2>&1; then \
		docker compose up -d postgres redis; \
	else \
		echo "docker not found; expecting local PostgreSQL (:5432) and Redis/Valkey (:6379)"; \
	fi
	$(MAKE) migrate
	@echo "Starting api (:8000), worker, web (:3000), admin (:3001)..."
	(cd apps/api && uv run uvicorn saath_api.main:app --reload --port 8000) & \
	(cd apps/api && uv run arq saath_api.worker.WorkerSettings) & \
	pnpm dev

migrate:
	cd apps/api && uv run alembic upgrade head

seed:
	cd apps/api && uv run python -m saath_api.seed

contracts:
	cd apps/api && uv run python -m saath_api.export_openapi
	pnpm --filter @saath/contracts generate

lint:
	cd apps/api && uv run ruff check . && uv run mypy --strict src
	pnpm lint
	pnpm typecheck

test:
	cd apps/api && uv run pytest -v
	pnpm test
