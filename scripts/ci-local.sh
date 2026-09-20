#!/usr/bin/env bash
set +x
set -euo pipefail

profile=atlas-ci
label=atlas-local-ci-amd64
repository=kungfufafa/atlas
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

blocked() { printf 'BLOCKED: %s\n' "$*" >&2; exit 2; }

preflight() {
  [[ -z "${COLIMA_HOME:-}" ]] || blocked 'custom COLIMA_HOME is unsupported by this dedicated profile bootstrap'
  [[ "$(uname -s)" == Darwin ]] || blocked 'this bootstrap is for the local macOS Colima host'
  local available_kib memory_bytes guestagents
  available_kib="$(df -Pk "$HOME" | awk 'NR == 2 {print $4}')" || blocked 'could not read host disk availability'
  [[ "$available_kib" =~ ^[0-9]+$ ]] || blocked 'could not determine host disk availability'
  # Conservative operational headroom, not a measured minimum image size.
  (( available_kib >= 35 * 1024 * 1024 )) || blocked 'at least 35 GiB free host disk is required; no cleanup or VM startup was attempted'
  memory_bytes="$(sysctl -n hw.memsize)" || blocked 'could not read host memory'
  [[ "$memory_bytes" =~ ^[0-9]+$ ]] || blocked 'could not determine host memory'
  (( memory_bytes >= 8 * 1024 * 1024 * 1024 )) || blocked 'at least 8 GiB host memory is required for the 4 GiB guest'
  local dependency
  for dependency in colima qemu-system-x86_64 gh jq brew git; do
    command -v "$dependency" >/dev/null || blocked "missing prerequisite: $dependency"
  done
  guestagents="$(HOMEBREW_NO_AUTO_UPDATE=1 brew list --versions lima-additional-guestagents)" || blocked 'install lima-additional-guestagents before creating an x86_64 VM'
  [[ -n "$guestagents" ]] || blocked 'lima-additional-guestagents is not installed'
  printf 'Host preflight passed; guest kernel, Docker image and tests remain unverified.\n'
}

provision() {
  preflight
  [[ ! -e "$HOME/.colima/$profile" && ! -e "$HOME/.colima/_lima/colima-$profile" ]] || blocked "$profile already exists; inspect it explicitly rather than overwriting a VM"
  colima start "$profile" --arch x86_64 --vm-type qemu --cpus 4 --memory 4 \
    --disk 40 --root-disk 20 --runtime docker --mount none --ssh-agent=false \
    --ssh-config=false --activate=false --template=false --binfmt=false \
    --port-forwarder=none
  refresh_bootstrap
  colima --profile "$profile" ssh -- sh -c \
    'exec bash "$HOME/.local/share/atlas-ci-bootstrap/ci-local-guest.sh" provision'
}

refresh_bootstrap() {
  # SSH must already work; this never starts or reprovisions an existing VM.
  # Copy only the named source files, not the host checkout, home or credentials.
  COPYFILE_DISABLE=1 tar -C "$script_dir" -cf - ci-local-guest.sh verify-linux-landlock.sh | \
    colima --profile "$profile" ssh -- sh -c '
      set -eu
      umask 077
      test ! -e "$HOME/.atlas-ci-runner-lock" || { echo "BLOCKED: a runner lock already exists." >&2; exit 2; }
      bootstrap="$HOME/.local/share/atlas-ci-bootstrap"
      mkdir -p "$bootstrap"
      chmod 700 "$bootstrap"
      tar -xf - -C "$bootstrap"
      chmod 600 "$bootstrap/ci-local-guest.sh" "$bootstrap/verify-linux-landlock.sh"
    '
}

check_source() {
  local expected_sha="$1" script
  [[ "$(git -C "$script_dir" rev-parse HEAD)" == "$expected_sha" ]] || blocked 'local checkout must match the reviewed commit'
  for script in ci-local.sh ci-local-guest.sh verify-linux-landlock.sh; do
    git -C "$script_dir" show "$expected_sha:scripts/$script" | cmp -s - "$script_dir/$script" || \
      blocked "local $script differs from the reviewed commit"
  done
}

check_run() {
  local run_id="$1" expected_sha="$2"
  gh api "repos/$repository/actions/runs/$run_id" | \
    jq -e --arg sha "$expected_sha" --arg repo "$repository" \
      '.head_sha == $sha and .head_repository.full_name == $repo and (.status == "queued" or .status == "in_progress")' >/dev/null || \
    blocked "run $run_id is not pending at the explicitly reviewed owner commit"
}

run_once() {
  [[ $# -eq 2 && "$1" =~ ^[0-9]+$ && "$2" =~ ^[0-9a-f]{40}$ ]] || blocked 'run requires an Actions run ID and the full reviewed owner-branch commit SHA'
  preflight
  local run_id="$1" expected_sha="$2" pending_id pending_ids pending_jobs status token
  local targetable_jobs=0
  check_run "$run_id" "$expected_sha"
  [[ "$(gh variable get ATLAS_CI_RUNNER --repo "$repository")" == "$label" ]] || blocked "ATLAS_CI_RUNNER must explicitly route the reviewed run to $label"
  # Labels cannot bind a runner to one run. Refuse other/fork commits that could
  # currently claim this label; do not run an unattended listener or daemon.
  for status in queued in_progress; do
    pending_ids="$(gh api --paginate "repos/$repository/actions/runs?status=$status&per_page=100" --jq '.workflow_runs[].id')"
    while IFS= read -r pending_id; do
      [[ -n "$pending_id" ]] || continue
      pending_jobs="$(gh api --paginate "repos/$repository/actions/runs/$pending_id/jobs?per_page=100" \
        --jq ".jobs[] | select(.status == \"queued\") | .labels[] | select(. == \"$label\")")"
      if [[ -n "$pending_jobs" ]]; then
        check_run "$pending_id" "$expected_sha"
        targetable_jobs=$((targetable_jobs + 1))
      fi
    done <<< "$pending_ids"
  done
  (( targetable_jobs > 0 )) || blocked 'no queued jobs currently request the dedicated runner label'
  check_source "$expected_sha"
  refresh_bootstrap
  colima --profile "$profile" ssh -- sh -c \
    'exec bash "$HOME/.local/share/atlas-ci-bootstrap/verify-linux-landlock.sh"'
  # Fetch the short-lived registration token only after every preflight passes.
  # No host PAT, SSH agent, provider key, or host home is copied into the guest.
  token="$(gh api --method POST "repos/$repository/actions/runners/registration-token" --jq .token)"
  [[ "$token" =~ ^[A-Za-z0-9_=-]+$ ]] || blocked 'invalid registration token response'
  local result=0
  printf '%s\n' "$token" | colima --profile "$profile" ssh -- \
    sh -c 'exec bash "$HOME/.local/share/atlas-ci-bootstrap/ci-local-guest.sh" run' || result=$?
  unset token
  return "$result"
}

case "${1:-preflight}" in
  preflight) preflight ;;
  provision) provision ;;
  refresh) preflight; refresh_bootstrap ;;
  run) shift; run_once "$@" ;;
  *) blocked 'usage: bash scripts/ci-local.sh {preflight|provision|refresh|run RUN_ID REVIEWED_SHA}' ;;
esac
