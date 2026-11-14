#!/bin/sh
# Keeps /links in step with the running containers: one symlink per container to its json-file log, named
# <compose project>__<compose service>__<container name>__<id>.log, so the docker-agent collector's filelog
# receiver can read who wrote each line from the path (the json-file log itself holds no names).
# Kubernetes pods (k8s_* containers) are left out: the cluster's node agent collects them with their pod metadata.
# So are Clickland's own collectors, so their logs never feed back into themselves.
set -eu
LINKS=/links
mkdir -p "$LINKS"
while true; do
  want=$(mktemp)
  docker ps --no-trunc --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}} {{.Label "com.docker.compose.service"}}' |
    while read -r id name project service; do
      case "$name" in k8s_*|clickland-infra-collector-*|clickland-infra-docker-agent-*|clickland-infra-docker-log-links-*) continue ;; esac
      safe() { printf '%s' "${1:--}" | tr -c 'A-Za-z0-9._-' '_'; }
      link="$LINKS/$(safe "$project")__$(safe "$service")__$(safe "$name")__$(printf '%.12s' "$id").log"
      echo "$link" >> "$want"
      [ -L "$link" ] || ln -sf "/var/lib/docker/containers/$id/$id-json.log" "$link"
    done
  # Drop links of containers that are gone.
  for link in "$LINKS"/*.log; do
    [ -L "$link" ] || continue
    grep -qxF "$link" "$want" || rm -f "$link"
  done
  rm -f "$want"
  sleep 15
done
