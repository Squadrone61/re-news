COMPOSE      := docker compose -p re-news
COMPOSE_MIG  := docker compose -p re-news -f docker-compose.yml -f docker-compose.migrate.yml

.PHONY: up down migrate logs psql shell-web shell-worker backup

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

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
	@echo "backup: implemented in plan 8"
