#!/bin/sh
# Installs the engine app (`projectman motor.app`) of a projectman release on this Mac (PM-1425).
#
# Read this script before you run it; do not pipe it into a shell. Usage:
#   sh install-engine-app.sh --tag <tag>
#       downloads projectman-motor.json and projectman-motor.zip from the release <tag>;
#   sh install-engine-app.sh --tag <tag> --zip <file> --manifest <file>
#       checks a pair downloaded by hand (with a browser, AirDrop) instead.
#
# The app is signed ad hoc, so macOS refuses to open a copy that carries the `com.apple.quarantine` attribute
# (a browser or AirDrop download, or a file written by a sandboxed AI host). This script removes that attribute,
# but only as the last step, after the whole chain below has passed:
#   1. the machine: Apple Silicon, macOS 13 or later, GitHub CLI 2.49+ logged in;
#   2. the release files, downloaded into a new temporary directory (or copied there with --zip/--manifest);
#   3. the manifest: schemaVersion 1, the requested tag, arm64;
#   4. the zip's size and SHA-256 equal the manifest's (this only ties the zip to the manifest);
#   5. the GitHub build attestation of the zip and the manifest: built by the release workflow of
#      janoist1/projectman from refs/heads/main on a GitHub-hosted runner (the trust anchor, as in the app's
#      own updater);
#   6. the zip is unpacked into a new directory and must hold exactly the app;
#   7. the app's code signature is valid and carries the identifier com.projectman.engine-app, its
#      CFBundleVersion is the manifest's bundleVersion and its bundled engine is the manifest's commit;
#   8. the checked app is copied to ~/Applications, under a temporary name;
#   9. only then, if the copy carries the quarantine attribute, it is removed, and the copy takes the app's name.
# Every failure prints `REFUSED [code] ...` and exits non-zero; nothing is installed then. No sudo; nothing is
# written outside the user's home and the temporary directory.

set -eu

# gh comes from the caller's PATH (Homebrew or the installer from cli.github.com); every other tool is Apple's own,
# because a package manager's tool of the same name may differ (Homebrew's `xattr` has no `-r`, for one).
# PROJECTMAN_INSTALL_TEST_BIN puts a directory of stand-ins first; only the tests set it.
GH=$(command -v gh 2>/dev/null || true)
for candidate in /opt/homebrew/bin/gh /usr/local/bin/gh; do
  if [ -z "$GH" ] && [ -x "$candidate" ]; then GH=$candidate; fi
done
PATH="${PROJECTMAN_INSTALL_TEST_BIN:+$PROJECTMAN_INSTALL_TEST_BIN:}/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

REPO='janoist1/projectman'
SIGNER_WORKFLOW="$REPO/.github/workflows/projectman-engine-release.yml"
SOURCE_REF='refs/heads/main'
APP_NAME='projectman motor.app'
BUNDLE_ID='com.projectman.engine-app'
MANIFEST_NAME='projectman-motor.json'
ZIP_NAME='projectman-motor.zip'
MIN_GH='2.49'
QUARANTINE='com.apple.quarantine'

