#!/bin/sh
set -eu

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"

bucket="${BUZZ_S3_BUCKET:-buzz-media}"

minio server /data --address ":9000" --console-address ":9001" &
minio_pid=$!

shutdown() {
  kill -TERM "$minio_pid" 2>/dev/null || true
  wait "$minio_pid" 2>/dev/null || true
}
trap shutdown INT TERM

until mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  if ! kill -0 "$minio_pid" 2>/dev/null; then
    wait "$minio_pid"
  fi
  sleep 1
done

mc mb --ignore-existing "local/$bucket"
mc anonymous set none "local/$bucket"

wait "$minio_pid"
