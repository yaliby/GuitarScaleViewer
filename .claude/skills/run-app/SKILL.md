---
name: run-app
description: Launch the GuitarScaleViewer Tauri desktop app in dev mode on Linux (Vite + Rust + analyzer sidecars) and confirm it is up.
---

# Run the desktop app (Linux)

`./dev.sh` is the whole recipe. It repairs the known Linux setup problems itself:
- builds the libkeyfinder CLI when the build dir is missing or holds zero-byte stand-ins
- adds the Linux Tauri CLI binary when `node_modules` was installed from Windows (shared NTFS drive)
- puts `~/.cargo/bin` on PATH for non-login shells
- creates the ChordSync venv `src-tauri/sidecars/chordsync/.venv-linux` with `uv` (the `.venv` there
  is the Windows one) and exports `CHORDSYNC_PYTHON`; without it Play Along, lyrics and capture are dead
  and the log fills with `ECONNREFUSED 127.0.0.1:18766`
- downloads FFmpeg into `.tools/ffmpeg` on first run

## Launch

Run in the background (the first Rust build takes several minutes; later ones are incremental):

```bash
./dev.sh > /tmp/gsv-dev.log 2>&1   # run_in_background: true
```

## Confirm it is up

```bash
for i in $(seq 1 180); do pgrep -x app >/dev/null && break; grep -qE "Cannot find module|cargo not found|error\[E|refusing" /tmp/gsv-dev.log && break; sleep 3; done
grep "^dev.sh" /tmp/gsv-dev.log               # setup steps taken
pgrep -x app && curl -s -o /dev/null -w "vite %{http_code}\n" http://127.0.0.1:1420/
grep -m1 -oE "analyzerBackend=[a-z_]+" /tmp/gsv-dev.log   # expect libkeyfinder, not numpy_fallback
grep -m1 "chordsync http listening" /tmp/gsv-dev.log       # Play Along sidecar is up
grep -c ECONNREFUSED /tmp/gsv-dev.log                      # expect 0
```

Cargo's progress output is full of ANSI codes, so don't wait on a "Running `target/debug/app`" match.
Wait for the `app` process instead.

## Gotchas

- Scripts on this drive may lack the exec bit: use `bash <script>.sh` if `./x.sh` says Permission denied.
- Don't `pkill -f` with a pattern such as `target/debug/app`: it also matches, and kills, the shell running the command. Use `pgrep -x app` / `kill <pid>`.
- `grim` screenshots fail on this GNOME Wayland session.
- `npx vitest` under the default jsdom environment crashes on Node 20 (`webidl.util.markAsUncloneable
  is not a function`); tests that don't need a DOM run with `--environment node`.
- If port 1420 is busy, `dev.sh` picks the next free port and prints it.
