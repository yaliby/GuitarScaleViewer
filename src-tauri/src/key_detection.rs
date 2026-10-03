use crate::audio_models::WindowAnalysisResult;
use crate::key_engine;
use crate::key_reranker;
use crate::playalong::lower_priority;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct DetectorHealth {
    pub healthy: bool,
    pub backend: String,
    pub reason: Option<String>,
}

impl DetectorHealth {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            healthy: false,
            backend: "unavailable".to_string(),
            reason: Some(reason.into()),
        }
    }
}

pub trait KeyDetector: Send + Sync {
    fn analyze(
        &self,
        mono_samples: &[f32],
        sample_rate_hz: u32,
        window_seconds: usize,
        hop_seconds: usize,
    ) -> Result<AnalysisOutput, String>;
    fn health(&self) -> DetectorHealth;
}

#[derive(Debug, Clone)]
pub struct AnalysisOutput {
    pub windows: Vec<WindowAnalysisResult>,
    pub backend_used: String,
    pub fallback_reason: Option<String>,
    /// The twelve pitch classes of this pass, summed over every octave. `None` from any backend
    /// that does not report one. `key_engine::tonic_is_supported` reads it to decide whether the
    /// root on the neck is backed by evidence or is one end of a coin flip.
    pub chroma: Option<Vec<f32>>,
}

#[derive(Debug)]
pub struct SidecarKeyDetector {
    launch: SidecarLaunch,
    worker: Mutex<Option<SidecarWorker>>,
    last_health: Mutex<DetectorHealth>,
}

#[derive(Debug)]
pub struct LibKeyFinderDetector {
    launch: LibKeyFinderLaunch,
    last_health: Mutex<DetectorHealth>,
}

#[derive(Debug, Clone)]
struct LibKeyFinderLaunch {
    program: String,
    args_prefix: Vec<String>,
    descriptor: String,
    response_timeout: Duration,
}

#[derive(Debug, Clone)]
struct SidecarLaunch {
    program: String,
    args_prefix: Vec<String>,
    descriptor: String,
    startup_timeout: Duration,
    response_timeout: Duration,
}

#[derive(Debug)]
struct SidecarWorker {
    child: ManagedChild,
    stdin: ChildStdin,
    stdout: mpsc::Receiver<Result<String, String>>,
    backend: String,
}

#[derive(Debug)]
struct ManagedChild(Child);

