# Sourced by backup.sh and import-zitadel.sh; the caller defines die().
# Prints the running Zitadel Postgres container, or nothing when there is none. Zitadel runs as its
# own Compose project (`zitadel`); NIX_ZITADEL_DB_CONTAINER names the container instead.
find_zitadel_db() {
  if [[ -n ${NIX_ZITADEL_DB_CONTAINER:-} ]]; then
    [[ $(docker inspect --format '{{.State.Running}}' "$NIX_ZITADEL_DB_CONTAINER" 2>/dev/null) == true ]] \
      || die "NIX_ZITADEL_DB_CONTAINER is not a running container: $NIX_ZITADEL_DB_CONTAINER"
    echo "$NIX_ZITADEL_DB_CONTAINER"
    return
  fi
  local ids
  ids=$(docker ps --filter label=com.docker.compose.project=zitadel \
    --format '{{.ID}} {{.Label "com.docker.compose.service"}}' \
    | awk '$2 ~ /(^|[-_])(db|postgres|postgresql|database)$/ { print $1 }')
  [[ $ids != *$'\n'* ]] \
    || die 'more than one zitadel database container is running; set NIX_ZITADEL_DB_CONTAINER'
  echo "$ids"
}
