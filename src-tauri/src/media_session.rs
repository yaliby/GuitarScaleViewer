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
    pub track_url: Option<String>,
    pub artwork_url: Option<String>,
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
            track_url: None,
            artwork_url: None,
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
            track_url: None,
            artwork_url: None,
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
            track_url: session.track_url.clone(),
            artwork_url: session.artwork_url.clone(),
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
    track_url: Option<String>,
    artwork_url: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaybackAction {
    Pause,
    Play,
    Toggle,
}

fn parse_playback_action(raw: &str) -> Result<PlaybackAction, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "pause" => Ok(PlaybackAction::Pause),
        "play" => Ok(PlaybackAction::Play),
        "toggle" => Ok(PlaybackAction::Toggle),
        other => Err(format!("unknown media action '{other}'")),
    }
}

fn clamp_seek_ms(position_ms: i64, duration_ms: Option<u64>) -> u64 {
    let pos = position_ms.max(0) as u64;
    match duration_ms {
        Some(d) if d > 0 => pos.min(d),
        _ => pos,
    }
}

fn overlay_playback_action(
    mut payload: MediaSessionPayload,
    action: PlaybackAction,
) -> MediaSessionPayload {
    match action {
        PlaybackAction::Pause => payload.playback_status = "paused".to_string(),
        PlaybackAction::Play => payload.playback_status = "playing".to_string(),
        PlaybackAction::Toggle => {}
    }
    payload
}

fn overlay_seek_position(
    mut payload: MediaSessionPayload,
    position_ms: u64,
) -> MediaSessionPayload {
    payload.position_ms = Some(clamp_seek_ms(position_ms as i64, payload.duration_ms));
    payload
}

/// MPRIS `Seek` takes a signed microsecond offset. `i64::saturating_sub` keeps rewinds negative.
fn mpris_seek_offset_us(target_us: i64, current_us: i64) -> i64 {
    target_us.saturating_sub(current_us)
}

const MPRIS_POSITION_SLACK_US: u64 = 750_000;

fn mpris_position_reached(actual_us: i64, target_us: i64) -> bool {
    actual_us.abs_diff(target_us) <= MPRIS_POSITION_SLACK_US
}

/// Chromium/Brave `Seek` ignores the requested magnitude and only steps about ±5s.
/// Keep stepping while error shrinks; stop on a no-op or an overshoot.
fn should_repeat_mpris_seek(before_us: i64, after_us: i64, target_us: i64) -> bool {
    if after_us == before_us || mpris_position_reached(after_us, target_us) {
        return false;
    }
    after_us.abs_diff(target_us) < before_us.abs_diff(target_us)
}