impl std::ops::Deref for ManagedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}
impl std::ops::DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct TempWav(PathBuf);
impl Drop for TempWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Stops the sidecar flashing a console window on Windows. A no-op everywhere else, which is why
/// the parameter is unused off-Windows rather than the signature being conditional.
fn hide_console(#[cfg_attr(not(windows), allow(unused_variables))] command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

fn read_sidecar_line(
    lines: &mpsc::Receiver<Result<String, String>>,
    timeout: Duration,
) -> Result<String, String> {
    lines.recv_timeout(timeout).map_err(|error| match error {
        mpsc::RecvTimeoutError::Timeout => "sidecar response deadline exceeded".to_string(),
        mpsc::RecvTimeoutError::Disconnected => "sidecar closed output stream".to_string(),
    })?
}

fn stdout_lines(stdout: ChildStdout) -> mpsc::Receiver<Result<String, String>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender
                .send(line.map_err(|error| format!("read sidecar: {error}")))
                .is_err()
            {
                break;
            }
        }
    });
    receiver
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeRequest<'a> {
    sample_rate_hz: u32,
    window_seconds: usize,
    hop_seconds: usize,
    profile_types: &'a [&'a str],
    #[serde(skip_serializing_if = "Option::is_none")]
    wav_path: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeResponse {
    windows: Vec<WindowAnalysisResult>,
    error: Option<String>,
    backend_used: Option<String>,
    fallback_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibKeyFinderResponse {
    backend_used: Option<String>,
    key: String,
    scale: String,
    /// How well the chroma fits the key the CLI named. Absent on an older CLI build, in which
    /// case the window keeps the legacy constant rather than reporting a fabricated zero.
    #[serde(default)]
    strength: Option<f32>,
    /// The twelve pitch classes over every octave. `key_engine::tonic_is_supported` reads it.
    ///
    /// The CLI also emits `bassChroma` and `bassSegments`, and this struct deliberately does not
    /// carry them: both were measured against the corpus as tonic discriminators and neither
    /// beat a coin flip (see `docs/KEY_ACCURACY_BASELINE.md`). They stay in the CLI output as
    /// diagnostics for the next attempt; serde drops them here rather than this file implying
    /// they feed a decision.
    #[serde(default)]
    chroma: Option<Vec<f32>>,
    /// The classifier's ranked shortlist, with the chord evidence for each entry.
    ///
    /// Unlike `bassChroma` and `bassSegments` this *is* carried through, because it feeds a
    /// decision that was measured to pay: `key_reranker` reorders it and gains 1.7 points of
    /// note-set and 3.3 of tonic over taking the top entry. Absent on an older CLI build, and
    /// deliberately withheld by a current one when the audio is silent or when its replicated
    /// ranking fails to reproduce libKeyFinder's own winner.
    #[serde(default)]
    candidates: Option<Vec<LibKeyFinderCandidate>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibKeyFinderCandidate {
    key: String,
    scale: String,
    score: f32,
    /// How well the chroma fits *this* candidate, on the same scale as the top-level `strength`.
    /// Carried per candidate because the consensus layer votes with it, and a re-ranked key
    /// weighted by the fit of the key it replaced would be a number about a different key.
    #[serde(default)]
    strength: Option<f32>,
    #[serde(default)]
    chord_features: Vec<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarReady {
    ready: Option<bool>,
    ready_reason: Option<String>,
    essentia_available: Option<bool>,
    numpy_available: Option<bool>,
    essentia_error: Option<String>,
}

impl SidecarKeyDetector {
    pub fn from_executable(sidecar_executable: PathBuf) -> Self {
        Self {
            launch: SidecarLaunch {
                program: sidecar_executable.to_string_lossy().to_string(),
                args_prefix: Vec::new(),
                descriptor: sidecar_executable.display().to_string(),
                startup_timeout: Duration::from_secs(10),
                response_timeout: Duration::from_secs(8),
            },
            worker: Mutex::new(None),
            last_health: Mutex::new(DetectorHealth::unavailable("worker_not_started")),
        }
    }

    pub fn from_python_script(python_command: &str, script_path: PathBuf) -> Self {
        let mut args = Vec::new();
        if python_command.eq_ignore_ascii_case("py") {
            args.push("-3".to_string());
        }
        args.push(script_path.to_string_lossy().to_string());
        Self {
            launch: SidecarLaunch {
                program: python_command.to_string(),
                args_prefix: args,
                descriptor: format!("{python_command} {}", script_path.display()),
                startup_timeout: Duration::from_secs(10),
                response_timeout: Duration::from_secs(8),
            },
            worker: Mutex::new(None),
            last_health: Mutex::new(DetectorHealth::unavailable("worker_not_started")),
        }
    }

    /// Runs the analyzer sidecar via WSL: `wsl -- <python> <linux_script_path> --serve`.
    pub fn from_wsl_python_script(linux_python: String, linux_script_path: String) -> Self {
        let args = vec![
            "--".to_string(),
            linux_python.clone(),
            linux_script_path.clone(),
        ];
        Self {
            launch: SidecarLaunch {
                program: "wsl".to_string(),
                args_prefix: args,
                descriptor: format!("wsl -- {linux_python} {linux_script_path}"),
                startup_timeout: Duration::from_secs(10),
                response_timeout: Duration::from_secs(8),
            },
            worker: Mutex::new(None),
            last_health: Mutex::new(DetectorHealth::unavailable("worker_not_started")),
        }
    }

    fn spawn_worker(&self) -> Result<SidecarWorker, String> {
        let mut command = Command::new(&self.launch.program);
        command
            .args(&self.launch.args_prefix)
            .arg("--serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut command);
        lower_priority(&mut command);
        let mut child = ManagedChild(
            command
                .spawn()
                .map_err(|e| format!("spawn sidecar ({}): {e}", self.launch.descriptor))?,
        );
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "sidecar stderr unavailable".to_string())?;
        Self::spawn_stderr_pump(stderr);

        let stdout_reader = stdout_lines(stdout);
        let ready_line = read_sidecar_line(&stdout_reader, self.launch.startup_timeout)?;
        if ready_line.trim().is_empty() {
            return Err("sidecar did not provide ready line".to_string());
        }
        log::info!(
            "key_detection: sidecar ready {}: {}",
            self.launch.descriptor,
            ready_line.trim()
        );

        let parsed_ready: Option<SidecarReady> = serde_json::from_str(ready_line.trim()).ok();
        let ready_flag = parsed_ready.as_ref().and_then(|r| r.ready).unwrap_or(false);
        let essentia_available = parsed_ready
            .as_ref()
            .and_then(|r| r.essentia_available)
            .unwrap_or(false);
        let numpy_available = parsed_ready
            .as_ref()
            .and_then(|r| r.numpy_available)
            .unwrap_or(false);
        let backend = if essentia_available {
            "essentia".to_string()
        } else if numpy_available {
            "numpy_fallback".to_string()
        } else {
            "unavailable".to_string()
        };
        let reason = if !ready_flag {
            Some(
                parsed_ready
                    .as_ref()
                    .and_then(|r| r.ready_reason.clone())
                    .unwrap_or_else(|| "sidecar_not_ready".to_string()),
            )
        } else if !essentia_available {
            Some(
                parsed_ready
                    .as_ref()
                    .and_then(|r| r.essentia_error.clone())
                    .unwrap_or_else(|| "essentia_not_available".to_string()),
            )
        } else {
            None
        };
        if let Ok(mut health) = self.last_health.lock() {
            *health = DetectorHealth {
                healthy: ready_flag && (essentia_available || numpy_available),
                backend: backend.clone(),
                reason: reason.clone(),
            };
        }
        if !essentia_available {
            log::warn!(
                "key_detection: analyzer backend is '{}' (Essentia unavailable: {})",
                backend,
                reason
                    .clone()
                    .unwrap_or_else(|| "unknown_reason".to_string())
            );
        } else {
            log::info!("key_detection: analyzer backend is 'essentia'");
        }

        log::info!(
            "key_detection: spawned persistent analyzer {}",
            self.launch.descriptor
        );
        Ok(SidecarWorker {
            child,
            stdin,
            stdout: stdout_reader,
            backend,
        })
    }

    fn analyze_with_worker(
        &self,
        worker: &mut SidecarWorker,
        request: &AnalyzeRequest<'_>,
        temp_wav_path: &Path,
    ) -> Result<AnalysisOutput, String> {
        log::debug!(
            "key_detection: sending request (wav={})",
            temp_wav_path.display()
        );
        let mut json =
            serde_json::to_vec(request).map_err(|e| format!("serialize request: {e}"))?;
        json.push(b'\n');
        worker
            .stdin
            .write_all(&json)
            .map_err(|e| format!("write sidecar request: {e}"))?;
        worker
            .stdin
            .flush()
            .map_err(|e| format!("flush sidecar request: {e}"))?;
        log::debug!("key_detection: request flushed; waiting for response");

        let line = read_sidecar_line(&worker.stdout, self.launch.response_timeout)?;
        let read = line.len();
        log::debug!("key_detection: response bytes read={read}");
        if read == 0 {
            let status = worker.child.try_wait().ok().flatten();
            let detail = if let Some(code) = status {
                format!("sidecar closed output stream (exited: {code:?})")
            } else {
                "sidecar closed output stream (no exit status yet)".to_string()
            };
            return Err(detail);
        }
        let parsed: AnalyzeResponse = serde_json::from_str(line.trim())
            .map_err(|e| format!("decode sidecar response: {e}"))?;
        if let Some(error) = parsed.error {
            return Err(format!("sidecar analysis error: {error}"));
        }
        // Delete the temp wav asap.
        let _ = std::fs::remove_file(temp_wav_path);
        Ok(AnalysisOutput {
            windows: parsed.windows,
            backend_used: parsed
                .backend_used
                .unwrap_or_else(|| worker.backend.clone()),
            fallback_reason: parsed.fallback_reason,
            // The python sidecar reports per-key candidate scores instead of a chroma, and the
            // consensus already uses those; it does not need the tonic-evidence test.
            chroma: None,
        })
    }

    fn spawn_stderr_pump(stderr: ChildStderr) {
        let _ = std::thread::Builder::new()
            .name("key-sidecar-stderr".to_string())
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            let msg = line.trim();
                            if !msg.is_empty() {
                                log::info!("key_detection: sidecar: {msg}");
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
    }
}

impl LibKeyFinderDetector {
    pub fn from_executable(executable: PathBuf) -> Self {
        Self {
            launch: LibKeyFinderLaunch {
                program: executable.to_string_lossy().to_string(),
                args_prefix: Vec::new(),
                descriptor: executable.display().to_string(),
                response_timeout: Duration::from_secs(8),
            },
            last_health: Mutex::new(DetectorHealth {
                healthy: true,
                backend: "libkeyfinder".to_string(),
                reason: None,
            }),
        }
    }

    pub fn from_wsl_executable(linux_executable: String) -> Self {
        Self {
            launch: LibKeyFinderLaunch {
                program: "wsl".to_string(),
                args_prefix: vec!["--".to_string(), linux_executable.clone()],
                descriptor: format!("wsl -- {linux_executable}"),
                response_timeout: Duration::from_secs(8),
            },
            last_health: Mutex::new(DetectorHealth {
                healthy: true,
                backend: "libkeyfinder".to_string(),
                reason: None,
            }),
        }
    }
}

fn windows_path_to_wsl(path: &Path) -> Option<String> {
    // Convert `C:\foo\bar.wav` -> `/mnt/c/foo/bar.wav` for WSL access.
    let s = path.to_string_lossy();
    let bytes = s.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    let drive = bytes[0] as char;
    if bytes[1] != b':' {
        return None;
    }
    let drive = drive.to_ascii_lowercase();
    let rest = s[2..].replace('\\', "/");
    let rest = if rest.starts_with('/') {
        rest
    } else {
        format!("/{rest}")
    };
    Some(format!("/mnt/{drive}{rest}"))
}

impl KeyDetector for SidecarKeyDetector {
    fn analyze(
        &self,
        mono_samples: &[f32],
        sample_rate_hz: u32,
        window_seconds: usize,
        hop_seconds: usize,
    ) -> Result<AnalysisOutput, String> {
        // Sending large PCM arrays as JSON is unstable on Windows (pipe/memory). Write a temp WAV instead.
        let wav_path = temp_wav_path();
        let _temp_wav = TempWav(wav_path.clone());
        write_temp_wav_f32_mono(&wav_path, sample_rate_hz, mono_samples)?;

        let mut wav_path_str = wav_path.to_string_lossy().to_string();
        // If we're launching the sidecar via WSL, the Python process runs in Linux and needs a `/mnt/<drive>/...` path.
        if self.launch.program.eq_ignore_ascii_case("wsl") {
            if let Some(wsl) = windows_path_to_wsl(&wav_path) {
                log::info!(
                    "key_detection: mapped wav path windows='{}' -> wsl='{}'",
                    wav_path.display(),
                    wsl
                );
                wav_path_str = wsl;
            } else {
                log::warn!(
                    "key_detection: failed to map wav path for WSL; using raw path '{}'",
                    wav_path.display()
                );
            }
        }
        let request = AnalyzeRequest {
            sample_rate_hz,
            window_seconds,
            hop_seconds,
            profile_types: &["bgate", "krumhansl", "shaath", "temperley", "edma"],
            wav_path: Some(&wav_path_str),
        };

        let mut guard = self
            .worker
            .lock()
            .map_err(|_| "sidecar worker lock poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(self.spawn_worker()?);
        }

        if let Some(worker) = guard.as_mut() {
            if worker.backend == "unavailable" {
                if let Ok(mut health) = self.last_health.lock() {
                    *health = DetectorHealth {
                        healthy: false,
                        backend: worker.backend.clone(),
                        reason: Some("analyzer_dependencies_missing".to_string()),
                    };
                }
                let _ = std::fs::remove_file(&wav_path);
                return Err(format!(
                    "analyzer_unavailable:dependencies_missing backend={}",
                    worker.backend
                ));
            }
            match self.analyze_with_worker(worker, &request, &wav_path) {
                Ok(output) => {
                    if output.windows.is_empty() {
                        log::info!(
                            "key_detection: sidecar returned zero windows backend={} fallbackReason={:?} (sr={}Hz window={}s hop={}s wav={})",
                            output.backend_used,
                            output.fallback_reason,
                            sample_rate_hz,
                            window_seconds,
                            hop_seconds,
                            wav_path_str
                        );
                    }
                    if let Ok(mut health) = self.last_health.lock() {
                        *health = DetectorHealth {
                            healthy: true,
                            backend: output.backend_used.clone(),
                            reason: None,
                        };
                    }
                    Ok(output)
                }
                Err(first_err) => {
                    log::warn!("key_detection: discarding failed sidecar: {first_err}");
                    // Drop kills and waits for the child, closing both pipe pumps.
                    // Retry on the next engine cycle, never extend this request's deadline.
                    drop(guard.take());
                    if let Ok(mut health) = self.last_health.lock() {
                        *health = DetectorHealth::unavailable(first_err.clone());
                    }
                    Err(first_err)
                }
            }
        } else {
            let _ = std::fs::remove_file(&wav_path);
            Err("sidecar unavailable".to_string())
        }
    }

    fn health(&self) -> DetectorHealth {
        // Best-effort: if the worker is not started yet, try to start it so we can report
        // an accurate backend/availability status (instead of "worker_not_started" forever).
        if let Ok(mut guard) = self.worker.lock() {
            if guard.is_none() {
                match self.spawn_worker() {
                    Ok(worker) => {
                        *guard = Some(worker);
                    }
                    Err(e) => {
                        if let Ok(mut h) = self.last_health.lock() {
                            *h = DetectorHealth::unavailable(format!("spawn_failed:{e}"));
                        }
                    }
                }
            }
        }

        self.last_health
            .lock()
            .map(|h| h.clone())
            .unwrap_or_else(|_| DetectorHealth::unavailable("health_lock_poisoned"))
    }
}

impl KeyDetector for LibKeyFinderDetector {
    fn analyze(
        &self,
        mono_samples: &[f32],
        sample_rate_hz: u32,
        _window_seconds: usize,
        _hop_seconds: usize,
    ) -> Result<AnalysisOutput, String> {
        let wav_path = temp_wav_path();
        write_temp_wav_f32_mono(&wav_path, sample_rate_hz, mono_samples)?;
        let mut wav_path_arg = wav_path.to_string_lossy().to_string();
        if self.launch.program.eq_ignore_ascii_case("wsl") {
            if let Some(mapped) = windows_path_to_wsl(&wav_path) {
                wav_path_arg = mapped;
            }
        }

        let mut cmd = Command::new(&self.launch.program);
        cmd.args(&self.launch.args_prefix).arg(&wav_path_arg);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        hide_console(&mut cmd);
        lower_priority(&mut cmd);
        let _temp_wav = TempWav(wav_path.clone());
        let mut child = ManagedChild(cmd.spawn().map_err(|e| {
            format!(
                "run libkeyfinder analyzer ({}): {e}",
                self.launch.descriptor
            )
        })?);
        if let Some(stderr) = child.stderr.take() {
            SidecarKeyDetector::spawn_stderr_pump(stderr);
        }
        let lines = stdout_lines(child.stdout.take().ok_or("CLI stdout unavailable")?);
        let deadline = Instant::now() + self.launch.response_timeout;
        let stdout = read_sidecar_line(&lines, self.launch.response_timeout)?;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| format!("wait CLI: {e}"))? {
                break status;
            }
            if Instant::now() >= deadline {
                return Err("CLI exit deadline exceeded".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if !status.success() {
            if let Ok(mut h) = self.last_health.lock() {
                *h = DetectorHealth {
                    healthy: false,
                    backend: "libkeyfinder".to_string(),
                    reason: Some(format!("cli_failed:{status}")),
                };
            }
            return Err(format!("libkeyfinder analyzer failed: {status}"));
        }
        let span_ms = if sample_rate_hz > 0 {
            (mono_samples.len() as u64) * 1000 / sample_rate_hz as u64
        } else {
            0
        };
        let output = analysis_from_cli_stdout(&stdout, span_ms)?;
        if let Ok(mut h) = self.last_health.lock() {
            *h = DetectorHealth {
                healthy: true,
                backend: output.backend_used.clone(),
                reason: None,
            };
        }
        Ok(output)
    }

    fn health(&self) -> DetectorHealth {
        self.last_health
            .lock()
            .map(|h| h.clone())
            .unwrap_or_else(|_| DetectorHealth::unavailable("health_lock_poisoned"))
    }
}

/// One CLI answer, turned into what the engine votes with.
///
/// Split out of [`LibKeyFinderDetector::analyze`] so that a replay over *cached* CLI output runs
/// the same parsing, the same chord re-ranking and the same span bookkeeping as the app — the
/// research cache (`scripts/key-research/cache_spans.py`) stores the CLI's stdout for every clip at
/// every buffer length, and a harness that re-implemented this would be measuring its copy.
///
/// `span_ms` is how much audio the CLI was handed; see the note on `window_end_ms` below for why
/// that, and not a fixed window, is what the verdict has to be dated with.
pub fn analysis_from_cli_stdout(stdout: &str, span_ms: u64) -> Result<AnalysisOutput, String> {
    let parsed: LibKeyFinderResponse = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("decode libkeyfinder response: {e}; stdout={stdout}"))?;
    let backend = parsed
        .backend_used
        .unwrap_or_else(|| "libkeyfinder".to_string());

    let key = parsed.key.trim().to_string();
    let scale = parsed.scale.trim().to_ascii_lowercase();
    let is_unknown = key.is_empty()
        || key == "UNKNOWN"
        || key == "SILENCE"
        || scale.is_empty()
        || scale == "unknown"
        || scale == "silence";
    if is_unknown {
        log::warn!(
            "key_detection: libkeyfinder returned unknown/silence key='{}' scale='{}'; emitting zero windows",
            key,
            scale
        );
        return Ok(AnalysisOutput {
            windows: Vec::new(),
            backend_used: backend,
            fallback_reason: Some("libkeyfinder_unknown_or_silence".to_string()),
            chroma: None,
        });
    }

    // Break a near-tie in the classifier's ranking with chord evidence it cannot see.
    //
    // The tone profile puts the true key first 63.8% of the time and somewhere in its top four
    // 84.6% of the time, so a fifth of every wrong answer is a key it had already found and
    // ranked second. `key_reranker` reads the chord features the CLI emits alongside each
    // candidate and reorders them; measured over the real corpus that is worth 1.7 points of
    // note-set and 3.3 of tonic. It declines — leaving this verdict exactly as it was — for
    // silence, for an older CLI that emits no shortlist, and for anything malformed.
    let candidates = parsed.candidates.unwrap_or_default();
    let shortlist: Vec<key_reranker::ShortlistEntry> = candidates
        .iter()
        .map(|c| key_reranker::ShortlistEntry {
            key: c.key.trim().to_string(),
            scale: c.scale.trim().to_ascii_lowercase(),
            score: c.score,
            chord_features: c.chord_features.clone(),
        })
        .collect();
    // Whether the root is a coin flip, measured before the re-ranker gets a vote and kept
    // whichever way it votes. When the profile's top two are relatives, the gap between them
    // is calibrated: below 0.002 its leader is right 47.5% of the time and the runner-up 22.0%,
    // which is not a verdict. From 0.002 to 0.004 the leader is right 66.7%, and by 0.008 it is
    // 85.7%. `key_engine::RELATIVE_PAIR_COIN_FLIP_GAP` carries the table and the threshold, and
    // turns this into the readout's `tonic_open`.
    let relative_pair_gap = match shortlist.as_slice() {
        [first, second, ..]
            if key_engine::is_relative_major_minor(
                &first.key,
                &first.scale,
                &second.key,
                &second.scale,
            ) =>
        {
            Some(first.score - second.score).filter(|gap| gap.is_finite())
        }
        _ => None,
    };
    let mut moved_strength = None;
    let (key, scale) = match key_reranker::rerank(&shortlist) {
        Some(position) if position > 0 => {
            let chosen = &shortlist[position];
            log::debug!(
                "key_detection: chord evidence moved {} {} -> {} {} (position {position})",
                key,
                scale,
                chosen.key,
                chosen.scale
            );
            moved_strength = candidates[position].strength.filter(|s| s.is_finite());
            (chosen.key.clone(), chosen.scale.clone())
        }
        _ => (key, scale),
    };

    // What `key_confidence` reads: how far this verdict stands above the best key with different
    // notes. The shortlist always holds one — only one other key, the relative, shares a note set —
    // so this needs nothing the CLI does not already send. Taken after the re-ranker, because the
    // question is about the key the engine is about to show.
    let verdict_score = shortlist
        .iter()
        .find(|entry| entry.key == key && entry.scale == scale)
        .map(|entry| entry.score);
    let note_set_margin = verdict_score.and_then(|score| {
        shortlist
            .iter()
            .filter(|entry| {
                !crate::key_confidence::same_note_set(&entry.key, &entry.scale, &key, &scale)
            })
            .map(|entry| entry.score)
            .reduce(f32::max)
            .map(|best_other| score - best_other)
            .filter(|margin| margin.is_finite())
    });
    let top_score = shortlist
        .first()
        .map(|entry| entry.score)
        .filter(|s| s.is_finite());

    let display = format!("{} {}", key, scale);
    // The CLI now measures how well the chroma fits the key it named. Older builds do not,
    // and for those the legacy constant is kept rather than inventing a zero — a zero would
    // read as "no tonal fit at all" and trip the engine's weak-fit gate on every window.
    //
    // When the re-ranker moved the answer, this has to move with it: the consensus layer votes
    // with `strength`, and the fit of the key that was replaced says nothing about the key that
    // replaced it. An older CLI that sends no per-candidate strength cannot re-rank at all, so
    // there is no case where the fallback and the move are both in play.
    let strength = moved_strength
        .or(parsed.strength)
        .filter(|s| s.is_finite())
        .unwrap_or(0.90);
    Ok(AnalysisOutput {
        windows: vec![WindowAnalysisResult {
            profile_type: "libkeyfinder".to_string(),
            key,
            scale,
            display_name: display,
            strength,
            // Still a constant: the CLI reports one verdict, not a ranking, so there is no
            // measured runner-up to take a margin against. What used to be faked here — the
            // question of whether a rival reading is in play — is now answered from the
            // chroma by `key_engine::tonic_is_supported`.
            first_to_second_relative_strength: Some(0.25),
            candidates: None,
            relative_pair_gap,
            tuning_cents: None,
            note_set_margin,
            top_score,
            window_start_ms: 0,
            // How much audio this verdict is actually about. The CLI reads everything it is
            // handed, which is the whole capture buffer and not one window of it, so reporting a
            // fixed twelve seconds made consecutive passes over a growing buffer look identical to
            // `AnalysisEvidence::accept` — it dropped each one as audio it had already counted,
            // and the engine could not begin a stability streak until the buffer was full enough
            // to start sliding. Measured cost of that: no settled answer before about seventy
            // seconds. See `tests/key_accuracy_scoreboard.rs::key_engine_time_to_answer_curve`.
            window_end_ms: span_ms,
        }],
        backend_used: backend,
        fallback_reason: None,
        chroma: parsed
            .chroma
            .filter(|c| c.len() == 12 && c.iter().all(|v| v.is_finite())),
    })
}

/// A scratch path for the wav an analyzer pass hands its subprocess, unique per call.
///
/// The sequence number is what makes it unique, not the clock. The engine analyses once every
/// three seconds so a millisecond stamp was enough for it, but the accuracy harnesses run one
/// analysis per core and two of those land in the same millisecond routinely — where the older
/// name had them writing and deleting each other's wav.
fn temp_wav_path() -> PathBuf {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "gsv_key_window_{}_{}_{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

fn write_temp_wav_f32_mono(
    path: &Path,
    sample_rate_hz: u32,
    mono_samples: &[f32],
) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sample_rate_hz,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        hound::WavWriter::create(path, spec).map_err(|e| format!("create wav: {e}"))?;
    for &s in mono_samples {
        let s16 = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer
            .write_sample(s16)
            .map_err(|e| format!("write wav sample: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("finalize wav: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `python` is not a command on a stock Linux/macOS box — only `python3` is — and `py` is
    /// the Windows launcher. Hardcoding `python` made these tests fail with a spawn error that
    /// reads like a broken detector instead of a missing interpreter.
    fn python() -> String {
        std::env::var("KEY_ANALYZER_PYTHON")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    "py".into()
                } else {
                    "python3".into()
                }
            })
    }

    /// Needs numpy (or essentia) installed for the python sidecar to report a backend at all.
    /// `#[ignore]`d rather than left failing: a box without numpy is a supported configuration —
    /// the shipped default backend is libkeyfinder — and a permanently red suite teaches you to
    /// stop reading the output. CI runs it via `cargo test -- --ignored`.
    #[test]
    #[ignore = "requires the python analyzer stack (numpy); run with --ignored"]
    fn numpy_worker_is_healthy_and_can_analyze_silence() {
        let detector = SidecarKeyDetector::from_python_script(
            &python(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecars/key_analyzer/key_analyzer.py"),
        );
        assert!(detector.health().healthy, "{:?}", detector.health());
        let output = detector.analyze(&vec![0.0; 8000 * 4], 8000, 4, 2).unwrap();
        assert!(output.windows.is_empty());
    }

    fn controlled_worker(code: &str) -> SidecarKeyDetector {
        let mut detector = SidecarKeyDetector::from_executable(PathBuf::from(python()));
        detector.launch.args_prefix = vec!["-u".into(), "-c".into(), code.into()];
        detector.launch.startup_timeout = Duration::from_millis(100);
        detector.launch.response_timeout = Duration::from_millis(100);
        detector
    }

    #[test]
    fn sidecar_startup_has_a_deadline() {
        let detector = controlled_worker(
            "import time; time.sleep(2); print('{\"ready\":true,\"numpyAvailable\":true}')",
        );
        let start = Instant::now();
        let result = detector.spawn_worker();
        assert!(result.is_err(), "delayed ready must time out");
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn sidecar_response_has_a_deadline_and_worker_is_discarded() {
        let mut detector = controlled_worker("import time; print('{\"ready\":true,\"essentiaAvailable\":true,\"numpyAvailable\":true}'); input(); time.sleep(2); print('{\"windows\":[]}')");
        detector.launch.startup_timeout = Duration::from_secs(2);
        assert!(detector.health().healthy);
        let start = Instant::now();
        let result = detector.analyze(&[0.0; 20], 8000, 1, 1);
        assert!(result.is_err(), "delayed response must time out");
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(detector.worker.lock().unwrap().is_none());
    }

    #[test]
    fn libkeyfinder_cli_has_a_deadline() {
        let mut detector = LibKeyFinderDetector::from_executable(PathBuf::from(python()));
        detector.launch.args_prefix = vec![
            "-c".into(),
            "import time; time.sleep(2); print('{\"key\":\"C\",\"scale\":\"major\"}')".into(),
        ];
        detector.launch.response_timeout = Duration::from_millis(100);
        let start = Instant::now();
        assert!(detector.analyze(&[0.0; 20], 8000, 1, 1).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn libkeyfinder_preserves_flat_accidentals() {
        let mut detector = LibKeyFinderDetector::from_executable(PathBuf::from(python()));
        detector.launch.args_prefix = vec![
            "-c".into(),
            "print('{\"key\":\"Bb\",\"scale\":\"major\"}')".into(),
        ];
        let result = detector.analyze(&[0.0; 20], 8000, 1, 1).unwrap();
        assert_eq!(result.windows[0].key, "Bb");
    }
}
