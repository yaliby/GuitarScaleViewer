//! Windows Global System Media Transport Controls (GSMTC) — phase 1.
//!
//! Reads the OS “current” media session and exposes metadata to the React UI via Tauri events.
//! Future phases may attach: song-key cache, audio analyzer sidecar, detected key → UI root/scale.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Wire format for `media-session-update` and `get_current_media` (snake_case JSON).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaSessionPayload {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub source_app: Option<String>,
    pub playback_status: String,
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaSessionDebugEntry {
    pub source_app: Option<String>,
    pub playback_status: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub is_current: bool,
}

impl MediaSessionPayload {
    /// Non-Windows builds, or when the host cannot provide GSMTC.
    #[cfg_attr(windows, allow(dead_code))]
    pub fn unavailable() -> Self {
        Self {
            title: None,
            artist: None,
            album: None,
            source_app: None,
            playback_status: "media_session_unavailable".to_string(),
            position_ms: None,
            duration_ms: None,
        }
    }

    fn empty_session() -> Self {
        Self {
            title: None,
            artist: None,
            album: None,
            source_app: None,
            playback_status: "none".to_string(),
            position_ms: None,
            duration_ms: None,
        }
    }
}

#[cfg(windows)]
mod win {
    use super::{MediaSessionDebugEntry, MediaSessionPayload};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    fn hstring_opt(h: windows::core::HSTRING) -> Option<String> {
        if h.is_empty() {
            None
        } else {
            Some(h.to_string())
        }
    }

    fn timespan_to_ms(ts: windows::Foundation::TimeSpan) -> Option<u64> {
        let ticks = ts.Duration;
        if ticks <= 0 {
            return None;
        }
        // WinRT TimeSpan: Duration is 100-nanosecond ticks.
        Some((ticks as u64) / 10_000)
    }

    fn playback_status_str(
        s: GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    ) -> String {
        use GlobalSystemMediaTransportControlsSessionPlaybackStatus as P;
        match s {
            P::Playing => "playing".to_string(),
            P::Paused => "paused".to_string(),
            P::Stopped => "stopped".to_string(),
            P::Closed => "closed".to_string(),
            P::Opened => "opened".to_string(),
            P::Changing => "changing".to_string(),
            _ => "unknown".to_string(),
        }
    }

    fn session_to_debug_entry(
        session: &GlobalSystemMediaTransportControlsSession,
        current_source: Option<&str>,
    ) -> MediaSessionDebugEntry {
        let source_app = session.SourceAppUserModelId().ok().and_then(hstring_opt);
        let playback_status = session
            .GetPlaybackInfo()
            .ok()
            .and_then(|info| info.PlaybackStatus().ok())
            .map(playback_status_str)
            .unwrap_or_else(|| "unknown".to_string());
        let title = None;
        let artist = None;
        let album = None;
        let is_current = current_source
            .map(|c| source_app.as_deref() == Some(c))
            .unwrap_or(false);
        MediaSessionDebugEntry {
            source_app,
            playback_status,
            title,
            artist,
            album,
            is_current,
        }
    }

    pub async fn enumerate_sessions() -> Vec<MediaSessionDebugEntry> {
        let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            Ok(op) => match op.await {
                Ok(m) => m,
                Err(e) => {
                    log::debug!("media_session: enumerate RequestAsync failed: {e}");
                    return Vec::new();
                }
            },
            Err(e) => {
                log::debug!("media_session: enumerate RequestAsync (sync) failed: {e}");
                return Vec::new();
            }
        };

        let current_source = manager
            .GetCurrentSession()
            .ok()
            .and_then(|s| s.SourceAppUserModelId().ok().and_then(hstring_opt));

