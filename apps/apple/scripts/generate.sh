#!/usr/bin/env bash
# Generates apps/apple/NexBot.xcodeproj from project.yml (the project is gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo "xcodegen not found: brew install xcodegen" >&2; exit 1; }
xcodegen generate --spec project.yml
