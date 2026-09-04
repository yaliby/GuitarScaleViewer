//! OS now-playing metadata.
//!
//! * Windows: Global System Media Transport Controls (GSMTC)
//! * Linux: MPRIS v2 over the session D-Bus
//!
//! Exposes the current session to the React UI via Tauri events. Future phases
//! may attach: song-key cache, audio analyzer sidecar, detected key → UI root/scale.

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
    /// When the host has no media-session backend, or the backend cannot connect.
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

#[cfg(target_os = "linux")]
impl From<&SessionCandidate> for MediaSessionPayload {
    fn from(session: &SessionCandidate) -> Self {
        Self {
            title: session.title.clone(),
            artist: session.artist.clone(),
            album: session.album.clone(),
            source_app: session.source_app.clone(),
            playback_status: session.playback_status.clone(),
            position_ms: session.position_ms,
            duration_ms: session.duration_ms,
        }
    }
}

/// Normalized player snapshot used to pick the “current” session on Linux (and in tests).
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionCandidate {
    bus_name: String,
    source_app: Option<String>,
    playback_status: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    position_ms: Option<u64>,
    duration_ms: Option<u64>,
}

fn normalize_playback_status(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "playing" => "playing".to_string(),
        "paused" => "paused".to_string(),
        "stopped" => "stopped".to_string(),
        "closed" => "closed".to_string(),
        "opened" => "opened".to_string(),
        "changing" => "changing".to_string(),
        "" => "unknown".to_string(),
        other => other.to_string(),
    }
}

fn duration_ms_from_mpris_length_us(length_us: i64) -> Option<u64> {
    if length_us <= 0 {
        None
    } else {
        Some((length_us as u64) / 1_000)
    }
}

fn position_ms_from_us(position_us: i64) -> Option<u64> {
    if position_us < 0 {
        None
    } else {
        Some((position_us as u64) / 1_000)
    }
}

