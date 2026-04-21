# re-news

Self-hosted, family-scale newsletter agent.

See [`CLAUDE.md`](./CLAUDE.md) for architecture and constraints, and [`plans/README.md`](./plans/README.md) for the 8-plan build order.

## Quick start

```sh
cp .env.example .env        # fill in DB_PASSWORD + SESSION_PASSWORD
pnpm install
make migrate
make up
# http://localhost:3100
```
