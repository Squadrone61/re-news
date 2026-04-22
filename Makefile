COMPOSE      := docker compose -p re-news
COMPOSE_PROD := docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml
COMPOSE_MIG  := docker compose -p re-news -f docker-compose.yml -f docker-compose.migrate.yml
COMPOSE_BAK  := docker compose -p re-news -f docker-compose.yml -f docker-compose.backup.yml

.PHONY: up down deploy pull migrate logs psql shell-web shell-worker backup

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

# Server deploy: run the GHCR-published images (not a local build) so that
# Watchtower has a registry to pull from. `make up` on the server tags images
# as `re-news-{web,worker}:latest`, which Watchtower resolves against Docker
# Hub and 401s.
pull:
	$(COMPOSE_PROD) pull

deploy:
	$(COMPOSE_PROD) up -d

migrate:
	$(COMPOSE_MIG) run --rm migrate

logs:
	$(COMPOSE) logs -f --tail=100

psql:
	$(COMPOSE) exec db psql -U newsletter -d newsletter

shell-web:
	$(COMPOSE) exec web sh

shell-worker:
	$(COMPOSE) exec worker sh

backup:
	mkdir -p ./data/backups
	$(COMPOSE_BAK) run --rm backup
