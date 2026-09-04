use crate::audio_models::CaptureMode;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[cfg(any(windows, target_os = "linux"))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(windows, target_os = "linux"))]
use std::sync::mpsc::{Receiver, TryRecvError};
#[cfg(any(windows, target_os = "linux"))]
use std::sync::Arc;
#[cfg(any(windows, target_os = "linux"))]
use std::thread::JoinHandle;

const ANALYZER_SAMPLE_RATE_HZ: u32 = 44_100;
const ROLLING_BUFFER_SECONDS: usize = 60;
#[cfg_attr(not(windows), allow(dead_code))]
const PROCESS_FALLBACK_FAILURE_THRESHOLD: u32 = 3;
const ENDPOINT_UNAVAILABLE_FAILURE_THRESHOLD: u32 = 3;
#[cfg_attr(not(windows), allow(dead_code))]
const PROCESS_REACQUIRE_COOLDOWN: Duration = Duration::from_secs(20);
const DISCONNECT_GRACE_PERIOD: Duration = Duration::from_millis(2500);
const RECENT_SILENCE_BLOCK_WINDOW: Duration = Duration::from_secs(14);

#[derive(Debug, Clone, PartialEq)]
pub struct CaptureSnapshot {
    pub requested_mode: CaptureMode,
    pub capture_mode: CaptureMode,
    pub mode_reason: Option<String>,
    pub target_app: Option<String>,
    pub buffer_seconds: f32,
    pub has_live_capture: bool,
    pub recent_silence: bool,
}

#[cfg(any(windows, target_os = "linux"))]
const CAPTURE_CHANNEL_CAPACITY: usize = 256;

#[cfg(any(windows, target_os = "linux"))]
#[derive(Debug)]
struct CapturePacket {
    sample_rate_hz: u32,
    mono_samples: Vec<f32>,
}

#[cfg(any(windows, target_os = "linux"))]
struct CaptureWorkerHandle {
    stop: Arc<AtomicBool>,
    #[allow(dead_code)]
    join: JoinHandle<()>,
}

#[cfg(any(windows, target_os = "linux"))]
impl CaptureWorkerHandle {
    fn request_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn drain_capture_channel(
    receiver: &Receiver<CapturePacket>,
    mut on_packet: impl FnMut(CapturePacket),
) -> (bool, bool) {
    let mut received_any = false;
    let mut disconnected = false;
    loop {
        match receiver.try_recv() {
            Ok(packet) => {
                received_any = true;
                on_packet(packet);
            }
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                disconnected = true;
                break;
            }
        }
    }
    (received_any, disconnected)
}

fn native_loopback_supported() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

