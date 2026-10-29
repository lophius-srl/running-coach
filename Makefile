# Point d'entrée unique pour toutes les commandes du projet.
# La CI lance `make install lint test build`.
# Stack : TypeScript, Hono + React/Vite sur Cloudflare Workers (voir docs/adr/0002).

.PHONY: install dev db-migrate lint format test build deploy

install:
	pnpm install

dev:
	pnpm run dev

# Applique les migrations D1 sur la base locale (.wrangler/state). Lancé aussi par `make dev`.
db-migrate:
	pnpm run db:migrate

lint:
	pnpm run lint

format:
	pnpm run format

test:
	pnpm run test

build:
	pnpm run build

deploy:
	pnpm run deploy