fn join_artists(artists: &[String]) -> Option<String> {
    let joined = artists
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

fn source_app_from(
    identity: Option<String>,
    desktop_entry: Option<String>,
    bus_name: &str,
) -> Option<String> {
    let identity = identity.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let desktop = desktop_entry
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    identity.or(desktop).or_else(|| {
        bus_name
            .strip_prefix("org.mpris.MediaPlayer2.")
            .map(|rest| rest.split('.').next().unwrap_or(rest).to_string())
            .filter(|s| !s.is_empty())
    })
}

fn is_playerctld(bus_name: &str) -> bool {
    bus_name == "org.mpris.MediaPlayer2.playerctld"
        || bus_name.starts_with("org.mpris.MediaPlayer2.playerctld.")
}

/// Pick the session that should be treated as “now playing”.
///
/// `playerctld` multiplexes MPRIS players (closest equivalent to GSMTC’s current
/// session). Otherwise prefer a Playing player with a title, then Playing, then
/// Paused with a title, then any titled session.
fn select_current_session(sessions: &[SessionCandidate]) -> Option<&SessionCandidate> {
    if sessions.is_empty() {
        return None;
    }

    if let Some(ctl) = sessions.iter().find(|s| is_playerctld(&s.bus_name)) {
        if ctl.playback_status == "playing" || ctl.title.is_some() {
            return Some(ctl);
        }
    }

    let not_ctl = |s: &&SessionCandidate| !is_playerctld(&s.bus_name);
    sessions
        .iter()
        .filter(not_ctl)
        .find(|s| s.playback_status == "playing" && s.title.is_some())
        .or_else(|| {
            sessions
                .iter()
                .filter(not_ctl)
                .find(|s| s.playback_status == "playing")
        })
        .or_else(|| {
            sessions
                .iter()
                .filter(not_ctl)
                .find(|s| s.playback_status == "paused" && s.title.is_some())
        })
        .or_else(|| sessions.iter().filter(not_ctl).find(|s| s.title.is_some()))
        .or_else(|| sessions.iter().filter(not_ctl).next())
}

fn debug_entries_from_sessions(
    sessions: &[SessionCandidate],
    current_bus: Option<&str>,
) -> Vec<MediaSessionDebugEntry> {
    sessions
        .iter()
        .map(|s| MediaSessionDebugEntry {
            source_app: s.source_app.clone(),
            playback_status: s.playback_status.clone(),
            title: s.title.clone(),
            artist: s.artist.clone(),
            album: s.album.clone(),
            is_current: current_bus.map(|c| s.bus_name == c).unwrap_or(false),
        })
        .collect()
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

#[cfg(target_os = "linux")]
mod linux {
    use super::{
        debug_entries_from_sessions, duration_ms_from_mpris_length_us, join_artists,
        normalize_playback_status, position_ms_from_us, select_current_session, source_app_from,
        MediaSessionDebugEntry, MediaSessionPayload, SessionCandidate,
    };
    use std::collections::HashMap;
    use zbus::zvariant::OwnedValue;
    use zbus::Connection;

    const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
    const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";

    static CONNECTION: tokio::sync::OnceCell<Connection> = tokio::sync::OnceCell::const_new();

    #[zbus::proxy(
        interface = "org.mpris.MediaPlayer2.Player",
        default_path = "/org/mpris/MediaPlayer2"
    )]
    trait MprisPlayer {
        #[zbus(property)]
        fn playback_status(&self) -> zbus::Result<String>;

        #[zbus(property)]
        fn metadata(&self) -> zbus::Result<HashMap<String, OwnedValue>>;

        #[zbus(property)]
        fn position(&self) -> zbus::Result<i64>;
    }

    #[zbus::proxy(
        interface = "org.mpris.MediaPlayer2",
        default_path = "/org/mpris/MediaPlayer2"
    )]
    trait MprisRoot {
        #[zbus(property)]
        fn identity(&self) -> zbus::Result<String>;

        #[zbus(property)]
        fn desktop_entry(&self) -> zbus::Result<String>;
    }

    async fn session_connection() -> zbus::Result<Connection> {
        CONNECTION
            .get_or_try_init(Connection::session)
            .await
            .cloned()
    }

    fn owned_string(value: &OwnedValue) -> Option<String> {
        String::try_from(value.clone())
            .ok()
            .or_else(|| <&str>::try_from(value).ok().map(str::to_string))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn owned_i64(value: &OwnedValue) -> Option<i64> {
        i64::try_from(value.clone())
            .ok()
            .or_else(|| u64::try_from(value.clone()).ok().and_then(|n| i64::try_from(n).ok()))
            .or_else(|| i32::try_from(value.clone()).ok().map(i64::from))
    }

    fn metadata_string(map: &HashMap<String, OwnedValue>, key: &str) -> Option<String> {
        map.get(key).and_then(owned_string)
    }

    fn metadata_artists(map: &HashMap<String, OwnedValue>) -> Option<String> {
        let value = map.get("xesam:artist")?;
        if let Ok(list) = Vec::<String>::try_from(value.clone()) {
            return join_artists(&list);
        }
        owned_string(value)
    }

    fn metadata_duration_ms(map: &HashMap<String, OwnedValue>) -> Option<u64> {
        map.get("mpris:length")
            .and_then(owned_i64)
            .and_then(duration_ms_from_mpris_length_us)
    }

    async fn read_player(conn: &Connection, bus_name: &str) -> Option<SessionCandidate> {
        let destination = zbus::names::BusName::try_from(bus_name).ok()?;
        let player = MprisPlayerProxy::builder(conn)
            .destination(destination.clone())
            .ok()?
            .path(MPRIS_PATH)
            .ok()?
            .build()
            .await
            .ok()?;
        let root = MprisRootProxy::builder(conn)
            .destination(destination)
            .ok()?
            .path(MPRIS_PATH)
            .ok()?
            .build()
            .await
            .ok()?;

        let playback_status = normalize_playback_status(
            &player
                .playback_status()
                .await
                .unwrap_or_else(|_| "unknown".to_string()),
        );
        let metadata = player.metadata().await.unwrap_or_default();
        let position_ms = player
            .position()
            .await
            .ok()
            .and_then(position_ms_from_us);
        let identity = root.identity().await.ok();
        let desktop_entry = root.desktop_entry().await.ok();

        Some(SessionCandidate {
            bus_name: bus_name.to_string(),
            source_app: source_app_from(identity, desktop_entry, bus_name),
            playback_status,
            title: metadata_string(&metadata, "xesam:title"),
            artist: metadata_artists(&metadata),
            album: metadata_string(&metadata, "xesam:album"),
            position_ms,
            duration_ms: metadata_duration_ms(&metadata),
        })
    }

    async fn list_mpris_names(conn: &Connection) -> Result<Vec<String>, zbus::Error> {
        let dbus = zbus::fdo::DBusProxy::new(conn).await?;
        let names = dbus.list_names().await?;
        Ok(names
            .into_iter()
            .map(|n| n.to_string())
            .filter(|n| n.starts_with(MPRIS_PREFIX))
            .collect())
    }

    async fn load_sessions(conn: &Connection) -> Vec<SessionCandidate> {
        let names = match list_mpris_names(conn).await {
            Ok(n) => n,
            Err(e) => {
                log::debug!("media_session: linux ListNames failed: {e}");
                return Vec::new();
            }
        };
        let mut sessions = Vec::with_capacity(names.len());
        for name in names {
            match read_player(conn, &name).await {
                Some(session) => sessions.push(session),
                None => log::debug!("media_session: linux skipped unreadable player {name}"),
            }
        }
        sessions
    }

    pub async fn fetch_payload() -> MediaSessionPayload {
        let conn = match session_connection().await {
            Ok(c) => c,
            Err(e) => {
                log::debug!("media_session: linux D-Bus session unavailable: {e}");
                return MediaSessionPayload::unavailable();
            }
        };
        let sessions = load_sessions(&conn).await;
        match select_current_session(&sessions) {
            Some(current) => MediaSessionPayload::from(current),
            None => MediaSessionPayload::empty_session(),
        }
    }

    pub async fn enumerate_sessions() -> Vec<MediaSessionDebugEntry> {
        let conn = match session_connection().await {
            Ok(c) => c,
            Err(e) => {
                log::debug!("media_session: linux enumerate D-Bus unavailable: {e}");
                return Vec::new();
            }
        };
        let sessions = load_sessions(&conn).await;
        let current_bus = select_current_session(&sessions).map(|s| s.bus_name.as_str());
        debug_entries_from_sessions(&sessions, current_bus)
    }
}