work=''
staged=''
cleanup() {
  if [ -n "$staged" ]; then rm -rf "$staged"; fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

refuse() {
  code=$1
  shift
  printf 'REFUSED [%s] %s\n' "$code" "$*" >&2
  exit 1
}

step() {
  printf 'ok    %s\n' "$*"
}

# Whether $1 is a single line that matches the extended regular expression $2 as a whole.
matches() {
  [ "$(printf '%s\n' "$1" | wc -l | tr -d ' ')" = 1 ] && printf '%s\n' "$1" | grep -Eqx -- "$2"
}

# Whether version $1 (major.minor) is at least $2.
at_least() {
  major=${1%%.*}
  rest=${1#*.}
  minor=${rest%%.*}
  want_major=${2%%.*}
  want_minor=${2#*.}
  [ "$major" -gt "$want_major" ] || { [ "$major" -eq "$want_major" ] && [ "$minor" -ge "$want_minor" ]; }
}

usage() {
  refuse usage "usage: sh install-engine-app.sh --tag <tag> [--zip <file> --manifest <file>]"
}

tag=''
zip_in=''
manifest_in=''
while [ $# -gt 0 ]; do
  case $1 in
    --tag) [ $# -ge 2 ] || usage; tag=$2; shift 2 ;;
    --zip) [ $# -ge 2 ] || usage; zip_in=$2; shift 2 ;;
    --manifest) [ $# -ge 2 ] || usage; manifest_in=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$tag" ] || usage
matches "$tag" 'v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?' || refuse usage "invalid release tag: $tag"
if [ -n "$zip_in" ] || [ -n "$manifest_in" ]; then
  [ -n "$zip_in" ] && [ -n "$manifest_in" ] || refuse usage '--zip and --manifest go together'
  [ -f "$zip_in" ] || refuse usage "no such file: $zip_in"
  [ -f "$manifest_in" ] || refuse usage "no such file: $manifest_in"
fi
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || refuse home_missing 'HOME is not a directory'

# 1. The machine.
[ "$(uname -s)" = Darwin ] || refuse unsupported_os 'the engine app runs on macOS only'
[ "$(uname -m)" = arm64 ] || refuse unsupported_arch 'the engine app needs an Apple Silicon (arm64) Mac'
macos=$(sw_vers -productVersion)
matches "$macos" '[0-9]+(\.[0-9]+)*' || refuse unsupported_os "unknown macOS version: $macos"
[ "${macos%%.*}" -ge 13 ] || refuse unsupported_os "the engine app needs macOS 13 or later (this Mac has $macos)"
[ -n "$GH" ] ||
  refuse gh_missing 'the GitHub CLI (gh) is missing: install it (https://cli.github.com, or `brew install gh`), then the user runs `gh auth login` once'
gh_version=$("$GH" --version 2>/dev/null | head -n 1 | sed -n 's/^gh version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
[ -n "$gh_version" ] && at_least "$gh_version" "$MIN_GH" ||
  refuse gh_outdated "gh $MIN_GH or later is needed for \`gh attestation verify\`: update it (\`brew upgrade gh\`)"
"$GH" auth status >/dev/null 2>&1 ||
  refuse gh_not_logged_in 'gh is not logged in: the user runs `gh auth login` once (a browser login to GitHub; any account will do)'
step "machine: arm64, macOS $macos, gh $gh_version logged in"

# 2. The release files, in a new directory of their own.
work=$(mktemp -d "${TMPDIR:-/tmp}/projectman-install.XXXXXX")
manifest="$work/$MANIFEST_NAME"
zip="$work/$ZIP_NAME"
if [ -n "$zip_in" ]; then
  cp "$manifest_in" "$manifest" || refuse download_failed "cannot read $manifest_in"
  cp "$zip_in" "$zip" || refuse download_failed "cannot read $zip_in"
  step "release files: $manifest_in and $zip_in (downloaded by hand)"
else
  base="https://github.com/$REPO/releases/download/$tag"
  curl -fsSL --proto '=https' -o "$manifest" "$base/$MANIFEST_NAME" ||
    refuse download_failed "cannot download $base/$MANIFEST_NAME (is $tag a release with the engine app?)"
  curl -fsSL --proto '=https' -o "$zip" "$base/$ZIP_NAME" || refuse download_failed "cannot download $base/$ZIP_NAME"
  step "release files: downloaded from $base"
fi

# 3. The manifest.
# A value of the JSON manifest; empty when it has none (each check below then refuses).
field() {
  plutil -extract "$1" raw -o - "$manifest" 2>/dev/null || true
}
[ "$(field schemaVersion)" = 1 ] || refuse manifest_invalid 'the manifest is not schemaVersion 1'
[ "$(field tag)" = "$tag" ] || refuse manifest_invalid "the manifest is not of the release $tag"
[ "$(field arch)" = arm64 ] || refuse manifest_invalid 'the manifest is not for arm64'
[ "$(field zip.name)" = "$ZIP_NAME" ] || refuse manifest_invalid "the manifest does not describe $ZIP_NAME"
version=$(field version)
matches "$version" '[0-9a-f]{40}' || refuse manifest_invalid 'the manifest version is not a commit'
bundle_version=$(field bundleVersion)
matches "$bundle_version" '[0-9]{8}\.[0-9]+' || refuse manifest_invalid 'the manifest bundleVersion is not of a release'
expected_sha=$(field zip.sha256)
matches "$expected_sha" '[0-9a-f]{64}' || refuse manifest_invalid 'the manifest zip sha256 is invalid'
expected_size=$(field zip.size)
matches "$expected_size" '[1-9][0-9]*' || refuse manifest_invalid 'the manifest zip size is invalid'
step "manifest: $tag, commit $version"

# 4. The zip is the one the manifest names.
size=$(wc -c <"$zip" | tr -d ' ')
[ "$size" = "$expected_size" ] || refuse size_mismatch "the zip is $size bytes, the manifest says $expected_size"
sha=$(shasum -a 256 "$zip" | cut -d ' ' -f 1)
[ "$sha" = "$expected_sha" ] || refuse sha256_mismatch 'the SHA-256 of the zip differs from the manifest'
step "zip: $size bytes, sha256 $sha"

# 5. Both files were built by the release workflow (the trust anchor).
for file in "$zip" "$manifest"; do
  "$GH" attestation verify "$file" --repo "$REPO" --signer-workflow "$SIGNER_WORKFLOW" --source-ref "$SOURCE_REF" \
    --deny-self-hosted-runners >/dev/null ||
    refuse attestation_invalid "$(basename "$file") has no valid GitHub attestation of $SIGNER_WORKFLOW on $SOURCE_REF"
done
step "attestation: $ZIP_NAME and $MANIFEST_NAME built by $SIGNER_WORKFLOW"

# 6. Unpack into a new directory; it must hold exactly the app.
unpacked="$work/unpacked"
mkdir "$unpacked"
ditto -x -k "$zip" "$unpacked" || refuse unpack_failed 'the zip cannot be unpacked'
entries=$(ls -A "$unpacked")
[ "$entries" = "$APP_NAME" ] && [ -d "$unpacked/$APP_NAME" ] && [ ! -L "$unpacked/$APP_NAME" ] ||
  refuse unpack_invalid "the zip does not hold exactly $APP_NAME"
app="$unpacked/$APP_NAME"

# 7. The app: its signature, identifier, bundle version and bundled engine.
codesign --verify --deep --strict -R "=identifier \"$BUNDLE_ID\"" "$app" >/dev/null 2>&1 ||
  refuse signature_invalid "the code signature of the app is not valid or not of $BUNDLE_ID"
app_bundle_version=$(plutil -extract CFBundleVersion raw -o - "$app/Contents/Info.plist" 2>/dev/null || true)
[ "$app_bundle_version" = "$bundle_version" ] ||
  refuse version_mismatch "the app is ${app_bundle_version:-unreadable}, the manifest says $bundle_version"
bundled=$(plutil -extract version raw -o - "$app/Contents/Resources/engine/engine-package.json" 2>/dev/null || true)
[ "$bundled" = "$version" ] || refuse version_mismatch "the bundled engine is ${bundled:-unreadable}, the manifest says $version"
step "app: signature valid ($BUNDLE_ID), version $bundle_version, engine $version"

# 8. Copy the checked app next to its place, under a name of its own.
applications="$HOME/Applications"
target="$applications/$APP_NAME"
mkdir -p "$applications"
staged=$(mktemp -d "$applications/.projectman-install.XXXXXX")
ditto "$app" "$staged/$APP_NAME" || refuse copy_failed "cannot copy the app to $applications"

# 9. Only now: the quarantine attribute, then the app's name.
if xattr -rl "$staged/$APP_NAME" 2>/dev/null | grep -q "$QUARANTINE"; then
  xattr -dr "$QUARANTINE" "$staged/$APP_NAME" || refuse quarantine_failed "cannot remove $QUARANTINE from the app"
  step "quarantine: removed $QUARANTINE from the checked app"
else
  step 'quarantine: none'
fi
rm -rf "$target"
mv "$staged/$APP_NAME" "$target" || refuse copy_failed "cannot move the app to $target"
step "installed: $target"

printf '%s\n' \
  '' \
  'NEXT  Start the app:' \
  "        open \"$target\"" \
  '      If this environment does not allow `open`, tell the user: open the Applications folder of your home' \
  '      (Finder, Go menu, Home, Applications) and double-click "projectman motor".' \
  '      On first launch the app moves itself to /Applications when it can and installs the engine. It may ask' \
  '      for the Xcode command line tools (click Install), and macOS asks to allow its background item: the app' \
  '      opens System Settings, Login Items, where the user switches "projectman motor" on.'
