//! The singer and the band as two files (`stem_split.py`), so the sheet can turn the singer down.
//!
//! A one-shot process like lyric mapping, queued behind it: both are heavy and two at once only
//! make each other slower.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::lyric_map::MAP_QUEUE;
use crate::song_capture::{run_one_shot, ProgressSink};

const STEMS_TIMEOUT: Duration = Duration::from_secs(40 * 60);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StemsProgress {
    id: String,
    progress: u32,
    stage: String,
}

/// The saved stems for capture `id` (`instrumentalPath`, `vocalsPath`), made first unless
/// `cached_only`. Progress arrives as `track-stems-progress` events.
#[tauri::command]
pub async fn make_track_stems(
    app: AppHandle,
    id: String,
    cached_only: Option<bool>,
) -> Result<Value, String> {
    let cached_only = cached_only.unwrap_or(false);
    let body = serde_json::json!({ "id": id, "cachedOnly": cached_only });
    tauri::async_runtime::spawn_blocking(move || {
        if cached_only {
            return run_one_shot("stem_split.py", "--stems", &body, LOOKUP_TIMEOUT, None);
        }
        let _turn = MAP_QUEUE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let sink: ProgressSink = Box::new(move |progress, stage| {
            let payload = StemsProgress {
                id: id.clone(),
                progress,
                stage: stage.to_string(),
            };
            if let Err(error) = app.emit("track-stems-progress", payload) {
                log::debug!("track_stems: progress emit failed: {error}");
            }
        });
        run_one_shot(
            "stem_split.py",
            "--stems",
            &body,
            STEMS_TIMEOUT,
            Some(("gsvStems", sink)),
        )
    })
    .await
    .map_err(|error| format!("track stems task: {error}"))?
}
