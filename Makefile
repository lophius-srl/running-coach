# Point d'entrée unique pour toutes les commandes du projet.
# La CI lance `make install lint test build` : remplace les cibles ci-dessous par les vraies commandes de ta stack.
# (L'agent `architect` le fait pendant le /kickoff.)
#
# Exemples :
#   Node       install: npm ci         lint: npm run lint      test: npm test        build: npm run build
#   Python     install: pip install -e ".[dev]"  lint: ruff check .  test: pytest    build: python -m build
#   Go         install: go mod download  lint: go vet ./...    test: go test ./...   build: go build ./...
#   Flutter    install: flutter pub get  lint: flutter analyze  test: flutter test  build: flutter build web

.PHONY: install dev lint format test build deploy

install:
	@echo "TODO: installer les dépendances"

dev:
	@echo "TODO: lancer l'app en local"

lint:
	@echo "TODO: lint"

format:
	@echo "TODO: formater le code"

test:
	@echo "TODO: tests"

build:
	@echo "TODO: build"

deploy:
	@echo "TODO: déploiement (optionnel, voir .github/workflows/deploy.yml)"
