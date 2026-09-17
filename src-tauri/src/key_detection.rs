use crate::audio_models::WindowAnalysisResult;
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
    fn deref(&self) -> &Child { &self.0 }
}
impl std::ops::DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Child { &mut self.0 }
}
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct TempWav(PathBuf);
impl Drop for TempWav {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

fn read_sidecar_line(lines: &mpsc::Receiver<Result<String, String>>, timeout: Duration) -> Result<String, String> {
    lines.recv_timeout(timeout).map_err(|error| match error {
        mpsc::RecvTimeoutError::Timeout => "sidecar response deadline exceeded".to_string(),
        mpsc::RecvTimeoutError::Disconnected => "sidecar closed output stream".to_string(),
    })?
}

fn stdout_lines(stdout: ChildStdout) -> mpsc::Receiver<Result<String, String>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender.send(line.map_err(|error| format!("read sidecar: {error}"))).is_err() { break; }
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarReady {
    ready: Option<bool>,
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
        let mut child = ManagedChild(command
            .spawn()
            .map_err(|e| format!("spawn sidecar ({}): {e}", self.launch.descriptor))?);
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
        let ready_flag = parsed_ready
            .as_ref()
            .and_then(|r| r.ready)
            .unwrap_or(false);
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
            Some("sidecar_not_ready".to_string())
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

        log::info!("key_detection: spawned persistent analyzer {}", self.launch.descriptor);
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
        let mut json = serde_json::to_vec(request).map_err(|e| format!("serialize request: {e}"))?;
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
        let parsed: AnalyzeResponse =
            serde_json::from_str(line.trim()).map_err(|e| format!("decode sidecar response: {e}"))?;
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
    let rest = if rest.starts_with('/') { rest } else { format!("/{rest}") };
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
        let temp_dir = std::env::temp_dir();
        let name = format!(
            "gsv_key_window_{}_{}.wav",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );
        let wav_path = temp_dir.join(name);
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
        let temp_dir = std::env::temp_dir();
        let name = format!(
            "gsv_key_window_{}_{}.wav",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );
        let wav_path = temp_dir.join(name);
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
        let _temp_wav = TempWav(wav_path.clone());
        let mut child = ManagedChild(cmd.spawn()
            .map_err(|e| format!("run libkeyfinder analyzer ({}): {e}", self.launch.descriptor))?);
        if let Some(stderr) = child.stderr.take() { SidecarKeyDetector::spawn_stderr_pump(stderr); }
        let lines = stdout_lines(child.stdout.take().ok_or("CLI stdout unavailable")?);
        let deadline = Instant::now() + self.launch.response_timeout;
        let stdout = read_sidecar_line(&lines, self.launch.response_timeout)?;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| format!("wait CLI: {e}"))? { break status; }
            if Instant::now() >= deadline { return Err("CLI exit deadline exceeded".into()); }
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
        let parsed: LibKeyFinderResponse = serde_json::from_str(stdout.trim())
            .map_err(|e| format!("decode libkeyfinder response: {e}; stdout={stdout}"))?;
        let backend = parsed
            .backend_used
            .unwrap_or_else(|| "libkeyfinder".to_string());
        if let Ok(mut h) = self.last_health.lock() {
            *h = DetectorHealth {
                healthy: true,
                backend: backend.clone(),
                reason: None,
            };
        }

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
            });
        }

        let display = format!("{} {}", key, scale);
        Ok(AnalysisOutput {
            windows: vec![WindowAnalysisResult {
                profile_type: "libkeyfinder".to_string(),
                key,
                scale,
                display_name: display,
                strength: 0.90,
                first_to_second_relative_strength: Some(0.25),
                candidates: None,
                tuning_cents: None,
                window_start_ms: 0,
                window_end_ms: 12_000,
            }],
            backend_used: backend,
            fallback_reason: None,
        })
    }

    fn health(&self) -> DetectorHealth {
        self.last_health
            .lock()
            .map(|h| h.clone())
            .unwrap_or_else(|_| DetectorHealth::unavailable("health_lock_poisoned"))
    }
}

fn write_temp_wav_f32_mono(path: &Path, sample_rate_hz: u32, mono_samples: &[f32]) -> Result<(), String> {
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
    writer.finalize().map_err(|e| format!("finalize wav: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn python() -> String {
        std::env::var("KEY_ANALYZER_PYTHON").unwrap_or_else(|_| "python".into())
    }

    #[test]
    fn numpy_worker_is_healthy_and_can_analyze_silence() {
        let detector = SidecarKeyDetector::from_python_script(&python(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecars/key_analyzer/key_analyzer.py"));
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
        let detector = controlled_worker("import time; time.sleep(2); print('{\"ready\":true,\"numpyAvailable\":true}')");
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
        detector.launch.args_prefix = vec!["-c".into(), "import time; time.sleep(2); print('{\"key\":\"C\",\"scale\":\"major\"}')".into()];
        detector.launch.response_timeout = Duration::from_millis(100);
        let start = Instant::now();
        assert!(detector.analyze(&[0.0; 20], 8000, 1, 1).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn libkeyfinder_preserves_flat_accidentals() {
        let mut detector = LibKeyFinderDetector::from_executable(PathBuf::from(python()));
        detector.launch.args_prefix = vec!["-c".into(), "print('{\"key\":\"Bb\",\"scale\":\"major\"}')".into()];
        let result = detector.analyze(&[0.0; 20], 8000, 1, 1).unwrap();
        assert_eq!(result.windows[0].key, "Bb");
    }
}

