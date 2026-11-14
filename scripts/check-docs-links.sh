#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# scripts/check-docs-links.sh — fail if a tracked Markdown file links to a
# relative file or image that does not exist.
#
# Scope:
#   - inline links/images: [text](path) and ![alt](path)
#   - reference definitions: [id]: path
#   - only files tracked by git (`git ls-files '*.md'`)
#
# Ignored on purpose:
#   - absolute URLs (http, https, mailto, tel, ...), protocol-relative //...
#   - pure anchors (#section)
#   - site-root paths (/api/v1/...): not repo-relative
#   - placeholders (<path>, {id}, ..., $VAR, *) and targets with spaces
#   - Markdown inside fenced code blocks
#
# Exit code: 0 if every relative link resolves, 1 otherwise.

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root" || exit 1

if ! git ls-files --error-unmatch README.md >/dev/null 2>&1; then
  echo "check-docs-links: not a git repository or README.md is untracked" >&2
  exit 1
fi

missing=0
checked=0
files=0

is_ignored() {
  local target="$1"
  case "$target" in
    '' | '#'* | '/'*) return 0 ;;
    '<'* | '{'* | '...'* | *'$'* | *'*'*) return 0 ;;
    http://* | https://* | mailto:* | tel:* | ftp:* | data:* | javascript:* | //*) return 0 ;;
    *'://'*) return 0 ;;
  esac
  return 1
}

check_target() {
  local file="$1" line="$2" target="$3"
  local clean="${target%%#*}"
  clean="${clean%%\?*}"
  clean="${clean#<}"
  clean="${clean%>}"
  # Decode the two sequences that actually appear in paths.
  clean="${clean//%20/ }"

  is_ignored "$clean" && return 0
  # A target with whitespace is a title/anchor fragment, not a path.
  case "$clean" in
    *[[:space:]]*) return 0 ;;
  esac

  checked=$((checked + 1))
  local base
  base="$(dirname "$file")"

  if [ ! -e "$base/$clean" ]; then
    echo "MISSING ${file}:${line} -> ${target}" >&2
    missing=$((missing + 1))
  fi
}

while IFS= read -r file; do
  [ -f "$file" ] || continue
  files=$((files + 1))

  # Strip fenced code blocks, keep the 1-based line number.
  while IFS= read -r record; do
    line="${record%%:*}"
    text="${record#*:}"

    # Inline links and images. The target is everything between ]( and ).
    while IFS= read -r target; do
      [ -n "$target" ] && check_target "$file" "$line" "$target"
    done < <(printf '%s\n' "$text" | grep -oE '\]\([^)]*\)' | sed -e 's/^](//' -e 's/)$//')

    # Reference definitions: [label]: path (optional title after whitespace).
    if printf '%s\n' "$text" | grep -qE '^\[[^]]+\]:[[:space:]]+'; then
      ref_target="$(printf '%s\n' "$text" | sed -nE 's/^\[[^]]+\]:[[:space:]]+([^[:space:]]+).*/\1/p')"
      [ -n "$ref_target" ] && check_target "$file" "$line" "$ref_target"
    fi
  done < <(awk '/^[[:space:]]*(```|~~~)/ { fence = !fence; next } !fence { print FNR ":" $0 }' "$file")
done < <(git ls-files '*.md')

if [ "$missing" -gt 0 ]; then
  echo "check-docs-links: ${missing} broken relative link(s) in ${files} file(s)" >&2
  exit 1
fi

echo "check-docs-links: ok — ${checked} relative link(s) in ${files} file(s)"
