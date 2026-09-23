#!/bin/zsh
set -eu
cd "${0:A:h}"
task_node="${OFFBOARDING_NODE:-$(command -v node || true)}"
if [[ -z "$task_node" ]]; then echo 'Install Node 22+ and reopen Terminal.'; exit 1; fi
echo 'Starting Teacher Offboarding (Local Edition). No Google credentials required.'
"$task_node" scripts/launch.mjs start || {
  task_exit=$?
  read "task_done?Startup failed. Keep the error details above. Press Enter to exit: "
  exit "$task_exit"
}
