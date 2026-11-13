#!/usr/bin/env bash
# Artrios kit bootstrap for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.1/install.sh | bash
# Clones the tagged kit to a fixed folder, then runs the wizard (install.py). Overrides for testing or a fork:
# ARTRIOS_KIT_REPO, ARTRIOS_KIT_TAG, ARTRIOS_KIT_DIR, ARTRIOS_KIT_ARGS.
# Everything sits in main so a partial download runs nothing.
set -eu

main() {
  repo="${ARTRIOS_KIT_REPO:-https://github.com/rakarangga/artrios-kit.git}"
  tag="${ARTRIOS_KIT_TAG:-kit-v0.2.1}"
  dir="${ARTRIOS_KIT_DIR:-$HOME/artrios-kit}"

  command -v git >/dev/null 2>&1 || { echo "git is required. Install it, then run this again." >&2; exit 1; }
  py=""
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      py="$c"
      break
    fi
  done
  [ -n "$py" ] || { echo "Python 3.9 or newer is required. Install it, then run this again." >&2; exit 1; }

  if [ -d "$dir/.git" ]; then
    echo "Using the kit in $dir"
    git -C "$dir" fetch --tags --quiet
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    echo "$dir exists and is not a kit clone. Move it, or set ARTRIOS_KIT_DIR." >&2
    exit 1
  else
    echo "Cloning the kit to $dir"
    git clone --quiet "$repo" "$dir"
  fi
  # Your own files (profile, registry) may block a tag change: git refuses and nothing is lost.
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "$tag"

  # Piped through curl, stdin is this script: the wizard must read the terminal.
  # shellcheck disable=SC2086
  if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
    "$py" "$dir/install.py" --wizard ${ARTRIOS_KIT_ARGS:-} </dev/tty
  else
    "$py" "$dir/install.py" --wizard ${ARTRIOS_KIT_ARGS:-}
  fi
}

main "$@"
