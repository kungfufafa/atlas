#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runner_template=/opt/atlas-ci-runner-2.337.0
repository=https://github.com/kungfufafa/atlas

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  printf 'BLOCKED: guest must be Linux x86_64.\n' >&2
  exit 2
}

case "${1:-}" in
  provision)
    sudo -n apt-get update
    sudo -n apt-get install -y --no-install-recommends ca-certificates curl git jq python3
    bash "$script_dir/verify-linux-landlock.sh"
    docker info >/dev/null
    archive="$(mktemp)"
    trap 'rm -f -- "$archive"' EXIT
    curl --proto '=https' --tlsv1.2 --fail --location \
      https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz -o "$archive"
    printf '70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613  %s\n' "$archive" | sha256sum --check --status
    sudo -n mkdir -p "$runner_template"
    sudo -n tar -xzf "$archive" -C "$runner_template"
    sudo -n bash "$runner_template/bin/installdependencies.sh"
    printf 'Guest prepared; no runner registered and no production image validated.\n'
    ;;
  run)
    bash "$script_dir/verify-linux-landlock.sh"
    docker info >/dev/null
    # mkdir is an atomic one-listener lock within this dedicated VM.
    lock="$HOME/.atlas-ci-runner-lock"
    mkdir "$lock" || { printf 'BLOCKED: a runner lock already exists.\n' >&2; exit 2; }
    job_root=""
    listener_pid=""
    cleanup() {
      local result=$?
      if [[ -n "$listener_pid" ]]; then
        kill -TERM -- "-$listener_pid" 2>/dev/null || true
        wait "$listener_pid" 2>/dev/null || true
      fi
      [[ -z "$job_root" ]] || rm -rf -- "$job_root" || result=1
      rmdir "$lock" || result=1
      exit "$result"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    job_root="$(mktemp -d "$HOME/atlas-ci-job.XXXXXX")"
    cp -a "$runner_template/." "$job_root/"
    cd "$job_root"
    IFS= read -r token
    [[ "$token" =~ ^[A-Za-z0-9_=-]+$ ]] || { printf 'BLOCKED: registration token missing.\n' >&2; exit 2; }
    ./config.sh --unattended --ephemeral --no-default-labels \
      --url "$repository" --token "$token" --labels atlas-local-ci-amd64 \
      --name "atlas-ci-local-$(date +%s)-$$" --work _work
    unset token
    # One job only, with a bounded wait if GitHub stops dispatching. A separate
    # process group lets cancellation terminate the listener and its children.
    setsid timeout --signal=TERM --kill-after=30s 3600 ./run.sh &
    listener_pid=$!
    wait "$listener_pid"
    ;;
  *) printf 'Usage: ci-local-guest.sh {provision|run}\n' >&2; exit 2 ;;
esac
