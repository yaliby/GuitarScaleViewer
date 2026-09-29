//! Word-by-word lyric timing for a saved song (`lyric_map.py`: LRCLIB + Whisper + alignment).
//!
//! A one-shot process like track capture, so a transcription never holds the
//! Play Along worker. Async, because a whole-song Whisper pass takes seconds on a
//! GPU and minutes on a CPU, and a sync command would hold the main thread.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::song_capture::{run_one_shot, ProgressSink};

const MAP_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LyricsProgress {
    id: String,
    progress: u32,
    stage: String,
}

/// The saved map for capture `id`, making it first unless `cached_only`.
/// Progress arrives as `track-lyrics-progress` events.
#[tauri::command]
pub async fn map_track_lyrics(
    app: AppHandle,
    id: String,
    force: Option<bool>,
    cached_only: Option<bool>,
) -> Result<Value, String> {
    let body = serde_json::json!({ "id": id, "force": force.unwrap_or(false) });
    let cached_only = cached_only.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if cached_only {
            return run_one_shot("lyric_map.py", "--lookup", &body, LOOKUP_TIMEOUT, None);
        }
        let sink: ProgressSink = Box::new(move |progress, stage| {
            let payload = LyricsProgress {
                id: id.clone(),
                progress,
                stage: stage.to_string(),
            };
            if let Err(error) = app.emit("track-lyrics-progress", payload) {
                log::debug!("lyric_map: progress emit failed: {error}");
            }
        });
        run_one_shot(
            "lyric_map.py",
            "--map",
            &body,
            MAP_TIMEOUT,
            Some(("gsvLyrics", sink)),
        )
    })
    .await
    .map_err(|error| format!("lyric map task: {error}"))?
}
