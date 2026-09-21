#!/usr/bin/env bash
# Record what the browser plays, so the key engine can be measured on real recordings.
#
#   scripts/capture-stream-clip.sh <url> <out.wav> [start_seconds] [duration_seconds]
#
# The stream is routed into a private null sink, so nothing comes out of the speakers and
# nothing else on the machine is captured with it. The browser runs in a throwaway profile.
set -euo pipefail

URL="${1:?usage: capture-stream-clip.sh <url> <out.wav> [start_s] [dur_s]}"
OUT="${2:?missing output wav}"
START="${3:-45}"
DUR="${4:-60}"

SINK=gsv_probe
PROFILE=/tmp/gsv-capture-profile
RAW="$(mktemp /tmp/gsv-capture-XXXX.wav)"

module_id=""
if ! pactl list short sinks | grep -q "[[:space:]]$SINK[[:space:]]"; then
  module_id=$(pactl load-module module-null-sink sink_name=$SINK \
    sink_properties=device.description=GSV_Probe)
fi

cleanup() {
  # Killing the launcher pid leaves the renderer and zygotes playing; match the profile instead.
  pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
  [[ -n "$module_id" ]] && pactl unload-module "$module_id" 2>/dev/null || true
  rm -f "$RAW"
}
trap cleanup EXIT

sep="?"; [[ "$URL" == *"?"* ]] && sep="&"
brave-browser --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --autoplay-policy=no-user-gesture-required --disable-session-crashed-bubble \
  --remote-debugging-port=9222 \
  --window-size=640,400 "${URL}${sep}t=${START}s" >/dev/null 2>&1 &
brave_pid=$!

# Wait for the tab to start producing audio, then pin that stream to the private sink.
for _ in $(seq 40); do
  input=$(pactl list short sink-inputs | awk '{print $1}' | tail -1)
  if [[ -n "$input" ]]; then
    pactl move-sink-input "$input" $SINK 2>/dev/null && break
  fi
  sleep 0.5
done
[[ -z "${input:-}" ]] && { echo "no audio stream appeared for $URL" >&2; exit 2; }

sleep 3   # let playback settle past the seek

# Name what actually played, so a mistyped video id cannot be mistaken for a bad reading.
curl -s --max-time 3 http://127.0.0.1:9222/json 2>/dev/null \
  | python3 -c 'import json,sys;[print("playing:",t["title"],"|",t["url"]) for t in json.load(sys.stdin) if t.get("type")=="page"]' \
  2>/dev/null || true

timeout $((DUR + 5)) parecord --device=$SINK.monitor --file-format=wav \
  --rate=44100 --channels=2 "$RAW" &
rec_pid=$!
sleep "$DUR"
kill "$rec_pid" 2>/dev/null || true
wait "$rec_pid" 2>/dev/null || true

ffmpeg -y -loglevel error -i "$RAW" -ar 44100 -ac 2 -c:a pcm_s16le "$OUT"
echo "wrote $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s)"
