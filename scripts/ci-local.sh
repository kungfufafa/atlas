#!/usr/bin/env bash
set +x
set -euo pipefail

profile=atlas-ci
label=atlas-local-ci-amd64
repository=kungfufafa/atlas
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

blocked() { printf 'BLOCKED: %s\n' "$*" >&2; exit 2; }

host_space() {
  local minimum_gib="$1"
  host_free_kib="$(df -Pk "$HOME" | awk 'NR == 2 {print $4}')" || blocked 'could not read host disk availability'
  [[ "$host_free_kib" =~ ^[0-9]+$ ]] || blocked 'could not determine host disk availability'
  (( host_free_kib >= minimum_gib * 1024 * 1024 )) || blocked "host has $host_free_kib KiB free; at least $minimum_gib GiB is required; no cleanup was attempted"
}

preflight() {
  [[ -z "${COLIMA_HOME:-}" ]] || blocked 'custom COLIMA_HOME is unsupported by this dedicated profile bootstrap'
  [[ "$(uname -s)" == Darwin ]] || blocked 'this bootstrap is for the local macOS Colima host'
  local memory_bytes guestagents
  host_space "${1:-35}"
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
  local run_id="$1" expected_sha="$2" attempt="$3" pending="$4"
  gh api "repos/$repository/actions/runs/$run_id" | \
    jq -e --arg id "$run_id" --arg sha "$expected_sha" --arg repo "$repository" \
      --argjson attempt "$attempt" --argjson pending "$pending" '
      (.id | tostring) == $id and .run_attempt == $attempt and
      .head_sha == $sha and .head_repository.full_name == $repo and
      (.status == "queued" or .status == "in_progress" or ($pending == false and .status == "completed"))
      ' >/dev/null || blocked "run $run_id does not match the reviewed owner commit, attempt or required status"
}

private_path() {
  local path="$1" required_mode="$2" mode
  [[ -O "$path" && ! -L "$path" ]] || blocked 'gate receipt path must be owned by this user and not a symlink'
  if mode="$(stat -f %Lp "$path" 2>/dev/null)"; then :; else mode="$(stat -c %a "$path")"; fi
  [[ "$mode" == "$required_mode" ]] || blocked "gate receipt path must have mode $required_mode"
}