#[cfg(windows)]
mod win {
    use std::collections::VecDeque;
    use std::ffi::OsStr;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver, SyncSender};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use super::{CapturePacket, CaptureWorkerHandle, CAPTURE_CHANNEL_CAPACITY};

    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    use wasapi::{
        initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, SessionState, StreamMode,
        WaveFormat,
    };

    const CAPTURE_CHUNK_FRAMES: usize = 4096;
    /// Default when mix format cannot be read (e.g. process loopback).
    const CAPTURE_SAMPLE_RATE_HZ: usize = 48_000;
    const CAPTURE_CHANNELS: usize = 2;

    /// Decode one WASAPI packet using the **actual** stream format (channels / PCM vs float / bit depth).
    fn decode_frames_to_mono(bytes: &[u8], wf: &WaveFormat) -> Vec<f32> {
        let channels = wf.get_nchannels() as usize;
        let frame_bytes = wf.get_blockalign() as usize;
        if channels == 0 || frame_bytes == 0 || bytes.len() < frame_bytes {
            return Vec::new();
        }
        if frame_bytes % channels != 0 {
            log::warn!(
                "audio_capture: odd blockalign={frame_bytes} channels={channels}; decode may be wrong"
            );
        }
        let bytes_per_sample = frame_bytes / channels;
        let sample_kind = wf.get_subformat().unwrap_or(SampleType::Float);
        let mut out = Vec::with_capacity(bytes.len() / frame_bytes);
        for frame in bytes.chunks_exact(frame_bytes) {
            let mut sum = 0.0f32;
            for c in 0..channels {
                let base = c * bytes_per_sample;
                if base + bytes_per_sample > frame.len() {
                    break;
                }
                let s = match (sample_kind, bytes_per_sample) {
                    (SampleType::Float, 4) => {
                        let v = f32::from_le_bytes([
                            frame[base],
                            frame[base + 1],
                            frame[base + 2],
                            frame[base + 3],
                        ]);
                        if v.is_finite() { v } else { 0.0 }
                    }
                    (SampleType::Int, 2) => {
                        i16::from_le_bytes([frame[base], frame[base + 1]]) as f32 / 32768.0
                    }
                    (SampleType::Int, 3) => {
                        let b0 = frame[base] as i32;
                        let b1 = frame[base + 1] as i32;
                        let b2 = frame[base + 2] as i32;
                        let v = b0 | (b1 << 8) | (b2 << 16);
                        let sign_extended = (v << 8) >> 8;
                        sign_extended as f32 / 8388608.0
                    }
                    (SampleType::Int, 4) => {
                        let v = i32::from_le_bytes([
                            frame[base],
                            frame[base + 1],
                            frame[base + 2],
                            frame[base + 3],
                        ]);
                        v as f32 / 2147483648.0
                    }
                    _ => {
                        // Unknown packing — try float32 if frame fits, else zero.
                        if bytes_per_sample >= 4 {
                            let v = f32::from_le_bytes([
                                frame[base],
                                frame[base + 1],
                                frame[base + 2],
                                frame[base + 3],
                            ]);
                            if v.is_finite() { v } else { 0.0 }
                        } else {
                            0.0
                        }
                    }
                };
                sum += s;
            }
            out.push((sum / channels as f32).clamp(-1.0, 1.0));
        }
        out
    }

    fn default_stream_wave_format() -> WaveFormat {
        WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            CAPTURE_SAMPLE_RATE_HZ,
            CAPTURE_CHANNELS,
            None,
        )
    }

    fn stream_wave_format_for_source(
        audio_client: &AudioClient,
        source: &CaptureSource,
    ) -> WaveFormat {
        match source {
            CaptureSource::EndpointLoopback => match audio_client.get_mixformat() {
                Ok(mix) => {
                    log::info!("audio_capture: endpoint loopback mix format: {:?}", mix);
                    mix
                }
                Err(e) => {
                    log::warn!(
                        "audio_capture: get_mixformat failed ({e}); using default float 48k stereo"
                    );
                    default_stream_wave_format()
                }
            },
            CaptureSource::ProcessLoopback { .. } => {
                // Process loopback: GetMixFormat is not implemented — request float stereo + autoconvert.
                default_stream_wave_format()
            }
        }
    }

    fn find_process_id_by_exe(exe_name: &str) -> Option<u32> {
        let refreshes = RefreshKind::nothing().with_processes(ProcessRefreshKind::everything());
        let system = System::new_with_specifics(refreshes);
        let process_ids = system.processes_by_name(OsStr::new(exe_name));
        let mut found: Option<u32> = None;
        for process in process_ids {
            // Process loopback must target the actual audio-producing process PID, not its parent.
            found = Some(process.pid().as_u32());
            if found.is_some() {
                break;
            }
        }
        found
    }

    fn process_basename_from_pid(pid: u32) -> Option<String> {
        let refreshes = RefreshKind::nothing().with_processes(ProcessRefreshKind::everything());
        let system = System::new_with_specifics(refreshes);
        system.process(sysinfo::Pid::from_u32(pid)).map(|process| {
            let name = process.name().to_string_lossy().to_string();
            let path = Path::new(&name);
            path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or(name)
        })
    }

    fn list_active_render_session_pids() -> Vec<u32> {
        let enumerator = match DeviceEnumerator::new() {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        let render = match enumerator.get_default_device(&Direction::Render) {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let manager = match render.get_iaudiosessionmanager() {
            Ok(m) => m,
            Err(_) => return Vec::new(),
        };
        let sessions = match manager.get_audiosessionenumerator() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let count = match sessions.get_count() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        let mut pids = Vec::new();
        for idx in 0..count {
            let control = match sessions.get_session(idx) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if control.get_state().ok() != Some(SessionState::Active) {
                continue;
            }
            if let Ok(pid) = control.get_process_id() {
                if pid > 0 {
                    pids.push(pid);
                }
            }
        }
        pids.sort_unstable();
        pids.dedup();
        pids
    }

    fn guess_exe_from_friendly_name(source_app: &str) -> Option<String> {
        let lower = source_app.to_ascii_lowercase();
        // SMTC often reports a display name ("Brave", "Google Chrome") without ".exe".
        if lower.contains("brave") {
            return Some("brave.exe".to_string());
        }
        if lower.contains("chrome") && !lower.contains("brave") {
            return Some("chrome.exe".to_string());
        }
        if lower.contains("msedge") || lower.contains("edge") {
            return Some("msedge.exe".to_string());
        }
        if lower.contains("firefox") {
            return Some("firefox.exe".to_string());
        }
        if lower.contains("spotify") {
            return Some("Spotify.exe".to_string());
        }
        if lower.contains("vlc") {
            return Some("vlc.exe".to_string());
        }
        None
    }

    fn resolve_pid_for_source_app(source_app: &str) -> Option<u32> {
        if let Some(exe) = likely_exe_name(source_app).or_else(|| guess_exe_from_friendly_name(source_app)) {
            if let Some(pid) = find_process_id_by_exe(&exe) {
                return Some(pid);
            }
        }

        let source_l = source_app.to_ascii_lowercase();
        for pid in list_active_render_session_pids() {
            if let Some(exe) = process_basename_from_pid(pid) {
                let exe_l = exe.to_ascii_lowercase();
                if source_l.contains(&exe_l) || exe_l.contains(&source_l) {
                    return Some(pid);
                }
            }
        }
        list_active_render_session_pids().into_iter().next()
    }

    fn likely_exe_name(source_app: &str) -> Option<String> {
        // SMTC source app can be an AUMID ("Foo!Bar") or an executable name.
        // We only attempt process loopback if we can extract "*.exe".
        let lowered = source_app.to_ascii_lowercase();
        if lowered.ends_with(".exe") {
            let exe = source_app.rsplit(['\\', '/']).next().unwrap_or(source_app);
            return Some(exe.to_string());
        }
        for token in source_app.split(['\\', '/', '!', ' ']) {
            if token.to_ascii_lowercase().ends_with(".exe") {
                return Some(token.to_string());
            }
        }
        None
    }

    fn run_capture_loop(
        mut audio_client: AudioClient,
        tx: SyncSender<CapturePacket>,
        stop: Arc<AtomicBool>,
        source: CaptureSource,
    ) -> Result<(), String> {
        let use_packet_size_gate = matches!(source, CaptureSource::ProcessLoopback { .. });
        let init_wave = stream_wave_format_for_source(&audio_client, &source);
        let blockalign = init_wave.get_blockalign();
        let capture_rate_hz = init_wave.get_samplespersec();
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 0,
        };
        audio_client
            .initialize_client(&init_wave, &Direction::Capture, &mode)
            .map_err(|e| format!("initialize_client: {e}"))?;
        let h_event = audio_client
            .set_get_eventhandle()
            .map_err(|e| format!("set_get_eventhandle: {e}"))?;
        let capture_client = audio_client
            .get_audiocaptureclient()
            .map_err(|e| format!("get_audiocaptureclient: {e}"))?;
        let mut sample_queue: VecDeque<u8> = VecDeque::new();
        audio_client
            .start_stream()
            .map_err(|e| format!("start_stream: {e}"))?;

        while !stop.load(Ordering::Relaxed) {
            if use_packet_size_gate {
                // Process loopback mode behaves better with explicit packet sizing.
                let new_frames = capture_client
                    .get_next_packet_size()
                    .map_err(|e| format!("get_next_packet_size: {e}"))?
                    .unwrap_or(0);
                if new_frames > 0 {
                    let additional = (new_frames as usize * blockalign as usize)
                        .saturating_sub(sample_queue.capacity() - sample_queue.len());
                    sample_queue.reserve(additional);
                    capture_client
                        .read_from_device_to_deque(&mut sample_queue)
                        .map_err(|e| format!("read_from_device_to_deque: {e}"))?;
                }
            } else {
                // Endpoint loopback: read continuously (crate example loopback.rs).
                capture_client
                    .read_from_device_to_deque(&mut sample_queue)
                    .map_err(|e| format!("read_from_device_to_deque: {e}"))?;
            }

            while sample_queue.len() >= blockalign as usize * CAPTURE_CHUNK_FRAMES {
                let mut chunk = vec![0u8; blockalign as usize * CAPTURE_CHUNK_FRAMES];
                for b in &mut chunk {
                    *b = sample_queue.pop_front().unwrap_or(0);
                }
                let mono = decode_frames_to_mono(&chunk, &init_wave);
                if !mono.is_empty() {
                    if tx
                        .send(CapturePacket {
                            sample_rate_hz: capture_rate_hz,
                            mono_samples: mono,
                        })
                        .is_err()
                    {
                        let _ = audio_client.stop_stream();
                        return Ok(());
                    }
                }
            }

            if h_event.wait_for_event(1000).is_err() {
                // keep trying unless stop is requested
                thread::sleep(Duration::from_millis(10));
            }
        }

        let _ = audio_client.stop_stream();
        Ok(())
    }

    enum CaptureSource {
        EndpointLoopback,
        ProcessLoopback { pid: u32 },
    }

    fn create_audio_client(source: &CaptureSource) -> Result<AudioClient, String> {
        match source {
            CaptureSource::EndpointLoopback => {
                let enumerator =
                    DeviceEnumerator::new().map_err(|e| format!("create device enumerator: {e}"))?;
                let render_device = enumerator
                    .get_default_device(&Direction::Render)
                    .map_err(|e| format!("default render device: {e}"))?;
                render_device
                    .get_iaudioclient()
                    .map_err(|e| format!("render get_iaudioclient: {e}"))
            }
            CaptureSource::ProcessLoopback { pid } => AudioClient::new_application_loopback_client(
                *pid,
                true,
            )
            .map_err(|e| format!("new_application_loopback_client pid={pid}: {e}")),
        }
    }

    fn spawn_worker(source: CaptureSource) -> Result<(CaptureWorkerHandle, Receiver<CapturePacket>), String> {
        let (tx, rx) = mpsc::sync_channel::<CapturePacket>(CAPTURE_CHANNEL_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let join = thread::Builder::new()
            .name("audio-capture-worker".to_string())
            .spawn(move || {
                if let Err(e) = initialize_mta().ok() {
                    log::warn!("audio_capture: initialize_mta failed: {e}");
                    return;
                }
                let audio_client = match create_audio_client(&source) {
                    Ok(client) => client,
                    Err(e) => {
                        log::warn!("audio_capture: create audio client failed: {e}");
                        return;
                    }
                };
                if let Err(e) = run_capture_loop(audio_client, tx, stop_for_thread, source) {
                    log::warn!("audio_capture: capture loop ended: {e}");
                }
            })
            .map_err(|e| format!("spawn capture worker: {e}"))?;
        Ok((CaptureWorkerHandle { stop, join }, rx))
    }

    pub fn start_endpoint_loopback_capture(
    ) -> Result<(CaptureWorkerHandle, Receiver<CapturePacket>), String> {
        spawn_worker(CaptureSource::EndpointLoopback)
    }

    pub fn start_process_loopback_capture(
        source_app: &str,
    ) -> Result<(CaptureWorkerHandle, Receiver<CapturePacket>), String> {
        let pid = resolve_pid_for_source_app(source_app)
            .ok_or_else(|| format!("no process resolved for source app {source_app}"))?;
        spawn_worker(CaptureSource::ProcessLoopback { pid })
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{CapturePacket, CaptureWorkerHandle, CAPTURE_CHANNEL_CAPACITY, ANALYZER_SAMPLE_RATE_HZ};
    use libpulse_binding::sample::{Format, Spec};
    use libpulse_binding::stream::Direction;
    use libpulse_simple_binding::Simple;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    const CAPTURE_CHUNK_FRAMES: usize = 4096;
    const CAPTURE_CHANNELS: u8 = 1;

    fn open_monitor_stream() -> Result<Simple, String> {
        let spec = Spec {
            format: Format::F32le,
            channels: CAPTURE_CHANNELS,
            rate: ANALYZER_SAMPLE_RATE_HZ,
        };
        if !spec.is_valid() {
            return Err("pulse sample spec invalid".to_string());
        }

        // `@DEFAULT_MONITOR@` is the Pulse/PipeWire equivalent of WASAPI endpoint loopback.
        let first = Simple::new(
            None,
            "guitar-scale-viewer",
            Direction::Record,
            Some("@DEFAULT_MONITOR@"),
            "system-audio-capture",
            &spec,
            None,
            None,
        );
        match first {
            Ok(simple) => Ok(simple),
            Err(err) => {
                log::warn!(
                    "audio_capture: pulse @DEFAULT_MONITOR@ failed ({err}); trying default source"
                );
                Simple::new(
                    None,
                    "guitar-scale-viewer",
                    Direction::Record,
                    None,
                    "system-audio-capture",
                    &spec,
                    None,
                    None,
                )
                .map_err(|e| format!("pulse simple record: {e}"))
            }
        }
    }

    fn f32le_mono(bytes: &[u8]) -> Vec<f32> {
        let mut out = Vec::with_capacity(bytes.len() / 4);
        let mut i = 0;
        while i + 4 <= bytes.len() {
            let sample = f32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
            out.push(sample.clamp(-1.0, 1.0));
            i += 4;
        }
        out
    }

    pub fn start_endpoint_loopback_capture(
    ) -> Result<(CaptureWorkerHandle, Receiver<CapturePacket>), String> {
        // Open once on the caller thread so start failures surface immediately.
        let _probe = open_monitor_stream()?;
        drop(_probe);

        let (tx, rx) = mpsc::sync_channel::<CapturePacket>(CAPTURE_CHANNEL_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let join = thread::Builder::new()
            .name("audio-capture-worker".into())
            .spawn(move || {
                let simple = match open_monitor_stream() {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("audio_capture: pulse monitor open failed: {e}");
                        return;
                    }
                };
                let mut buf = vec![0u8; CAPTURE_CHUNK_FRAMES * 4];
                while !stop_for_thread.load(Ordering::Relaxed) {
                    if let Err(e) = simple.read(&mut buf) {
                        log::warn!("audio_capture: pulse read failed: {e}");
                        thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                    let mono = f32le_mono(&buf);
                    if mono.is_empty() {
                        continue;
                    }
                    if tx
                        .send(CapturePacket {
                            sample_rate_hz: ANALYZER_SAMPLE_RATE_HZ,
                            mono_samples: mono,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|e| format!("spawn pulse capture worker: {e}"))?;
        Ok((CaptureWorkerHandle { stop, join }, rx))
    }
}

/// Owns capture mode selection and rolling in-memory audio buffer.
pub struct AudioCaptureManager {
    capture_mode: CaptureMode,
    target_app: Option<String>,
    sample_rate_hz: u32,
    mono_ring: VecDeque<f32>,
    max_samples: usize,
    has_live_capture: bool,
    requested_mode: CaptureMode,
    mode_reason: Option<String>,
    last_ingest: Instant,
    #[cfg_attr(not(windows), allow(dead_code))]
    process_start_failures: u32,
    endpoint_start_failures: u32,
    disconnected_since: Option<Instant>,
    #[cfg_attr(not(windows), allow(dead_code))]
    last_process_attempt: Option<Instant>,
    last_silent_capture_log: Option<Instant>,
    recent_silence_until: Option<Instant>,
    #[cfg(any(windows, target_os = "linux"))]
    receiver: Option<Receiver<CapturePacket>>,
    #[cfg(any(windows, target_os = "linux"))]
    worker: Option<CaptureWorkerHandle>,
}

impl AudioCaptureManager {
    pub fn new() -> Self {
        let max_samples = ANALYZER_SAMPLE_RATE_HZ as usize * ROLLING_BUFFER_SECONDS;
        Self {
            capture_mode: if native_loopback_supported() {
                CaptureMode::EndpointLoopback
            } else {
                CaptureMode::Unavailable
            },
            target_app: None,
            sample_rate_hz: ANALYZER_SAMPLE_RATE_HZ,
            mono_ring: VecDeque::with_capacity(max_samples),
            max_samples,
            has_live_capture: false,
            requested_mode: if cfg!(windows) {
                CaptureMode::ProcessLoopback
            } else if cfg!(target_os = "linux") {
                CaptureMode::EndpointLoopback
            } else {
                CaptureMode::Unavailable
            },
            mode_reason: Some("init".to_string()),
            last_ingest: Instant::now(),
            process_start_failures: 0,
            endpoint_start_failures: 0,
            disconnected_since: None,
            last_process_attempt: None,
            last_silent_capture_log: None,
            recent_silence_until: None,
            #[cfg(any(windows, target_os = "linux"))]
            receiver: None,
            #[cfg(any(windows, target_os = "linux"))]
            worker: None,
        }
    }

    pub fn snapshot(&self) -> CaptureSnapshot {
        let seconds = self.mono_ring.len() as f32 / self.sample_rate_hz as f32;
        CaptureSnapshot {
            requested_mode: self.requested_mode,
            capture_mode: self.capture_mode,
            mode_reason: self.mode_reason.clone(),
            target_app: self.target_app.clone(),
            buffer_seconds: seconds,
            has_live_capture: self.has_live_capture,
            recent_silence: self
                .recent_silence_until
                .map(|t| Instant::now() < t)
                .unwrap_or(false),
        }
    }

    fn stop_worker(&mut self) {
        #[cfg(any(windows, target_os = "linux"))]
        {
            if let Some(worker) = &self.worker {
                worker.request_stop();
            }
            self.worker = None;
            self.receiver = None;
            self.disconnected_since = None;
        }
    }

    pub fn stop_capture(&mut self, reason: &str) {
        #[cfg(any(windows, target_os = "linux"))]
        {
            if self.worker.is_some() || self.receiver.is_some() {
                log::info!(
                    "audio_capture: stopping capture reason={} mode={:?} target={:?}",
                    reason,
                    self.capture_mode,
                    self.target_app
                );
            }
            self.stop_worker();
            self.requested_mode = CaptureMode::Unavailable;
            self.capture_mode = CaptureMode::Unavailable;
            self.mode_reason = Some(format!("capture_stopped:{reason}"));
            self.reset();
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = reason;
            self.requested_mode = CaptureMode::Unavailable;
            self.capture_mode = CaptureMode::Unavailable;
        }
    }

    #[cfg(target_os = "linux")]
    fn start_linux_monitor(&mut self, preserve_buffer: bool) {
        self.requested_mode = CaptureMode::EndpointLoopback;
        match linux::start_endpoint_loopback_capture() {
            Ok((worker, rx)) => {
                self.capture_mode = CaptureMode::EndpointLoopback;
                self.mode_reason = Some("endpoint_loopback_active".to_string());
                self.worker = Some(worker);
                self.receiver = Some(rx);
                self.endpoint_start_failures = 0;
                if !preserve_buffer {
                    self.reset();
                }
                log::info!(
                    "audio_capture: capture started mode=EndpointLoopback target={:?}",
                    self.target_app
                );
            }
            Err(err) => {
                self.endpoint_start_failures = self.endpoint_start_failures.saturating_add(1);
                log::warn!(
                    "audio_capture: pulse monitor start failed attempt {} ({err})",
                    self.endpoint_start_failures
                );
                if self.endpoint_start_failures >= ENDPOINT_UNAVAILABLE_FAILURE_THRESHOLD {
                    self.capture_mode = CaptureMode::Unavailable;
                    self.mode_reason = Some("endpoint_unavailable".to_string());
                    self.worker = None;
                    self.receiver = None;
                    log::error!("audio_capture: sustained pulse monitor failures; mode set to unavailable");
                }
            }
        }
    }

    pub fn ensure_capture_running_for_target(&mut self, target_app: Option<String>) {
        if !native_loopback_supported() {
            self.capture_mode = CaptureMode::Unavailable;
            return;
        }

        #[cfg(target_os = "linux")]
        {
            let target_changed = self.target_app != target_app;
            let needs_boot = self.worker.is_none();
            if !target_changed && !needs_boot {
                return;
            }
            let preserve_buffer = !target_changed;
            if target_changed {
                self.stop_worker();
                self.target_app = target_app;
                self.endpoint_start_failures = 0;
                self.reset();
            } else {
                self.stop_worker();
            }
            self.start_linux_monitor(preserve_buffer);
            return;
        }

        #[cfg(windows)]
        {
            let target_changed = self.target_app != target_app;
            let needs_boot = self.worker.is_none();
            if !target_changed && !needs_boot {
                return;
            }
            let now = Instant::now();
            let preserve_buffer = !target_changed;

            if target_changed {
                self.stop_worker();
                self.target_app = target_app.clone();
                self.process_start_failures = 0;
                self.endpoint_start_failures = 0;
                self.last_process_attempt = None;
                self.reset();
            } else {
                self.stop_worker();
            }

            let should_attempt_process = target_app.is_some()
                && (self.capture_mode == CaptureMode::ProcessLoopback
                    || self.capture_mode == CaptureMode::Unavailable
                    || self
                        .last_process_attempt
                        .map(|last| now.duration_since(last) >= PROCESS_REACQUIRE_COOLDOWN)
                        .unwrap_or(true));
            if !should_attempt_process {
                log::debug!(
                    "audio_capture: keeping {:?}; process reacquire cooldown active target={:?}",
                    self.capture_mode,
                    target_app
                );
            } else if target_app.is_none() {
                log::debug!("audio_capture: no target app for process loopback; using endpoint fallback");
            }
            self.requested_mode = if target_app.is_some() {
                CaptureMode::ProcessLoopback
            } else {
                CaptureMode::EndpointLoopback
            };

            if should_attempt_process {
                let source_app = target_app.as_deref().unwrap_or_default();
                self.last_process_attempt = Some(now);
                match win::start_process_loopback_capture(source_app) {
                    Ok((worker, rx)) => {
                        self.capture_mode = CaptureMode::ProcessLoopback;
                        self.mode_reason = Some("process_loopback_active".to_string());
                        self.worker = Some(worker);
                        self.receiver = Some(rx);
                        self.process_start_failures = 0;
                        self.endpoint_start_failures = 0;
                        if !preserve_buffer {
                            self.reset();
                        }
                        log::info!(
                            "audio_capture: capture started mode=ProcessLoopback target={:?}",
                            self.target_app
                        );
                        log::info!("audio_capture: using sticky process loopback for {source_app}");
                        return;
                    }
                    Err(err) => {
                        self.process_start_failures = self.process_start_failures.saturating_add(1);
                        self.mode_reason = Some(format!(
                            "process_loopback_start_failed:{}",
                            self.process_start_failures
                        ));
                        log::warn!(
                            "audio_capture: process loopback start failed attempt {} ({err})",
                            self.process_start_failures
                        );
                        if self.capture_mode == CaptureMode::ProcessLoopback
                            && self.process_start_failures < PROCESS_FALLBACK_FAILURE_THRESHOLD
                        {
                            log::info!(
                                "audio_capture: keeping process loopback sticky until sustained failure threshold ({}/{})",
                                self.process_start_failures,
                                PROCESS_FALLBACK_FAILURE_THRESHOLD
                            );
                            return;
                        }
                    }
                }
            }

            match win::start_endpoint_loopback_capture() {
                Ok((worker, rx)) => {
                    self.capture_mode = CaptureMode::EndpointLoopback;
                    self.mode_reason = Some("endpoint_loopback_fallback_active".to_string());
                    self.worker = Some(worker);
                    self.receiver = Some(rx);
                    self.endpoint_start_failures = 0;
                    if !preserve_buffer {
                        self.reset();
                    }
                    log::info!(
                        "audio_capture: capture started mode=EndpointLoopback target={:?}",
                        self.target_app
                    );
                    log::info!("audio_capture: using endpoint loopback fallback");
                }
                Err(err) => {
                    self.endpoint_start_failures = self.endpoint_start_failures.saturating_add(1);
                    log::warn!(
                        "audio_capture: endpoint loopback start failed attempt {} ({err})",
                        self.endpoint_start_failures
                    );
                    if self.endpoint_start_failures >= ENDPOINT_UNAVAILABLE_FAILURE_THRESHOLD {
                        self.capture_mode = CaptureMode::Unavailable;
                        self.mode_reason = Some("endpoint_unavailable".to_string());
                        self.worker = None;
                        self.receiver = None;
                        log::error!("audio_capture: sustained endpoint failures; mode set to unavailable");
                    }
                }
            }
        }
    }

    /// Force endpoint loopback when process-loopback appears unhealthy (e.g. repeated silence).
    pub fn force_endpoint_fallback(&mut self, reason: &str) {
        #[cfg(windows)]
        {
            log::warn!(
                "audio_capture: forcing endpoint fallback reason={} previous_mode={:?} target={:?}",
                reason,
                self.capture_mode,
                self.target_app
            );
            self.stop_worker();
            self.process_start_failures = PROCESS_FALLBACK_FAILURE_THRESHOLD;
            self.endpoint_start_failures = 0;
            match win::start_endpoint_loopback_capture() {
                Ok((worker, rx)) => {
                    self.capture_mode = CaptureMode::EndpointLoopback;
                    self.mode_reason = Some(format!("forced_endpoint_fallback:{reason}"));
                    self.worker = Some(worker);
                    self.receiver = Some(rx);
                    self.reset();
                    log::info!("audio_capture: endpoint fallback forced successfully");
                }
                Err(err) => {
                    self.capture_mode = CaptureMode::Unavailable;
                    self.mode_reason = Some(format!("forced_endpoint_fallback_failed:{reason}"));
                    self.worker = None;
                    self.receiver = None;
                    log::error!("audio_capture: forced endpoint fallback failed: {err}");
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            log::warn!(
                "audio_capture: restarting pulse monitor reason={} previous_mode={:?} target={:?}",
                reason,
                self.capture_mode,
                self.target_app
            );
            self.stop_worker();
            self.endpoint_start_failures = 0;
            self.start_linux_monitor(false);
            if self.capture_mode == CaptureMode::EndpointLoopback {
                self.mode_reason = Some(format!("forced_endpoint_fallback:{reason}"));
            } else {
                self.mode_reason = Some(format!("forced_endpoint_fallback_failed:{reason}"));
            }
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = reason;
        }
    }

    pub fn poll_capture_samples(&mut self) {
        #[cfg(any(windows, target_os = "linux"))]
        {
            let mut packets: Vec<CapturePacket> = Vec::new();
            let mut packet_peak_max: f32 = 0.0;
            let (received_any, disconnected) = if let Some(rx) = self.receiver.as_ref() {
                drain_capture_channel(rx, |packet| packets.push(packet))
            } else {
                (false, false)
            };
            for packet in packets {
                let peak = packet
                    .mono_samples
                    .iter()
                    .fold(0.0f32, |acc, v| acc.max(v.abs()));
                packet_peak_max = packet_peak_max.max(peak);
                self.ingest_mono_samples(packet.sample_rate_hz, &packet.mono_samples);
            }
            if received_any {
                self.disconnected_since = None;
                if packet_peak_max <= 1e-6 {
                    self.recent_silence_until = Some(Instant::now() + RECENT_SILENCE_BLOCK_WINDOW);
                    let now = Instant::now();
                    let should_log = self
                        .last_silent_capture_log
                        .map(|t| now.duration_since(t) >= Duration::from_secs(10))
                        .unwrap_or(true);
                    if should_log {
                        log::warn!(
                            "audio_capture: capture packets are silent peak={:.8} mode={:?} target={:?}",
                            packet_peak_max,
                            self.capture_mode,
                            self.target_app
                        );
                        self.last_silent_capture_log = Some(now);
                    }
                } else {
                    self.recent_silence_until = None;
                    log::debug!(
                        "audio_capture: received audio peak={:.5} buffer={:.1}s mode={:?}",
                        packet_peak_max,
                        self.available_buffer_seconds(),
                        self.capture_mode
                    );
                }
            }
            if disconnected {
                let now = Instant::now();
                if self.disconnected_since.is_none() {
                    self.disconnected_since = Some(now);
                    log::warn!(
                        "audio_capture: capture channel disconnected; waiting grace period before restart (mode={:?}, target={:?})",
                        self.capture_mode,
                        self.target_app
                    );
                } else if let Some(since) = self.disconnected_since {
                    if now.duration_since(since) >= DISCONNECT_GRACE_PERIOD {
                        log::warn!(
                            "audio_capture: capture disconnected beyond grace period; scheduling restart (mode={:?}, target={:?})",
                            self.capture_mode,
                            self.target_app
                        );
                        self.stop_worker();
                    }
                }
            }
        }
    }

    pub fn reset(&mut self) {
        self.mono_ring.clear();
        self.has_live_capture = false;
        self.last_ingest = Instant::now();
        self.recent_silence_until = None;
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn available_buffer_seconds(&self) -> f32 {
        self.mono_ring.len() as f32 / self.sample_rate_hz as f32
    }

    pub fn enough_audio(&self, required_seconds: f32) -> bool {
        self.available_buffer_seconds() >= required_seconds
    }

    pub fn latest_samples(&self, seconds: usize) -> Vec<f32> {
        let sample_count = (seconds * self.sample_rate_hz as usize).min(self.mono_ring.len());
        self.mono_ring
            .iter()
            .skip(self.mono_ring.len().saturating_sub(sample_count))
            .copied()
            .collect()
    }

    fn resample_linear(input: &[f32], src_hz: u32, dst_hz: u32) -> Vec<f32> {
        if input.is_empty() || src_hz == 0 || dst_hz == 0 || src_hz == dst_hz {
            return input.to_vec();
        }
        let out_len = ((input.len() as f64) * dst_hz as f64 / src_hz as f64).round() as usize;
        let mut out = Vec::with_capacity(out_len.max(1));
        let ratio = src_hz as f64 / dst_hz as f64;
        for i in 0..out_len {
            let src_pos = i as f64 * ratio;
            let a = src_pos.floor() as usize;
            let b = (a + 1).min(input.len().saturating_sub(1));
            let t = (src_pos - a as f64) as f32;
            let sample = input[a] + (input[b] - input[a]) * t;
            out.push(sample.clamp(-1.0, 1.0));
        }
        out
    }

    /// Called by platform pump; keeps only rolling in-memory samples.
    pub fn ingest_mono_samples(&mut self, sample_rate_hz: u32, mono_samples: &[f32]) {
        if sample_rate_hz == 0 || mono_samples.is_empty() {
            return;
        }
        let normalized = if sample_rate_hz != ANALYZER_SAMPLE_RATE_HZ {
            Self::resample_linear(mono_samples, sample_rate_hz, ANALYZER_SAMPLE_RATE_HZ)
        } else {
            mono_samples.to_vec()
        };
        if self.sample_rate_hz != ANALYZER_SAMPLE_RATE_HZ {
            self.sample_rate_hz = ANALYZER_SAMPLE_RATE_HZ;
            self.max_samples = self.sample_rate_hz as usize * ROLLING_BUFFER_SECONDS;
            self.mono_ring.clear();
        }

        for &sample in &normalized {
            if self.mono_ring.len() >= self.max_samples {
                let _ = self.mono_ring.pop_front();
            }
            self.mono_ring.push_back(sample.clamp(-1.0, 1.0));
        }
        self.has_live_capture = true;
        self.last_ingest = Instant::now();
    }

    /// Safety valve: stale capture means we should not continue to trust old evidence.
    pub fn mark_stale_if_inactive(&mut self, timeout: Duration) {
        if self.last_ingest.elapsed() > timeout {
            self.has_live_capture = false;
        }
    }
}
