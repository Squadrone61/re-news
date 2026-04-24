#!/bin/sh
set -e
cd /app
pnpm prisma migrate deploy
cd /app/packages/web
exec "$@"
