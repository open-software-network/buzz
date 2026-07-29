# Buzz on Railway

This deployment maps the production Compose stack to Railway services:

- `buzz-relay`: this repository's root `Dockerfile`, exposed on port `3000`
- `Postgres`: Railway-managed PostgreSQL
- `Redis`: Railway-managed Redis
- `buzz-minio`: `deploy/railway/minio.Dockerfile`, with a volume mounted at `/data`
- a volume mounted at `/data/git` on `buzz-relay`

Railway does not run the Compose file directly. Services communicate over the
project's private network. Only `buzz-relay` receives a public/custom domain.

## Relay variables

Set these references and Railway-specific values on `buzz-relay`:

```dotenv
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
PORT=3000
BUZZ_BIND_ADDR=0.0.0.0:3000
BUZZ_HEALTH_PORT=8080
BUZZ_METRICS_PORT=9102
BUZZ_S3_ENDPOINT=http://buzz-minio.railway.internal:9000
BUZZ_S3_ACCESS_KEY=${{buzz-minio.MINIO_ROOT_USER}}
BUZZ_S3_SECRET_KEY=${{buzz-minio.MINIO_ROOT_PASSWORD}}
BUZZ_S3_BUCKET=${{buzz-minio.BUZZ_S3_BUCKET}}
BUZZ_S3_REGION=us-east-1
BUZZ_GIT_REPO_PATH=/data/git
BUZZ_AUTO_MIGRATE=true
RAILWAY_RUN_UID=0
```

`RAILWAY_RUN_UID=0` is required because Railway volumes are initially mounted
as root while the upstream runtime image normally uses UID 1000. The relay
volume must remain writable across deploys.

Copy the remaining operator policy, relay identity, URL, CORS, and media values
from the prior production environment. Keep secrets in Railway variables; do
not commit them.

## MinIO variables

Set these on `buzz-minio`:

```dotenv
MINIO_ROOT_USER=<stable generated access key>
MINIO_ROOT_PASSWORD=<stable generated secret>
BUZZ_S3_BUCKET=buzz-media
```

Set the service root directory to `/deploy/railway` and the Railway config file
path to `/deploy/railway/railway.json`. That config selects
`minio.Dockerfile` without inheriting the relay's root configuration. Mount a
persistent Railway volume at `/data`. The entrypoint starts MinIO and
idempotently creates the private bucket before declaring the process ready.

## Validation

After deployment, generate a Railway domain for port `3000` and check:

```bash
curl -fsS "https://<railway-domain>/health"
curl -fsS "https://<railway-domain>/" | jq -e '.name == "Buzz Relay"'
```

Then attach the production custom domain and verify both the NIP-11 response
and a WebSocket upgrade before removing the previous deployment.
