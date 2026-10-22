.PHONY: help install dev build preview typecheck test check ci shot clean

.DEFAULT_GOAL := help

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

dev: ## Start the dev server (http://127.0.0.1:5173)
	npm run dev

build: ## Typecheck and build into dist/
	npm run build

preview: ## Serve the production build (http://127.0.0.1:4173)
	npm run preview

typecheck: ## Run the TypeScript typecheck
	npm run typecheck

test: ## Run the headless physics, sim and level tests
	npm test

check: typecheck test build ## Run everything CI runs

ci: ## Clean install, then run everything CI runs
	npm ci
	$(MAKE) check

shot: ## Take a screenshot: make shot ARGS="<path> <out.png>"
	npm run shot -- $(ARGS)

clean: ## Remove build output and caches
	rm -rf dist coverage .vite
