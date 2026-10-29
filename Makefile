# Point d'entrée unique pour toutes les commandes du projet.
# La CI lance `make install lint test build`.
# Stack : TypeScript, Hono + React/Vite sur Cloudflare Workers (voir docs/adr/0002).

.PHONY: install dev lint format test build deploy

install:
	pnpm install

dev:
	pnpm run dev

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
