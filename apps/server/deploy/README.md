# Deploying the t-cli sync server

The server runs on the Aliyun ECS that already hosts 花了知多少 (heji-ledger).
It adds one container and reuses heji's PostgreSQL 16, nginx and nightly backup.

> Everything about the server below comes from heji-ledger's repository
> (`docker-compose.prod.yml`, `deploy/`), **not** from the live box. Verify it
> before the first deploy (step 0).

## 0. Verify the live server (read-only)

```bash
ssh heji-prod 'free -m; df -h /; docker ps --format "{{.Names}} {{.Image}}"; docker network ls'
ssh heji-prod 'docker exec heji-postgres-1 psql -U heji -d postgres -Atc "select version(); show max_connections;"'
```
Confirm: the `heji_default` network name, the postgres container name (used by
`init-db.sh`), free memory for a 256 MB container, and nginx's server blocks.

## 1. Decisions needed

- API domain, e.g. `tcli.guangqingai.top`: DNS A record + a certificate covering it.
- GitHub repository secrets for `deploy-server.yml`: `SSH_PRIVATE_KEY`, `SSH_HOST`.

## 2. Changes in heji-ledger (separate PR there — its CI deploys nginx)

1. Add `nginx-tcli.conf`'s server block to `deploy/nginx/nginx.conf` (fill in the domain).
2. Add the domain to the certificate (`deploy/tls/issue-cert.sh`).
3. Extend `deploy/backup/pg-backup.sh` to also `pg_dump --format=custom tcli` to
   `oss://heji-bucket/backup/postgres/tcli-YYYYMMDD.dump` (same retention, same status file).

## 3. One-off on the server

```bash
mkdir -p /home/deploy/tcli && cd /home/deploy/tcli
# copy init-db.sh here, then:
read -rs TCLI_DB_PASSWORD && export TCLI_DB_PASSWORD
./init-db.sh
# create .env.prod from .env.prod.example (chmod 600), using the same password
```

## 4. Deploy

Run the **Deploy server** workflow (manual). It builds `linux/amd64`, pushes to
ghcr.io, runs migrations in a one-off container, starts `tcli-api` on
`heji_default`, waits for it to be healthy and removes only this app's old images.

## 5. First user

```bash
docker exec tcli-api node --disable-warning=ExperimentalWarning scripts/admin.ts invite --days 7
```
Log in from the mini-program with the invite code (M2), or approve the CLI's
device code with `admin.ts approve-device <code> <userId>`, then
`admin.ts set-role <userId> admin`.

## Rollback

Re-run the workflow on the previous commit, or on the server:
`TCLI_IMAGE=<previous tag> docker compose -f docker-compose.prod.yml up -d`.
Migrations are additive; a rollback never needs a down-migration.