        let sessions = match manager.GetSessions() {
            Ok(s) => s,
            Err(e) => {
                log::debug!("media_session: enumerate GetSessions failed: {e}");
                return Vec::new();
            }
        };
        let count = sessions.Size().unwrap_or(0);
        let mut out = Vec::with_capacity(count as usize);
        for idx in 0..count {
            if let Ok(session) = sessions.GetAt(idx) {
                out.push(session_to_debug_entry(&session, current_source.as_deref()));
            }
        }
        out
    }

    fn should_log_snapshot() -> bool {
        static LAST: OnceLock<Mutex<Instant>> = OnceLock::new();
        let gate = LAST.get_or_init(|| Mutex::new(Instant::now() - Duration::from_secs(60)));
        let Ok(mut last) = gate.lock() else {
            return true;
        };
        if last.elapsed() >= Duration::from_secs(5) {
            *last = Instant::now();
            true
        } else {
            false
        }
    }

    pub async fn fetch_payload() -> MediaSessionPayload {
        let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            Ok(op) => match op.await {
                Ok(m) => m,
                Err(e) => {
                    log::debug!("media_session: RequestAsync: {e}");
                    return MediaSessionPayload::empty_session();
                }
            },
            Err(e) => {
                log::debug!("media_session: RequestAsync (sync): {e}");
                return MediaSessionPayload::empty_session();
            }
        };

        let session: GlobalSystemMediaTransportControlsSession = match manager.GetCurrentSession()
        {
            Ok(s) => s,
            Err(_) => {
                if should_log_snapshot() {
                    let sessions = enumerate_sessions().await;
                    log::info!(
                        "media_session: current session unavailable visibleSessions={} sessions={:?}",
                        sessions.len(),
                        sessions
                            .iter()
                            .map(|s| format!(
                                "{}:{}:{}",
                                s.source_app.clone().unwrap_or_else(|| "<none>".to_string()),
                                s.playback_status,
                                if s.is_current { "current" } else { "not_current" }
                            ))
                            .collect::<Vec<_>>()
                    );
                }
                return MediaSessionPayload::empty_session();
            }
        };

        let media = match session.TryGetMediaPropertiesAsync() {
            Ok(op) => match op.await {
                Ok(m) => m,
                Err(e) => {
                    log::debug!("media_session: TryGetMediaPropertiesAsync: {e}");
                    return MediaSessionPayload::empty_session();
                }
            },
            Err(e) => {
                log::debug!("media_session: TryGetMediaPropertiesAsync (sync): {e}");
                return MediaSessionPayload::empty_session();
            }
        };

        let title = media.Title().ok().and_then(hstring_opt);
        let artist = media.Artist().ok().and_then(hstring_opt);
        let album = media.AlbumTitle().ok().and_then(hstring_opt);
        let source_app = session.SourceAppUserModelId().ok().and_then(hstring_opt);

        let playback_status = session
            .GetPlaybackInfo()
            .ok()
            .and_then(|info| info.PlaybackStatus().ok())
            .map(playback_status_str)
            .unwrap_or_else(|| "unknown".to_string());

        let (position_ms, duration_ms) = session
            .GetTimelineProperties()
            .ok()
            .map(|t| {
                let pos = t.Position().ok().and_then(timespan_to_ms);
                let dur = match (t.StartTime(), t.EndTime()) {
                    (Ok(start), Ok(end)) => {
                        let a = start.Duration;
                        let b = end.Duration;
                        if b > a {
                            Some(((b - a) as u64) / 10_000)
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                (pos, dur)
            })
            .unwrap_or((None, None));

        MediaSessionPayload {
            title,
            artist,
            album,
            source_app,
            playback_status,
            position_ms,
            duration_ms,
        }
    }
}

/// Snapshot for `#[tauri::command]` and poller (Windows); stub elsewhere.
pub async fn get_current_media_payload() -> MediaSessionPayload {
    #[cfg(windows)]
    {
        media_with_deadline(win::fetch_payload(), Duration::from_secs(2)).await
    }
    #[cfg(not(windows))]
    {
        MediaSessionPayload::unavailable()
    }
}

#[cfg(windows)]
async fn media_with_deadline(
    poll: impl std::future::Future<Output = MediaSessionPayload>,
    deadline: Duration,
) -> MediaSessionPayload {
    match tokio::time::timeout(deadline, poll).await {
        Ok(payload) => payload,
        Err(_) => {
            log::warn!("media_session: metadata lookup deadline exceeded");
            MediaSessionPayload::unavailable()
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn slow_media_lookup_returns_unavailable_and_drops_pending_work() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        struct Cancelled(Arc<AtomicBool>);
        impl Drop for Cancelled {
            fn drop(&mut self) { self.0.store(true, Ordering::Relaxed); }
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation_flag = cancelled.clone();
        let poll = async move {
            let _cancelled = Cancelled(cancellation_flag);
            tokio::time::sleep(Duration::from_millis(200)).await;
            MediaSessionPayload::empty_session()
        };
        let start = std::time::Instant::now();
        let result = media_with_deadline(poll, Duration::from_millis(20)).await;
        assert_eq!(result.playback_status, "media_session_unavailable");
        assert!(start.elapsed() < Duration::from_millis(150));
        assert!(cancelled.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn timely_media_lookup_preserves_snapshot() {
        let mut expected = MediaSessionPayload::empty_session();
        expected.title = Some("Current track".into());
        expected.playback_status = "playing".into();
        expected.position_ms = Some(1234);
        let result = media_with_deadline(std::future::ready(expected.clone()), Duration::from_millis(20)).await;
        assert_eq!(result, expected);
    }
}

#[tauri::command]
pub async fn get_current_media() -> MediaSessionPayload {
    get_current_media_payload().await
}

#[tauri::command]
pub async fn get_media_sessions_debug() -> Vec<MediaSessionDebugEntry> {
    #[cfg(windows)]
    {
        win::enumerate_sessions().await
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Backend-owned polling loop; React only subscribes to `media-session-update`.
pub fn spawn_media_session_poller(app: AppHandle) {
    #[cfg(windows)]
    {
        std::thread::Builder::new()
            .name("media-session-poller".into())
            .spawn(move || {
                let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    log::error!("media_session: failed to build tokio runtime");
                    return;
                };

                let mut last: Option<MediaSessionPayload> = None;
                loop {
                    let next = rt.block_on(get_current_media_payload());
                    if last.as_ref() != Some(&next) {
                        last = Some(next.clone());
                        if let Err(e) = app.emit("media-session-update", &next) {
                            log::warn!("media_session: emit failed: {e}");
                        }
                    }
                    std::thread::sleep(Duration::from_millis(1500));
                }
            })
            .expect("spawn media-session-poller");
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}
