#!/bin/sh
# Git credential helper for one clone. Git runs it as
#   /bin/sh git-credential-helper.sh <protocol> <host> <operation>
# where protocol and host are the configured Git host. It answers only Git's "get" request for
# exactly that protocol and host, with the token from ATLAS_GIT_TOKEN in this process's
# environment. It never stores or prints the token anywhere else, and ignores "store" and "erase".
expected_protocol=$1
expected_host=$2
operation=$3

protocol=
host=
while IFS= read -r line; do
  [ -z "$line" ] && break
  case $line in
    protocol=*) protocol=${line#protocol=} ;;
    host=*) host=${line#host=} ;;
  esac
done

[ "$operation" = get ] || exit 0
[ -n "$ATLAS_GIT_TOKEN" ] || exit 0
[ -n "$expected_protocol" ] && [ "$protocol" = "$expected_protocol" ] || exit 0
[ -n "$expected_host" ] && [ "$host" = "$expected_host" ] || exit 0

printf 'username=x-access-token\npassword=%s\n' "$ATLAS_GIT_TOKEN"