check_admission() {
  local expected_sha="$1" gate_runs="$2" receipt
  receipt_dir="$(git -C "$script_dir" rev-parse --absolute-git-dir)/atlas-ci"
  [[ "$receipt_dir" == /* ]] || blocked 'could not resolve private Git metadata'
  receipt_path="$receipt_dir/gate-admission.json"
  admission_needed=true
  if [[ -e "$receipt_dir" || -L "$receipt_dir" ]]; then
    [[ -d "$receipt_dir" ]] || blocked 'gate receipt parent must be a directory'
    private_path "$receipt_dir" 700
  fi
  [[ -e "$receipt_path" || -L "$receipt_path" ]] || return 0
  [[ -f "$receipt_path" ]] || blocked 'gate receipt must be a regular file'
  private_path "$receipt_path" 600
  receipt="$(jq -sce 'if length == 1 and (.[0] | type == "object") then .[0] else error("receipt must contain exactly one object") end' "$receipt_path")" || \
    blocked 'invalid gate admission receipt; inspect it before continuing'
  jq -e '
    .schema == 1 and (.repository | type == "string") and (.profile | type == "string") and
    (.reviewedSha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.admittedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.hostFreeKiB | type == "number" and . == floor and . >= 35 * 1024 * 1024) and
    (.runs | type == "array" and length > 0 and all(.[];
      (.id | type == "string" and test("^[1-9][0-9]*$")) and
      (.attempt | type == "number" and . == floor and . >= 1))) and
    ((.runs | map(.id) | unique | length) == (.runs | length))
    ' <<< "$receipt" >/dev/null || blocked 'invalid gate admission receipt; inspect it before continuing'
  if jq -e --arg repo "$repository" --arg profile "$profile" --arg sha "$expected_sha" --argjson runs "$gate_runs" \
    '.repository == $repo and .profile == $profile and .reviewedSha == $sha and .runs == $runs' <<< "$receipt" >/dev/null; then
    admission_needed=false
  fi
}

guest_space() {
  local evidence root_free data_free
  evidence="$(colima --profile "$profile" ssh -- sh -c '
    set -eu
    data_mount=/mnt/lima-colima-atlas-ci
    findmnt -rn --mountpoint "$data_mount" >/dev/null
    root_free=$(df -Pk / | awk "NR == 2 {print \$4}")
    data_free=$(df -Pk "$data_mount" | awk "NR == 2 {print \$4}")
    printf "%s %s\n" "$root_free" "$data_free"
  ')" || blocked 'could not read guest root/data disk availability'
  read -r root_free data_free <<< "$evidence"
  [[ "$root_free" =~ ^[0-9]+$ && "$data_free" =~ ^[0-9]+$ ]] || blocked 'invalid guest root/data disk evidence'
  (( root_free >= 5 * 1024 * 1024 && data_free >= 5 * 1024 * 1024 )) || blocked "guest root=$root_free KiB and data=$data_free KiB free; at least 5 GiB on each is required"
  printf 'Disk check: host=%s KiB, guest root=%s KiB, guest data=%s KiB free.\n' "$host_free_kib" "$root_free" "$data_free"
}

write_admission() (
  local expected_sha="$1" gate_runs="$2" temporary_receipt
  umask 077
  mkdir -p "$receipt_dir"
  temporary_receipt="$(mktemp "$receipt_dir/.gate-admission.XXXXXX")"
  trap 'rm -f -- "$temporary_receipt"' EXIT
  jq -n --arg repo "$repository" --arg profile "$profile" --arg sha "$expected_sha" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson free "$host_free_kib" --argjson runs "$gate_runs" \
    '{schema:1,repository:$repo,profile:$profile,reviewedSha:$sha,admittedAt:$at,hostFreeKiB:$free,runs:$runs}' > "$temporary_receipt"
  mv -f -- "$temporary_receipt" "$receipt_path"
)

gate_attempt() {
  jq -er --arg id "$1" '.[] | select(.id == $id) | .attempt' <<< "$gate_runs" || \
    blocked "run $1 is outside the explicit gate list"
}

run_once() {
  [[ $# -ge 3 && "$1" =~ ^[1-9][0-9]*$ && "$2" =~ ^[0-9a-f]{40}$ ]] || blocked 'run requires a run ID, reviewed SHA and the explicit gate RUN_ID:ATTEMPT list'
  local run_id="$1" expected_sha="$2" gate_runs member member_id attempt pending_id pending_ids pending_jobs status token
  shift 2
  preflight 10
  for member in "$@"; do
    [[ "$member" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]] || blocked 'gate members must be RUN_ID:ATTEMPT pairs'
  done
  gate_runs="$(printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1] | map(split(":") | {id:.[0],attempt:(.[1]|tonumber)}) | sort_by(.id)')"
  jq -e '(map(.id) | unique | length) == length' <<< "$gate_runs" >/dev/null || blocked 'gate run IDs must be unique'
  attempt="$(gate_attempt "$run_id")"
  check_run "$run_id" "$expected_sha" "$attempt" true
  while read -r member_id attempt; do
    check_run "$member_id" "$expected_sha" "$attempt" false
  done <<< "$(jq -r '.[] | "\(.id) \(.attempt)"' <<< "$gate_runs")"
  local targetable_jobs=0
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
        attempt="$(gate_attempt "$pending_id")"
        check_run "$pending_id" "$expected_sha" "$attempt" true
        targetable_jobs=$((targetable_jobs + 1))
      fi
    done <<< "$pending_ids"
  done
  (( targetable_jobs > 0 )) || blocked 'no queued jobs currently request the dedicated runner label'
  check_source "$expected_sha"
  check_admission "$expected_sha" "$gate_runs"
  if [[ "$admission_needed" == true ]]; then host_space 35; else host_space 10; fi
  guest_space
  refresh_bootstrap
  colima --profile "$profile" ssh -- sh -c \
    'exec bash "$HOME/.local/share/atlas-ci-bootstrap/verify-linux-landlock.sh"'
  if [[ "$admission_needed" == true ]]; then write_admission "$expected_sha" "$gate_runs"; fi
  printf 'Gate admission verified for %s at %s.\n' "$repository" "$expected_sha"
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
  *) blocked 'usage: bash scripts/ci-local.sh {preflight|provision|refresh|run RUN_ID REVIEWED_SHA RUN_ID:ATTEMPT [...]}' ;;
esac
