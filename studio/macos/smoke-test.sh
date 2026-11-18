#!/bin/bash
# Exercise the real Nino .dmg on a fresh GitHub macOS runner: mount, copy the
# app like a user would, launch twice, stop safely and check what remains.
# It never starts OBS, a recording or a live stream.
set -euo pipefail
dmg="$1"; report_dir="$2"
[ -f "$dmg" ] || { echo "DMG introuvable : $dmg" >&2; exit 1; }
mkdir -p "$report_dir"
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/nino-smoke.XXXXXX")"
export NINO_USER_ROOT="$work/user"
ok() { echo "OK: $1"; echo "$1" >> "$report_dir/macos-smoke.txt"; }
cleanup() {
  [ -n "${mount:-}" ] && hdiutil detach "$mount" -quiet 2>/dev/null || true
  cp "$NINO_USER_ROOT"/logs/*.log "$report_dir"/ 2>/dev/null || true
  # Only processes recorded by this test's own launcher state.
  for state in "$NINO_USER_ROOT"/run/api.json "$NINO_USER_ROOT"/run/media.json; do
    [ -f "$state" ] && kill "$(/usr/bin/plutil -extract pid raw "$state" 2>/dev/null || sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$state")" 2>/dev/null || true
  done
}
trap cleanup EXIT
: > "$report_dir/macos-smoke.txt"

mount="$work/mount"; mkdir -p "$mount"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount" -quiet
[ -d "$mount/Nino.app" ] && [ -L "$mount/Applications" ] && ok "le DMG contient Nino.app et le raccourci Applications"
mkdir -p "$work/Applications"
ditto "$mount/Nino.app" "$work/Applications/Nino.app"
hdiutil detach "$mount" -quiet; mount=""
app="$work/Applications/Nino.app"
plutil -lint "$app/Contents/Info.plist" >/dev/null && ok "Info.plist valide"
codesign --verify --strict --verbose=2 "$app" && ok "signature de Nino.app valide"
file "$app/Contents/Resources/runtime/node/bin/node" | grep -q 'arm64' && ok "Node.js arm64 embarqué"
# Mark the copy as downloaded by a browser, like a real user's copy.
xattr -r -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" "$app"

launch() { "$app/Contents/MacOS/Nino" --no-dialogs --no-browser --no-obs "$@"; }
pid_of() { sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$NINO_USER_ROOT/run/$1.json"; }

launch
ok "premier lancement (préparation FFmpeg, MediaMTX et API)"
curl -fsS http://127.0.0.1:4310/api/guest/config | grep -q '"studio"' && ok "API studio répond sur 4310"
curl -fsS http://127.0.0.1:4312/api/guest/config | grep -q '"guest"' && ok "API invités répond sur 4312"
curl -fsS http://127.0.0.1:9997/v3/paths/list | grep -q itemCount && ok "MediaMTX répond sur 9997"
curl -fsS http://127.0.0.1:4310/ | grep -qi '<html' && ok "interface servie"
ffmpeg="$(ls "$NINO_USER_ROOT"/runtime/ffmpeg/*/ffmpeg)"
"$ffmpeg" -hide_banner -encoders | grep -q libx264 && ok "FFmpeg téléchargé, vérifié et fonctionnel"
"$(dirname "$ffmpeg")/ffprobe" -version | grep -q 'ffprobe version' && ok "ffprobe fonctionnel"
"$ffmpeg" -hide_banner -loglevel error -f lavfi -i testsrc=duration=1:size=320x240:rate=25 -f lavfi -i sine=duration=1 \
  -c:v libx264 -c:a aac -shortest "$work/essai.mp4" && "$(dirname "$ffmpeg")/ffprobe" -v error -show_entries stream=codec_name -of csv=p=0 "$work/essai.mp4" | grep -q h264 \
  && ok "encodage H.264/AAC de contrôle"
api1="$(pid_of api)"; media1="$(pid_of media)"

launch
[ "$(pid_of api)" = "$api1" ] && [ "$(pid_of media)" = "$media1" ] && ok "second lancement : services réutilisés"

launch --stop
! kill -0 "$api1" 2>/dev/null && ! kill -0 "$media1" 2>/dev/null && ok "arrêt protégé : API et MediaMTX fermés"
! curl -fsS --max-time 2 http://127.0.0.1:4310/ >/dev/null 2>&1 && ok "port 4310 libéré"
[ -d "$NINO_USER_ROOT/data" ] && ok "données conservées après l’arrêt"

# A foreign listener on a Nino port is reported, never killed.
python3 -c 'import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1",4310)); s.listen(); time.sleep(120)' &
blocker=$!
for _ in $(seq 50); do nc -z 127.0.0.1 4310 2>/dev/null && break; sleep 0.2; done
kill -0 $blocker || { echo "Le programme d’essai n’a pas pu occuper le port 4310." >&2; exit 1; }
if launch; then echo "Le lanceur aurait dû refuser un port occupé." >&2; kill $blocker; exit 1; fi
kill -0 $blocker && ok "port occupé par un autre programme : refus sans rien arrêter"
kill $blocker
echo "Essai macOS terminé."
