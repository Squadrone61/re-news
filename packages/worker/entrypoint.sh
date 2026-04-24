#!/bin/sh
set -e
cd /app
pnpm prisma migrate deploy
exec "$@"