/// Snapshot for `#[tauri::command]` and poller.
pub async fn get_current_media_payload() -> MediaSessionPayload {
    #[cfg(windows)]
    {
        win::fetch_payload().await
    }
    #[cfg(target_os = "linux")]
    {
        linux::fetch_payload().await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        MediaSessionPayload::unavailable()
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
    #[cfg(target_os = "linux")]
    {
        linux::enumerate_sessions().await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Vec::new()
    }
}

/// Backend-owned polling loop; React only subscribes to `media-session-update`.
pub fn spawn_media_session_poller(app: AppHandle) {
    #[cfg(any(windows, target_os = "linux"))]
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
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = app;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(
        bus: &str,
        status: &str,
        title: Option<&str>,
        source: Option<&str>,
    ) -> SessionCandidate {
        SessionCandidate {
            bus_name: bus.to_string(),
            source_app: source.map(str::to_string),
            playback_status: status.to_string(),
            title: title.map(str::to_string),
            artist: None,
            album: None,
            position_ms: None,
            duration_ms: None,
        }
    }

    #[test]
    fn normalize_playback_status_maps_mpris_and_gsmtc_values() {
        assert_eq!(normalize_playback_status("Playing"), "playing");
        assert_eq!(normalize_playback_status("PAUSED"), "paused");
        assert_eq!(normalize_playback_status("Stopped"), "stopped");
        assert_eq!(normalize_playback_status(""), "unknown");
    }

    #[test]
    fn mpris_length_and_position_convert_microseconds() {
        assert_eq!(duration_ms_from_mpris_length_us(3_500_000), Some(3_500));
        assert_eq!(duration_ms_from_mpris_length_us(0), None);
        assert_eq!(duration_ms_from_mpris_length_us(-1), None);
        assert_eq!(position_ms_from_us(1_250_000), Some(1_250));
        assert_eq!(position_ms_from_us(-5), None);
    }

    #[test]
    fn join_artists_skips_blanks() {
        assert_eq!(
            join_artists(&["Radiohead".into(), " ".into(), "Thom Yorke".into()]),
            Some("Radiohead, Thom Yorke".to_string())
        );
        assert_eq!(join_artists(&["  ".into()]), None);
    }

    #[test]
    fn source_app_prefers_identity_then_desktop_then_bus() {
        assert_eq!(
            source_app_from(
                Some("Spotify".into()),
                Some("spotify".into()),
                "org.mpris.MediaPlayer2.spotify"
            )
            .as_deref(),
            Some("Spotify")
        );
        assert_eq!(
            source_app_from(None, Some("vlc".into()), "org.mpris.MediaPlayer2.vlc").as_deref(),
            Some("vlc")
        );
        assert_eq!(
            source_app_from(None, None, "org.mpris.MediaPlayer2.firefox.instance_1").as_deref(),
            Some("firefox")
        );
    }

    #[test]
    fn select_current_prefers_playerctld_when_it_has_a_track() {
        let sessions = vec![
            candidate(
                "org.mpris.MediaPlayer2.vlc",
                "playing",
                Some("Other"),
                Some("VLC"),
            ),
            candidate(
                "org.mpris.MediaPlayer2.playerctld",
                "playing",
                Some("Active"),
                Some("playerctld"),
            ),
        ];
        let current = select_current_session(&sessions).unwrap();
        assert_eq!(current.title.as_deref(), Some("Active"));
        assert!(is_playerctld(&current.bus_name));
    }

    #[test]
    fn select_current_prefers_playing_titled_player() {
        let sessions = vec![
            candidate(
                "org.mpris.MediaPlayer2.firefox.instance1",
                "paused",
                Some("Old"),
                Some("Firefox"),
            ),
            candidate(
                "org.mpris.MediaPlayer2.spotify",
                "playing",
                Some("Song"),
                Some("Spotify"),
            ),
            candidate(
                "org.mpris.MediaPlayer2.chromium.instance2",
                "stopped",
                None,
                Some("Chromium"),
            ),
        ];
        let current = select_current_session(&sessions).unwrap();
        assert_eq!(current.source_app.as_deref(), Some("Spotify"));
        assert_eq!(current.title.as_deref(), Some("Song"));
    }

    #[test]
    fn select_current_falls_back_to_paused_title() {
        let sessions = vec![
            candidate(
                "org.mpris.MediaPlayer2.chromium.instance2",
                "stopped",
                None,
                Some("Chromium"),
            ),
            candidate(
                "org.mpris.MediaPlayer2.vlc",
                "paused",
                Some("Ballad"),
                Some("VLC"),
            ),
        ];
        let current = select_current_session(&sessions).unwrap();
        assert_eq!(current.title.as_deref(), Some("Ballad"));
    }

    #[test]
    fn empty_session_list_selects_nothing() {
        assert!(select_current_session(&[]).is_none());
    }

    #[test]
    fn debug_entries_mark_the_selected_current_bus() {
        let sessions = vec![
            candidate(
                "org.mpris.MediaPlayer2.vlc",
                "paused",
                Some("Idle"),
                Some("VLC"),
            ),
            candidate(
                "org.mpris.MediaPlayer2.spotify",
                "playing",
                Some("Song"),
                Some("Spotify"),
            ),
        ];
        let current = select_current_session(&sessions).unwrap().bus_name.clone();
        let debug = debug_entries_from_sessions(&sessions, Some(&current));
        assert_eq!(debug.len(), 2);
        assert!(debug.iter().any(|e| e.is_current && e.source_app.as_deref() == Some("Spotify")));
        assert!(debug.iter().any(|e| !e.is_current && e.source_app.as_deref() == Some("VLC")));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_mpris_tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::OnceLock;
    use zbus::zvariant::{OwnedValue, Value};

    fn ensure_session_bus() -> bool {
        static STARTED: OnceLock<bool> = OnceLock::new();
        *STARTED.get_or_init(|| {
            if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some() {
                return true;
            }
            let mut child = match Command::new("dbus-daemon")
                .args(["--session", "--print-address", "--nofork", "--nopidfile"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(_) => return false,
            };
            let mut addr = String::new();
            let Some(stdout) = child.stdout.take() else {
                return false;
            };
            if BufReader::new(stdout).read_line(&mut addr).is_err() || addr.trim().is_empty() {
                return false;
            }
            // Test process owns this daemon for the remainder of the run.
            unsafe { std::env::set_var("DBUS_SESSION_BUS_ADDRESS", addr.trim()) };
            std::mem::forget(child);
            true
        })
    }

    struct MockRoot;
    struct MockPlayer;

    #[zbus::interface(name = "org.mpris.MediaPlayer2")]
    impl MockRoot {
        #[zbus(property)]
        fn identity(&self) -> String {
            "GSV Mock".to_string()
        }

        #[zbus(property)]
        fn desktop_entry(&self) -> String {
            "gsv-mock".to_string()
        }
    }

    #[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
    impl MockPlayer {
        #[zbus(property)]
        fn playback_status(&self) -> String {
            "Playing".to_string()
        }

        #[zbus(property)]
        fn metadata(&self) -> HashMap<String, OwnedValue> {
            let mut map = HashMap::new();
            map.insert(
                "xesam:title".to_string(),
                Value::from("Karma Police").try_to_owned().expect("title"),
            );
            map.insert(
                "xesam:album".to_string(),
                Value::from("OK Computer").try_to_owned().expect("album"),
            );
            map.insert(
                "xesam:artist".to_string(),
                Value::from(vec!["Radiohead".to_string()])
                    .try_to_owned()
                    .expect("artist"),
            );
            map.insert(
                "mpris:length".to_string(),
                Value::from(240_000_000i64).try_to_owned().expect("length"),
            );
            map
        }

        #[zbus(property)]
        fn position(&self) -> i64 {
            12_000_000
        }
    }

    #[tokio::test]
    async fn reads_now_playing_metadata_from_mpris_player() {
        if !ensure_session_bus() {
            eprintln!("skipping: no session D-Bus available");
            return;
        }

        let _server = zbus::connection::Builder::session()
            .expect("session builder")
            .name("org.mpris.MediaPlayer2.gsvmock")
            .expect("well-known name")
            .serve_at("/org/mpris/MediaPlayer2", MockRoot)
            .expect("serve root")
            .serve_at("/org/mpris/MediaPlayer2", MockPlayer)
            .expect("serve player")
            .build()
            .await
            .expect("mock MPRIS player");

        let payload = linux::fetch_payload().await;
        assert_eq!(payload.playback_status, "playing");
        assert_eq!(payload.title.as_deref(), Some("Karma Police"));
        assert_eq!(payload.artist.as_deref(), Some("Radiohead"));
        assert_eq!(payload.album.as_deref(), Some("OK Computer"));
        assert_eq!(payload.source_app.as_deref(), Some("GSV Mock"));
        assert_eq!(payload.position_ms, Some(12_000));
        assert_eq!(payload.duration_ms, Some(240_000));

        let debug = linux::enumerate_sessions().await;
        assert!(
            debug.iter().any(|e| e.is_current && e.title.as_deref() == Some("Karma Police")),
            "expected mock player to be current, got {debug:?}"
        );
    }
}
