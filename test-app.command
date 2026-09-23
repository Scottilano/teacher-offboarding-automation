#!/bin/zsh
set -eu
cd "${0:A:h}"
task_node="${OFFBOARDING_NODE:-$(command -v node || true)}"
if [[ -z "$task_node" ]]; then echo 'Install Node 22+.'; exit 1; fi
echo 'Testing the dual-platform app using simulated pages only. No website login or real teacher actions.'
if "$task_node" scripts/launch.mjs test && "$task_node" scripts/launch.mjs test --browser; then
  echo 'Isolated tests passed. Opening the app; you must still verify login, roster scope and each batch authorization.'
  exec ./start.command
else
  echo 'Tests failed. The app was not started and no real removals were performed.'
  read "task_done?Keep the error details above. Press Enter to exit: "
  exit 1
fi
