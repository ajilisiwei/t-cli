#!/usr/bin/env bash
# One-off: create the `tcli` role and database inside heji's PostgreSQL 16
# container. Run ON THE SERVER as the deploy user:
#
#   read -rs TCLI_DB_PASSWORD && export TCLI_DB_PASSWORD   # or: openssl rand -base64 32
#   ./init-db.sh
#
# The password travels only as an environment variable (`docker exec -e NAME`
# forwards the value without putting it on any command line) and is read by
# psql's \getenv, so it never shows up in `ps` output or shell history.
# Idempotent: re-running only resets the password and connection limit.
# Touches nothing that belongs to heji's own database or role.
set -euo pipefail

: "${TCLI_DB_PASSWORD:?export TCLI_DB_PASSWORD first}"
PG_CONTAINER="${PG_CONTAINER:-heji-postgres-1}"   # verify with `docker ps` (V1)
PG_SUPERUSER="${PG_SUPERUSER:-heji}"

docker exec -i -e TCLI_DB_PASSWORD "$PG_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d postgres <<'SQL'
\getenv pw TCLI_DB_PASSWORD
SELECT 'CREATE ROLE tcli LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tcli') \gexec
SELECT format('ALTER ROLE tcli LOGIN PASSWORD %L', :'pw') \gexec
-- Bound this app's share of the instance's 50 connections.
ALTER ROLE tcli CONNECTION LIMIT 10;
SELECT 'CREATE DATABASE tcli OWNER tcli'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'tcli') \gexec
-- Only the owner (and superusers) may connect to tcli.
REVOKE ALL ON DATABASE tcli FROM PUBLIC;
SQL

echo "role and database 'tcli' ready (password not shown)"
