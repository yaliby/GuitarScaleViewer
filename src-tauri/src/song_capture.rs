//! One-shot audio capture via the ChordSync sidecar (yt-dlp + FFmpeg).
//!
//! Runs as a separate Python process so a download cannot stall Play Along's
//! stdin worker. Spotify / Apple Music are matched on YouTube from now-playing
//! metadata — this module never reads player session files.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::playalong::{
    chordsync_invocation, chordsync_package_root, hide_console, sidecar_script,
};

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(120);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub query: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub source_app: Option<String>,
    pub track_url: Option<String>,
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureProgress {
    status: String,
    progress: u32,
    stage: String,
}

/// Receives `(progress, stage)` from a one-shot script's stderr progress lines.
pub(crate) type ProgressSink = Box<dyn Fn(u32, &str) + Send + 'static>;

fn one_shot_script(name: &str) -> Option<PathBuf> {
    sidecar_script()
        .and_then(|sidecar| sidecar.parent().map(|dir| dir.join(name)))
        .filter(|path| path.is_file())
}

fn one_shot_command(name: &str, flag: &str, body: &Value) -> Result<Command, String> {
    let script = one_shot_script(name).ok_or_else(|| format!("{name} not found"))?;
    let (program, mut args) = chordsync_invocation(&script);
    args.push(script.to_string_lossy().to_string());
    args.push(flag.to_string());
    args.push(serde_json::to_string(body).map_err(|error| error.to_string())?);

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = script.parent() {
        let package_root = chordsync_package_root(&script);
        command.env("PYTHONPATH", &package_root);
        command.env("CHORDSYNC_ROOT", &package_root);
        command.current_dir(dir);
    }
    hide_console(&mut command);
    Ok(command)
}

fn request_body(req: &CaptureRequest, op: &str) -> Value {
    serde_json::json!({
        "op": op,
        "query": req.query,
        "title": req.title,
        "artist": req.artist,
        "album": req.album,
        "sourceApp": req.source_app,
        "trackUrl": req.track_url,
        "force": req.force.unwrap_or(false),
    })
}

fn emit_progress(app: Option<&AppHandle>, progress: u32, stage: &str) {
    let Some(app) = app else {
        return;
    };
    let payload = CaptureProgress {
        status: if progress >= 100 {
            "ready".to_string()
        } else {
            "capturing".to_string()
        },
        progress,
        stage: stage.to_string(),
    };
    if let Err(error) = app.emit("track-capture-progress", payload) {
        log::debug!("song_capture: progress emit failed: {error}");
    }
}

/// Run a sidecar script once (`<name> <flag> <json>`) and read its one-line JSON reply.
///
/// `progress` is the stderr marker key the script sets on its progress lines
/// (`{"<marker>": true, "progress": n, "stage": "..."}`) and where they go.
pub(crate) fn run_one_shot(
    name: &str,
    flag: &str,
    body: &Value,
    timeout: Duration,
    progress: Option<(&'static str, ProgressSink)>,
) -> Result<Value, String> {
    let mut command = one_shot_command(name, flag, body)?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn {name}: {error}"))?;
    if let Some(stderr) = child.stderr.take() {
        let label = name.to_string();
        std::thread::spawn(move || {
            // Skip an undecodable line and keep draining, so the sidecar never blocks on a full pipe.
            #[allow(clippy::lines_filter_map_ok)]
            for line in BufReader::new(stderr).lines().flatten() {
                if let Some((marker, sink)) = progress.as_ref() {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&line) {
                        if parsed.get(*marker).and_then(|v| v.as_bool()) == Some(true) {
                            let value =
                                parsed.get("progress").and_then(|v| v.as_u64()).unwrap_or(0);
                            let stage = parsed.get("stage").and_then(|v| v.as_str()).unwrap_or("");
                            sink(value as u32, stage);
                            continue;
                        }
                    }
                }
                log::info!("{label}: {line}");
            }
        });
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{name} stdout unavailable"))?;
    let label = name.to_string();
    let reader = std::thread::spawn(move || {
        BufReader::new(stdout)
            .lines()
            .next()
            .transpose()
            .map_err(|error| format!("read {label}: {error}"))
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    log::warn!("{name} exited {status}");
                }
                break;
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{name} deadline exceeded"));
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(error) => return Err(format!("wait {name}: {error}")),
        }
    }
    let line = reader
        .join()
        .map_err(|_| format!("{name} stdout thread panicked"))??
        .ok_or_else(|| format!("{name} returned no JSON"))?;
    serde_json::from_str(&line).map_err(|error| format!("{name} JSON: {error}: {line}"))
}

fn run_capture(
    flag: &str,
    body: &Value,
    timeout: Duration,
    app: Option<&AppHandle>,
) -> Result<Value, String> {
    let progress = app.cloned().map(|handle| {
        let sink: ProgressSink = Box::new(move |progress, stage| {
            let stage = if stage.is_empty() { "download" } else { stage };
            emit_progress(Some(&handle), progress, stage)
        });
        ("gsvCapture", sink)
    });
    run_one_shot("track_capture.py", flag, body, timeout, progress)
}

fn request_from_args(
    query: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    source_app: Option<String>,
    track_url: Option<String>,
    force: Option<bool>,
) -> CaptureRequest {
    CaptureRequest {
        query,
        title,
        artist,
        album,
        source_app,
        track_url,
        force,
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn capture_track(
    app: AppHandle,
    query: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    source_app: Option<String>,
    track_url: Option<String>,
    force: Option<bool>,
) -> Result<Value, String> {
    let req = request_from_args(query, title, artist, album, source_app, track_url, force);
    emit_progress(Some(&app), 1, "start");
    let value = run_capture(
        "--capture",
        &request_body(&req, "capture"),
        CAPTURE_TIMEOUT,
        Some(&app),
    )?;
    if value.get("status").and_then(|v| v.as_str()) == Some("ready") {
        emit_progress(Some(&app), 100, "done");
    }
    Ok(value)
}

#[tauri::command]
pub fn lookup_track_capture(
    query: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    source_app: Option<String>,
    track_url: Option<String>,
) -> Result<Value, String> {
    let req = request_from_args(query, title, artist, album, source_app, track_url, None);
    run_capture(
        "--lookup",
        &request_body(&req, "lookup"),
        LOOKUP_TIMEOUT,
        None,
    )
}

#[tauri::command]
pub fn list_track_captures() -> Result<Value, String> {
    run_capture(
        "--list",
        &serde_json::json!({ "op": "list" }),
        LOOKUP_TIMEOUT,
        None,
    )
}
