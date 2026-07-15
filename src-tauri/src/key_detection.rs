use crate::audio_models::WindowAnalysisResult;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
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
}

#[derive(Debug, Clone)]
struct SidecarLaunch {
    program: String,
    args_prefix: Vec<String>,
    descriptor: String,
}

#[derive(Debug)]
struct SidecarWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    last_restart: Instant,
    restart_burst: u32,
    backend: String,
    essentia_available: bool,
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
        let mut child = command
            .spawn()
            .map_err(|e| format!("spawn sidecar ({}): {e}", self.launch.descriptor))?;
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

        let mut stdout_reader = BufReader::new(stdout);
        let mut ready_line = String::new();
        let _ = stdout_reader
            .read_line(&mut ready_line)
            .map_err(|e| format!("read sidecar ready line: {e}"))?;
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
                healthy: ready_flag && essentia_available,
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
            last_restart: Instant::now(),
            restart_burst: 0,
            backend,
            essentia_available,
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

        let mut line = String::new();
        let read = worker
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("read sidecar response: {e}"))?;
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
            if !worker.essentia_available {
                if let Ok(mut health) = self.last_health.lock() {
                    *health = DetectorHealth {
                        healthy: false,
                        backend: worker.backend.clone(),
                        reason: Some("essentia_required_but_missing".to_string()),
                    };
                }
                let _ = std::fs::remove_file(&wav_path);
                return Err(format!(
                    "analyzer_unavailable:essentia_required backend={}",
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
                    // Prevent tight restart loops if the sidecar cannot start (missing deps, etc.).
                    if worker.last_restart.elapsed() < Duration::from_secs(10) {
                        worker.restart_burst = worker.restart_burst.saturating_add(1);
                    } else {
                        worker.restart_burst = 0;
                    }
                    worker.last_restart = Instant::now();

                    // Do not drain stderr while the child is still running; read_to_string blocks until EOF.
                    let err_detail = first_err;

                    log::warn!(
                        "key_detection: sidecar request failed (burst={}): {err_detail}",
                        worker.restart_burst
                    );

                    if worker.restart_burst >= 3 {
                        // Stop trying to respawn every cycle; let the engine surface analysis_error.
                        if let Some(mut crashed) = guard.take() {
                            let _ = crashed.child.kill();
                        }
                        if let Ok(mut health) = self.last_health.lock() {
                            *health = DetectorHealth {
                                healthy: false,
                                backend: "unavailable".to_string(),
                                reason: Some("sidecar_unstable_or_missing_dependencies".to_string()),
                            };
                        }
                        let _ = std::fs::remove_file(&wav_path);
                        return Err("sidecar_unstable_or_missing_dependencies".to_string());
                    }
                    if let Some(mut crashed) = guard.take() {
                        let _ = crashed.child.kill();
                    }
                    *guard = Some(self.spawn_worker()?);
                    if let Some(restarted) = guard.as_mut() {
                        self.analyze_with_worker(restarted, &request, &wav_path)
                    } else {
                        Err("sidecar restart failed".to_string())
                    }
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
        let output = cmd
            .output()
            .map_err(|e| format!("run libkeyfinder analyzer ({}): {e}", self.launch.descriptor))?;
        let _ = std::fs::remove_file(&wav_path);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Ok(mut h) = self.last_health.lock() {
                *h = DetectorHealth {
                    healthy: false,
                    backend: "libkeyfinder".to_string(),
                    reason: Some(format!("cli_failed:{stderr}")),
                };
            }
            return Err(format!("libkeyfinder analyzer failed: {stderr}"));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
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

        let key = parsed.key.trim().to_ascii_uppercase();
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

