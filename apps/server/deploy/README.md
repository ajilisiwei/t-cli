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
Text to speech (`POST /v1/tts`) opens an outbound WebSocket to
`speech.platform.bing.com:443`; confirm the box's egress allows it:
```bash
ssh heji-prod 'curl -sS -o /dev/null -w "%{http_code}\n" https://speech.platform.bing.com/'
```

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

### Configuration notes

- Text to speech: `TTS_ENABLED` (default `true`; `false` answers `503 TTS_UNAVAILABLE`),
  `TTS_REQUESTS_PER_MINUTE` (30 per account), `TTS_TIMEOUT_MS` (15000) and
  `TTS_CACHE_MAX_BYTES` (16 MiB). The audio cache is in the API process, inside its
  256 MB memory limit, so raise it only together with `mem_limit`. The upstream
  (Edge Read Aloud) is unofficial and has no SLA: if it starts failing for good,
  set `TTS_ENABLED=false` and restart rather than letting every tap time out.
- PDF export (`POST /v1/exports/pdf`): the image ships Typst 0.13.1 at
  `/usr/local/bin/typst` and its six fonts in `/usr/local/share/fonts/t-cli`
  (the defaults of `TYPST_BIN` / `TYPST_FONT_PATH`; +67 MB: binary 42 MB, fonts
  25 MB), pinned with SHA-256 in `fetch-typst.sh`. Renders are child processes
  inside the same 256 MB limit, at most 2 at a time. Measured on a native arm64
  build of this image with `--memory=256m` (no swap): idle 49 MiB, peak 119 MiB
  with 2 concurrent 4-page renders plus 4 queued, warm render 70–110 ms (first
  one ~1 s, cold font cache). Check `docker stats tcli-api` during the first
  exports on the host; raise `mem_limit` only after measuring there.
- `WECHAT_DEV_LOGIN` is for local development only (it fakes WeChat login with
  `dev:<name>` codes). Never put it in `.env.prod`: with `NODE_ENV=production`
  the server refuses to start when it is set.

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