/// Browsers often advertise `/` or `.../NoTrack`, which accept SetPosition and then do nothing.
fn track_id_allows_set_position(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    !lower.ends_with("/notrack") && !lower.contains("tracklist/notrack")
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn ms_to_mpris_us(ms: u64) -> i64 {
    i64::try_from(ms.saturating_mul(1_000)).unwrap_or(i64::MAX)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn ms_to_win_ticks(ms: u64) -> i64 {
    i64::try_from(ms.saturating_mul(10_000)).unwrap_or(i64::MAX)
}

async fn apply_playback_action(action: &str) -> Result<MediaSessionPayload, String> {
    #[cfg(windows)]
    {
        match tokio::time::timeout(Duration::from_secs(2), win::control_playback(action)).await {
            Ok(result) => result,
            Err(_) => Err("media control deadline exceeded".to_string()),
        }
    }
    #[cfg(target_os = "linux")]
    {
        linux::control_playback(action).await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = action;
        Err("media control is not available on this platform".to_string())
    }
}

async fn apply_seek(position_ms: u64) -> Result<MediaSessionPayload, String> {
    #[cfg(windows)]
    {
        match tokio::time::timeout(Duration::from_secs(2), win::seek_to(position_ms)).await {
            Ok(result) => result,
            Err(_) => Err("media seek deadline exceeded".to_string()),
        }
    }
    #[cfg(target_os = "linux")]
    {
        linux::seek_to(position_ms).await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = position_ms;
        Err("media seek is not available on this platform".to_string())
    }
}

fn emit_session(app: &AppHandle, payload: &MediaSessionPayload) {
    if let Err(e) = app.emit("media-session-update", payload) {
        log::warn!("media_session: emit failed: {e}");
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
    let identity = identity
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
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

fn is_internal_harness(session: &SessionCandidate) -> bool {
    session
        .source_app
        .as_deref()
        .is_some_and(|app| app.eq_ignore_ascii_case("GSV key engine harness"))
}

/// Pick the session that should be treated as “now playing”.
///
/// Skip `playerctld` (it multiplexes other players and its Position is often
/// stale) and the internal key-engine harness. Prefer Playing with a title,
/// then Playing, then Paused with a title, then any titled session.
fn select_current_session(sessions: &[SessionCandidate]) -> Option<&SessionCandidate> {
    if sessions.is_empty() {
        return None;
    }

    let usable = |s: &&SessionCandidate| !is_playerctld(&s.bus_name) && !is_internal_harness(s);
    sessions
        .iter()
        .filter(usable)
        .find(|s| s.playback_status == "playing" && s.title.is_some())
        .or_else(|| {
            sessions
                .iter()
                .filter(usable)
                .find(|s| s.playback_status == "playing")
        })
        .or_else(|| {
            sessions
                .iter()
                .filter(usable)
                .find(|s| s.playback_status == "paused" && s.title.is_some())
        })
        .or_else(|| sessions.iter().filter(usable).find(|s| s.title.is_some()))
        .or_else(|| sessions.iter().find(usable))
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

    fn playback_status_str(s: GlobalSystemMediaTransportControlsSessionPlaybackStatus) -> String {
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

    async fn current_session() -> Result<GlobalSystemMediaTransportControlsSession, String> {
        let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            Ok(op) => op
                .await
                .map_err(|e| format!("media session manager: {e}"))?,
            Err(e) => return Err(format!("media session manager: {e}")),
        };
        manager
            .GetCurrentSession()
            .map_err(|_| "no current media session".to_string())
    }

    pub async fn control_playback(action: &str) -> Result<MediaSessionPayload, String> {
        let parsed = super::parse_playback_action(action)?;
        let session = current_session().await?;
        let op = match parsed {
            super::PlaybackAction::Pause => session.TryPauseAsync(),
            super::PlaybackAction::Play => session.TryPlayAsync(),
            super::PlaybackAction::Toggle => session.TryTogglePlayPauseAsync(),
        };
        let mut accepted = op
            .map_err(|e| format!("media control: {e}"))?
            .await
            .map_err(|e| format!("media control: {e}"))?;
        if !accepted
            && matches!(
                parsed,
                super::PlaybackAction::Pause | super::PlaybackAction::Play
            )
        {
            accepted = session
                .TryTogglePlayPauseAsync()
                .map_err(|e| format!("media control: {e}"))?
                .await
                .map_err(|e| format!("media control: {e}"))?;
        }
        if !accepted {
            return Err("the player declined the playback request".to_string());
        }
        Ok(super::overlay_playback_action(
            fetch_payload().await,
            parsed,
        ))
    }

    pub async fn seek_to(position_ms: u64) -> Result<MediaSessionPayload, String> {
        let session = current_session().await?;
        let duration_ms =
            session
                .GetTimelineProperties()
                .ok()
                .and_then(|t| match (t.StartTime(), t.EndTime()) {
                    (Ok(start), Ok(end)) if end.Duration > start.Duration => {
                        Some(((end.Duration - start.Duration) as u64) / 10_000)
                    }
                    _ => None,
                });
        let clamped = super::clamp_seek_ms(position_ms as i64, duration_ms);
        let accepted = session
            .TryChangePlaybackPositionAsync(super::ms_to_win_ticks(clamped))
            .map_err(|e| format!("media seek: {e}"))?
            .await
            .map_err(|e| format!("media seek: {e}"))?;
        if !accepted {
            return Err("the player declined the seek request".to_string());
        }
        Ok(super::overlay_seek_position(fetch_payload().await, clamped))
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

        let session: GlobalSystemMediaTransportControlsSession = match manager.GetCurrentSession() {
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
            track_url: None,
            artwork_url: None,
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
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use zbus::zvariant::OwnedValue;
    use zbus::Connection;

    const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
    const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
    const STICKY_CONTROL_FOR: Duration = Duration::from_secs(12);

    static CONNECTION: tokio::sync::OnceCell<Connection> = tokio::sync::OnceCell::const_new();
    static LAST_CONTROLLED: Mutex<Option<(String, Instant)>> = Mutex::new(None);

    fn remember_controlled(bus_name: &str) {
        if let Ok(mut guard) = LAST_CONTROLLED.lock() {
            *guard = Some((bus_name.to_string(), Instant::now()));
        }
    }

    fn sticky_bus_name() -> Option<String> {
        let guard = LAST_CONTROLLED.lock().ok()?;
        let (bus, at) = guard.as_ref()?;
        if at.elapsed() <= STICKY_CONTROL_FOR {
            Some(bus.clone())
        } else {
            None
        }
    }

    #[zbus::proxy(
        interface = "org.mpris.MediaPlayer2.Player",
        default_path = "/org/mpris/MediaPlayer2"
    )]
    trait MprisPlayer {
        fn pause(&self) -> zbus::Result<()>;
        fn play(&self) -> zbus::Result<()>;
        fn play_pause(&self) -> zbus::Result<()>;
        fn seek(&self, offset: i64) -> zbus::Result<()>;
        fn set_position(
            &self,
            track_id: zbus::zvariant::ObjectPath<'_>,
            position: i64,
        ) -> zbus::Result<()>;

        #[zbus(property)]
        fn playback_status(&self) -> zbus::Result<String>;

        #[zbus(property)]
        fn metadata(&self) -> zbus::Result<HashMap<String, OwnedValue>>;

        /// MPRIS does not require Position to emit PropertiesChanged. If we cache it, SetPosition
        /// looks like a no-op and Chromium's ±5s Seek then overshoots.
        #[zbus(property(emits_changed_signal = "false"))]
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
            .or_else(|| {
                u64::try_from(value.clone())
                    .ok()
                    .and_then(|n| i64::try_from(n).ok())
            })
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

    fn metadata_track_id(
        map: &HashMap<String, OwnedValue>,
    ) -> Option<zbus::zvariant::OwnedObjectPath> {
        let value = map.get("mpris:trackid")?;
        zbus::zvariant::OwnedObjectPath::try_from(value.clone())
            .ok()
            .or_else(|| {
                String::try_from(value.clone())
                    .ok()
                    .and_then(|s| zbus::zvariant::OwnedObjectPath::try_from(s).ok())
            })
    }

    /// MPRIS Position is not required to emit PropertiesChanged. zbus's property
    /// cache then freezes the clock and makes SetPosition look like a no-op.
    async fn fresh_position_us(conn: &Connection, bus_name: &str) -> Option<i64> {
        let destination = zbus::names::BusName::try_from(bus_name.to_string()).ok()?;
        let props = zbus::fdo::PropertiesProxy::builder(conn)
            .destination(destination)
            .ok()?
            .path(MPRIS_PATH)
            .ok()?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .ok()?;
        let interface =
            zbus::names::InterfaceName::try_from("org.mpris.MediaPlayer2.Player").ok()?;
        let value = props.get(interface, "Position").await.ok()?;
        owned_i64(&value)
    }

    async fn player_proxy<'a>(
        conn: &'a Connection,
        bus_name: &str,
    ) -> Result<MprisPlayerProxy<'a>, String> {
        let destination = zbus::names::OwnedBusName::try_from(bus_name.to_string())
            .map_err(|e| format!("bad MPRIS bus name: {e}"))?;
        MprisPlayerProxy::builder(conn)
            .destination(destination)
            .map_err(|e| format!("MPRIS destination: {e}"))?
            .path(MPRIS_PATH)
            .map_err(|e| format!("MPRIS path: {e}"))?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .map_err(|e| format!("MPRIS proxy: {e}"))
    }

    async fn current_bus_name(conn: &Connection) -> Result<String, String> {
        let sessions = load_sessions(conn).await;
        pick_session(&sessions)
            .map(|s| s.bus_name.clone())
            .ok_or_else(|| "no current media session".to_string())
    }

    async fn payload_for_bus(conn: &Connection, bus_name: &str) -> MediaSessionPayload {
        match read_player(conn, bus_name).await {
            Some(session) => MediaSessionPayload::from(&session),
            None => MediaSessionPayload::empty_session(),
        }
    }

    pub async fn control_named_player(
        bus_name: &str,
        action: super::PlaybackAction,
    ) -> Result<(), String> {
        let conn = session_connection()
            .await
            .map_err(|e| format!("D-Bus session unavailable: {e}"))?;
        let player = player_proxy(&conn, bus_name).await?;
        let result = match action {
            super::PlaybackAction::Pause => match player.pause().await {
                Ok(()) => Ok(()),
                Err(e) => {
                    log::debug!("media_session: Pause failed, trying PlayPause: {e}");
                    player.play_pause().await
                }
            },
            super::PlaybackAction::Play => match player.play().await {
                Ok(()) => Ok(()),
                Err(e) => {
                    log::debug!("media_session: Play failed, trying PlayPause: {e}");
                    player.play_pause().await
                }
            },
            super::PlaybackAction::Toggle => player.play_pause().await,
        };
        result.map_err(|e| format!("MPRIS {action:?} failed: {e}"))
    }

    pub async fn seek_named_player(bus_name: &str, position_ms: u64) -> Result<(), String> {
        let conn = session_connection()
            .await
            .map_err(|e| format!("D-Bus session unavailable: {e}"))?;
        let player = player_proxy(&conn, bus_name).await?;
        let metadata = player.metadata().await.unwrap_or_default();
        let target_ms = super::clamp_seek_ms(position_ms as i64, metadata_duration_ms(&metadata));
        let target_us = super::ms_to_mpris_us(target_ms);
        if let Some(track_id) = metadata_track_id(&metadata) {
            if super::track_id_allows_set_position(track_id.as_str()) {
                match player.set_position(track_id.as_ref(), target_us).await {
                    Ok(()) => return Ok(()),
                    Err(e) => log::debug!("media_session: SetPosition failed, trying Seek: {e}"),
                }
            }
        }
        // Chromium/Brave Seek ignores the offset size and only steps about ±5s.
        const MAX_SEEK_STEPS: u32 = 16;
        for _ in 0..MAX_SEEK_STEPS {
            let current_us = fresh_position_us(&conn, bus_name).await.unwrap_or(0);
            if super::mpris_position_reached(current_us, target_us) {
                return Ok(());
            }
            let offset = super::mpris_seek_offset_us(target_us, current_us);
            if offset == 0 {
                return Ok(());
            }
            player
                .seek(offset)
                .await
                .map_err(|e| format!("MPRIS Seek failed: {e}"))?;
            let next_us = fresh_position_us(&conn, bus_name)
                .await
                .unwrap_or(current_us);
            if !super::should_repeat_mpris_seek(current_us, next_us, target_us) {
                break;
            }
        }
        Ok(())
    }

    pub async fn control_playback(action: &str) -> Result<MediaSessionPayload, String> {
        let parsed = super::parse_playback_action(action)?;
        let conn = session_connection()
            .await
            .map_err(|e| format!("D-Bus session unavailable: {e}"))?;
        let bus_name = current_bus_name(&conn).await?;
        control_named_player(&bus_name, parsed).await?;
        remember_controlled(&bus_name);
        // Stay on the player we just controlled so a still-playing browser tab
        // does not steal the snapshot and make Pause look like a no-op.
        Ok(super::overlay_playback_action(
            payload_for_bus(&conn, &bus_name).await,
            parsed,
        ))
    }

    pub async fn seek_to(position_ms: u64) -> Result<MediaSessionPayload, String> {
        let conn = session_connection()
            .await
            .map_err(|e| format!("D-Bus session unavailable: {e}"))?;
        let bus_name = current_bus_name(&conn).await?;
        seek_named_player(&bus_name, position_ms).await?;
        remember_controlled(&bus_name);
        Ok(super::overlay_seek_position(
            payload_for_bus(&conn, &bus_name).await,
            position_ms,
        ))
    }

    async fn read_player(conn: &Connection, bus_name: &str) -> Option<SessionCandidate> {
        let destination = zbus::names::BusName::try_from(bus_name).ok()?;
        let player = MprisPlayerProxy::builder(conn)
            .destination(destination.clone())
            .ok()?
            .path(MPRIS_PATH)
            .ok()?
            .cache_properties(zbus::proxy::CacheProperties::No)
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
        let position_ms = fresh_position_us(conn, bus_name)
            .await
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
            track_url: metadata_string(&metadata, "xesam:url"),
            artwork_url: metadata_string(&metadata, "mpris:artUrl"),
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

    fn pick_session<'a>(sessions: &'a [SessionCandidate]) -> Option<&'a SessionCandidate> {
        if let Some(bus) = sticky_bus_name() {
            if let Some(current) = sessions.iter().find(|s| s.bus_name == bus) {
                return Some(current);
            }
        }
        select_current_session(sessions)
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
        match pick_session(&sessions) {
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
        let current_bus = pick_session(&sessions).map(|s| s.bus_name.as_str());
        debug_entries_from_sessions(&sessions, current_bus)
    }
}

/// Snapshot for `#[tauri::command]` and poller.
pub async fn get_current_media_payload() -> MediaSessionPayload {
    #[cfg(windows)]
    {
        media_with_deadline(win::fetch_payload(), Duration::from_secs(2)).await
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
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        struct Cancelled(Arc<AtomicBool>);
        impl Drop for Cancelled {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
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
        let result = media_with_deadline(
            std::future::ready(expected.clone()),
            Duration::from_millis(20),
        )
        .await;
        assert_eq!(result, expected);
    }
}

#[tauri::command]
pub async fn get_current_media() -> MediaSessionPayload {
    get_current_media_payload().await
}

#[tauri::command]
pub async fn control_media_playback(
    app: AppHandle,
    action: String,
) -> Result<MediaSessionPayload, String> {
    let payload = apply_playback_action(&action).await?;
    log::info!(
        "media_session: control action={action} status={} title={:?}",
        payload.playback_status,
        payload.title
    );
    emit_session(&app, &payload);
    Ok(payload)
}

#[tauri::command]
pub async fn seek_media(app: AppHandle, position_ms: u64) -> Result<MediaSessionPayload, String> {
    let payload = apply_seek(position_ms).await?;
    log::info!(
        "media_session: seek requested_ms={position_ms} status={} position_ms={:?}",
        payload.playback_status,
        payload.position_ms
    );
    emit_session(&app, &payload);
    Ok(payload)
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

#[cfg(any(windows, target_os = "linux"))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionIdentity {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    source_app: Option<String>,
    playback_status: String,
}

#[cfg(any(windows, target_os = "linux"))]
impl From<&MediaSessionPayload> for SessionIdentity {
    fn from(payload: &MediaSessionPayload) -> Self {
        Self {
            title: payload.title.clone(),
            artist: payload.artist.clone(),
            album: payload.album.clone(),
            source_app: payload.source_app.clone(),
            playback_status: payload.playback_status.clone(),
        }
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

                log::info!("media_session: poller started interval_ms=1500");
                let mut last: Option<MediaSessionPayload> = None;
                let mut last_identity: Option<SessionIdentity> = None;
                loop {
                    let next = rt.block_on(get_current_media_payload());
                    let identity = SessionIdentity::from(&next);
                    if last_identity.as_ref() != Some(&identity) {
                        log::info!(
                            "media_session: session changed app={:?} status={} title={:?} artist={:?} album={:?} duration_ms={:?}",
                            next.source_app,
                            next.playback_status,
                            next.title,
                            next.artist,
                            next.album,
                            next.duration_ms
                        );
                        last_identity = Some(identity);
                    }
                    if last.as_ref() != Some(&next) {
                        last = Some(next.clone());
                        emit_session(&app, &next);
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
            track_url: None,
            artwork_url: None,
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
    fn parse_playback_action_accepts_play_pause_toggle() {
        assert_eq!(
            parse_playback_action("Pause").unwrap(),
            PlaybackAction::Pause
        );
        assert_eq!(parse_playback_action("PLAY").unwrap(), PlaybackAction::Play);
        assert_eq!(
            parse_playback_action("toggle").unwrap(),
            PlaybackAction::Toggle
        );
        assert!(parse_playback_action("rewind").is_err());
    }

    #[test]
    fn clamp_seek_ms_stays_inside_the_track() {
        assert_eq!(clamp_seek_ms(-400, Some(180_000)), 0);
        assert_eq!(clamp_seek_ms(200_000, Some(180_000)), 180_000);
        assert_eq!(clamp_seek_ms(12_000, None), 12_000);
        assert_eq!(ms_to_mpris_us(1_250), 1_250_000);
        assert_eq!(ms_to_win_ticks(1_250), 12_500_000);
    }

    #[test]
    fn mpris_seek_offset_rewinds_with_a_negative_delta() {
        assert_eq!(mpris_seek_offset_us(45_000_000, 12_000_000), 33_000_000);
        assert_eq!(mpris_seek_offset_us(5_000_000, 12_000_000), -7_000_000);
    }

    #[test]
    fn chromium_seek_steps_are_repeated_only_while_error_shrinks() {
        let target = 45_000_000;
        assert!(should_repeat_mpris_seek(12_000_000, 17_000_000, target));
        assert!(!should_repeat_mpris_seek(12_000_000, 12_000_000, target));
        assert!(!should_repeat_mpris_seek(44_800_000, 45_100_000, target));
        assert!(!should_repeat_mpris_seek(48_000_000, 53_000_000, target));
        assert!(mpris_position_reached(45_200_000, target));
        assert!(!mpris_position_reached(40_000_000, target));
    }

    #[test]
    fn dummy_mpris_track_ids_skip_set_position() {
        assert!(!track_id_allows_set_position("/"));
        assert!(!track_id_allows_set_position(
            "/org/mpris/MediaPlayer2/TrackList/NoTrack"
        ));
        assert!(track_id_allows_set_position(
            "/org/mpris/MediaPlayer2/Track/1"
        ));
    }

    #[test]
    fn overlay_pause_keeps_the_controlled_track_paused() {
        let mut playing = MediaSessionPayload::empty_session();
        playing.title = Some("Karma Police".into());
        playing.playback_status = "playing".into();
        let paused = overlay_playback_action(playing, PlaybackAction::Pause);
        assert_eq!(paused.playback_status, "paused");
        assert_eq!(paused.title.as_deref(), Some("Karma Police"));
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
    fn select_current_skips_playerctld_for_the_real_player() {
        let sessions = vec![
            candidate(
                "org.mpris.MediaPlayer2.playerctld",
                "playing",
                Some("Hotel California"),
                Some("Brave"),
            ),
            candidate(
                "org.mpris.MediaPlayer2.brave.instance5005",
                "paused",
                Some("Hotel California"),
                Some("Brave"),
            ),
        ];
        let current = select_current_session(&sessions).unwrap();
        assert_eq!(
            current.bus_name,
            "org.mpris.MediaPlayer2.brave.instance5005"
        );
        assert!(!is_playerctld(&current.bus_name));
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
    fn select_current_skips_the_internal_key_engine_harness() {
        let sessions = vec![
            candidate(
                "org.mpris.MediaPlayer2.gsvharness",
                "playing",
                Some("A minor cadence"),
                Some("GSV key engine harness"),
            ),
            candidate(
                "org.mpris.MediaPlayer2.brave.instance5005",
                "paused",
                Some("Hotel California"),
                Some("Brave"),
            ),
        ];
        let current = select_current_session(&sessions).unwrap();
        assert_eq!(current.source_app.as_deref(), Some("Brave"));
        assert_eq!(current.title.as_deref(), Some("Hotel California"));
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
        assert!(debug
            .iter()
            .any(|e| e.is_current && e.source_app.as_deref() == Some("Spotify")));
        assert!(debug
            .iter()
            .any(|e| !e.is_current && e.source_app.as_deref() == Some("VLC")));
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

    /// Always a **private** bus, never the developer's.
    ///
    /// This used to reuse `DBUS_SESSION_BUS_ADDRESS` when one was already set, which put the mock
    /// player on the real desktop session alongside Spotify, Brave and anything else running. The
    /// assertions then depended on whether the developer happened to be listening to music: the
    /// test passed with a paused browser and failed the moment that browser started playing,
    /// reporting the real track's title instead of "Karma Police". A test whose result is decided
    /// by what is in someone's headphones is not a test.
    fn ensure_session_bus() -> bool {
        static STARTED: OnceLock<bool> = OnceLock::new();
        *STARTED.get_or_init(|| {
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

    struct MockCtlState {
        paused: bool,
        position_us: i64,
        seek_offsets: Vec<i64>,
        set_positions: Vec<i64>,
    }

    struct MockCtlRoot;
    struct MockCtlPlayer {
        state: std::sync::Arc<std::sync::Mutex<MockCtlState>>,
    }

    #[zbus::interface(name = "org.mpris.MediaPlayer2")]
    impl MockCtlRoot {
        #[zbus(property)]
        fn identity(&self) -> String {
            "GSV Control".to_string()
        }

        #[zbus(property)]
        fn desktop_entry(&self) -> String {
            "gsv-control".to_string()
        }
    }

    #[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
    impl MockCtlPlayer {
        fn pause(&self) {
            self.state.lock().expect("ctl state").paused = true;
        }

        fn play(&self) {
            self.state.lock().expect("ctl state").paused = false;
        }

        fn play_pause(&self) {
            let mut state = self.state.lock().expect("ctl state");
            state.paused = !state.paused;
        }

        fn seek(&self, offset: i64) {
            let mut state = self.state.lock().expect("ctl state");
            state.seek_offsets.push(offset);
            state.position_us = (state.position_us + offset).max(0);
        }

        fn set_position(&self, _track_id: zbus::zvariant::ObjectPath<'_>, position: i64) {
            let mut state = self.state.lock().expect("ctl state");
            state.set_positions.push(position);
            state.position_us = position.max(0);
        }

        #[zbus(property)]
        fn playback_status(&self) -> String {
            if self.state.lock().expect("ctl state").paused {
                "Paused".to_string()
            } else {
                "Playing".to_string()
            }
        }

        #[zbus(property)]
        fn metadata(&self) -> HashMap<String, OwnedValue> {
            let mut map = HashMap::new();
            map.insert(
                "xesam:title".to_string(),
                Value::from("Control Track").try_to_owned().expect("title"),
            );
            map.insert(
                "mpris:length".to_string(),
                Value::from(240_000_000i64).try_to_owned().expect("length"),
            );
            map.insert(
                "mpris:trackid".to_string(),
                Value::from(
                    zbus::zvariant::ObjectPath::try_from("/org/mpris/MediaPlayer2/Track/1")
                        .expect("track path"),
                )
                .try_to_owned()
                .expect("trackid"),
            );
            map
        }

        #[zbus(property)]
        fn position(&self) -> i64 {
            self.state.lock().expect("ctl state").position_us
        }
    }

    #[tokio::test]
    async fn mpris_pause_and_seek_control_the_named_player() {
        if !ensure_session_bus() {
            eprintln!("skipping: no session D-Bus available");
            return;
        }

        let state = std::sync::Arc::new(std::sync::Mutex::new(MockCtlState {
            paused: false,
            position_us: 12_000_000,
            seek_offsets: Vec::new(),
            set_positions: Vec::new(),
        }));
        let _server = zbus::connection::Builder::session()
            .expect("session builder")
            .name("org.mpris.MediaPlayer2.gsvctl")
            .expect("well-known name")
            .serve_at("/org/mpris/MediaPlayer2", MockCtlRoot)
            .expect("serve root")
            .serve_at(
                "/org/mpris/MediaPlayer2",
                MockCtlPlayer {
                    state: state.clone(),
                },
            )
            .expect("serve player")
            .build()
            .await
            .expect("mock MPRIS control player");

        linux::control_named_player("org.mpris.MediaPlayer2.gsvctl", PlaybackAction::Pause)
            .await
            .expect("pause");
        assert!(state.lock().expect("ctl state").paused);

        linux::seek_named_player("org.mpris.MediaPlayer2.gsvctl", 45_000)
            .await
            .expect("seek");
        let snapshot = state.lock().expect("ctl state");
        assert_eq!(snapshot.position_us, 45_000_000);
        assert_eq!(snapshot.set_positions, vec![45_000_000]);
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
            debug
                .iter()
                .any(|e| e.is_current && e.title.as_deref() == Some("Karma Police")),
            "expected mock player to be current, got {debug:?}"
        );
    }
}

/// Hits the developer's real session bus. Off unless `GSV_LIVE_MPRIS=1`.
#[cfg(all(test, target_os = "linux"))]
mod live_mpris_tests {
    use super::*;

    fn live_enabled() -> bool {
        std::env::var("GSV_LIVE_MPRIS").ok().as_deref() == Some("1")
    }

    #[tokio::test]
    async fn current_player_seeks_forward_back_and_pauses() {
        if !live_enabled() {
            eprintln!("skipping: set GSV_LIVE_MPRIS=1 to probe the real player");
            return;
        }

        let before = linux::fetch_payload().await;
        assert_eq!(
            before.source_app.as_deref(),
            Some("Brave"),
            "expected Brave as the current session, got {before:?}"
        );
        let origin = before.position_ms.unwrap_or(0);
        let forward = origin.saturating_add(20_000);
        linux::seek_to(forward).await.expect("seek forward");
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let after_fwd = linux::fetch_payload().await;
        let fwd_pos = after_fwd.position_ms.unwrap_or(0);
        assert!(
            fwd_pos.abs_diff(forward) < 2_000,
            "forward landed at {fwd_pos}, wanted {forward}"
        );

        let back = origin.saturating_sub(8_000);
        linux::seek_to(back).await.expect("seek back");
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let after_back = linux::fetch_payload().await;
        let back_pos = after_back.position_ms.unwrap_or(0);
        assert!(
            back_pos.abs_diff(back) < 2_000,
            "rewind landed at {back_pos}, wanted {back}"
        );

        linux::control_playback("play").await.expect("play");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let playing = linux::fetch_payload().await;
        assert_eq!(playing.playback_status, "playing");

        linux::control_playback("pause").await.expect("pause");
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let paused = linux::fetch_payload().await;
        assert_eq!(paused.playback_status, "paused");

        linux::seek_to(origin).await.expect("restore");
    }
}
