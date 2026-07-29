FROM minio/mc:RELEASE.2025-08-13T08-35-41Z AS mc

FROM minio/minio:RELEASE.2025-09-07T16-13-09Z

COPY --from=mc /usr/bin/mc /usr/bin/mc
COPY --chmod=0755 deploy/railway/minio-entrypoint.sh /usr/local/bin/buzz-minio-entrypoint

EXPOSE 9000 9001

ENTRYPOINT ["/usr/local/bin/buzz-minio-entrypoint"]
