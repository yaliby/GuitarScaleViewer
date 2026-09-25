use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);
const FOLLOW_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayAlongResolveRequest {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub source_app: Option<String>,
    pub gen: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayAlongFollowRequest {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub position_ms: Option<i64>,
    pub source_app: Option<String>,
    pub playback_status: Option<String>,
    pub playing: Option<bool>,
    pub dev: Option<bool>,
}

#[derive(Debug)]
struct SidecarWorker {
    /// Held so Drop kills the process when the worker is replaced or shut down.
    _child: ManagedChild,
    stdin: ChildStdin,
    stdout: mpsc::Receiver<Result<String, String>>,
}

#[derive(Debug)]
struct ManagedChild(Child);

impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub struct PlayAlongSidecar {
    worker: Mutex<Option<SidecarWorker>>,
}

impl Default for PlayAlongSidecar {
    fn default() -> Self {
        Self {
            worker: Mutex::new(None),
        }
    }
}

fn hide_console(#[cfg_attr(not(windows), allow(unused_variables))] command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

fn stdout_lines(stdout: ChildStdout) -> mpsc::Receiver<Result<String, String>> {
    let (sender, receiver) = mpsc::sync_channel(4);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender
                .send(line.map_err(|error| format!("read chordsync sidecar: {error}")))
                .is_err()
            {
                break;
            }
        }
    });
    receiver
}

fn read_line(
    lines: &mpsc::Receiver<Result<String, String>>,
    timeout: Duration,
) -> Result<String, String> {
    lines.recv_timeout(timeout).map_err(|error| match error {
        mpsc::RecvTimeoutError::Timeout => {
            "chordsync sidecar response deadline exceeded".to_string()
        }
        mpsc::RecvTimeoutError::Disconnected => {
            "chordsync sidecar closed output stream".to_string()
        }
    })?
}

fn python_command() -> String {
    std::env::var("CHORDSYNC_PYTHON")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("KEY_ANALYZER_PYTHON")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "py".to_string()
            } else {
                "python3".to_string()
            }
        })
}

fn search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut push = |p: PathBuf| {
        if !roots.contains(&p) {
            roots.push(p);
        }
    };
    if let Ok(cwd) = std::env::current_dir() {
        push(cwd.join("src-tauri"));
        push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            push(exe_dir.to_path_buf());
            push(exe_dir.join("../Resources"));
            push(exe_dir.join("../.."));
        }
    }
    roots
}

fn sidecar_script() -> Option<PathBuf> {
    if let Ok(configured) = std::env::var("CHORDSYNC_SIDECAR") {
        let path = PathBuf::from(configured.trim());
        if path.is_file() {
            return Some(path);
        }
    }
    search_roots()
        .into_iter()
        .map(|root| {
            root.join("sidecars")
                .join("chordsync")
                .join("chordsync_sidecar.py")
        })
        .find(|path| path.is_file())
}

fn chordsync_package_root(script: &Path) -> PathBuf {
    if let Ok(configured) = std::env::var("CHORDSYNC_ROOT") {
        let path = PathBuf::from(configured.trim());
        if path.join("chordsync").join("__init__.py").is_file() {
            return path;
        }
    }
    if let Some(projects) = script.ancestors().nth(5) {
        let sibling = projects.join("ChordSync");
        if sibling.join("chordsync").join("__init__.py").is_file() {
            return sibling;
        }
    }
    script
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| script.to_path_buf())
}

fn venv_python(script: &Path) -> Option<PathBuf> {
    let root = script.parent()?;
    let unix = root.join(".venv").join("bin").join("python");
    if unix.is_file() {
        return Some(unix);
    }
    let windows = root.join(".venv").join("Scripts").join("python.exe");
    if windows.is_file() {
        return Some(windows);
    }
    // Dev layout: ChordSync companion sitting next to this repo, already has the deps.
    if let Some(projects) = script.ancestors().nth(5) {
        let sibling = projects.join("ChordSync").join(".venv");
        let unix = sibling.join("bin").join("python");
        if unix.is_file() {
            return Some(unix);
        }
        let windows = sibling.join("Scripts").join("python.exe");
        if windows.is_file() {
            return Some(windows);
        }
    }
    None
}

fn spawn_worker() -> Result<SidecarWorker, String> {
    let script =
        sidecar_script().ok_or_else(|| "chordsync sidecar script not found".to_string())?;
    let mut program = python_command();
    let mut args: Vec<String> = Vec::new();
    if let Some(venv) = venv_python(&script) {
        program = venv.to_string_lossy().to_string();
    } else if program.eq_ignore_ascii_case("py") {
        args.push("-3".to_string());
    }
    args.push(script.to_string_lossy().to_string());
    args.push("--serve".to_string());

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = script.parent() {
        let package_root = chordsync_package_root(&script);
        command.env("PYTHONPATH", &package_root);
        command.env("CHORDSYNC_ROOT", &package_root);
        command.current_dir(dir);
    }
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn chordsync sidecar ({program}): {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "chordsync sidecar stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "chordsync sidecar stdout unavailable".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                log::info!("chordsync sidecar: {line}");
            }
        });
    }
    let stdout_reader = stdout_lines(stdout);
    let ready = read_line(&stdout_reader, STARTUP_TIMEOUT)?;
    let parsed: serde_json::Value = serde_json::from_str(&ready)
        .map_err(|error| format!("chordsync sidecar ready line: {error}: {ready}"))?;
    if parsed.get("ready").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!("chordsync sidecar not ready: {ready}"));
    }
    log::info!("playalong: sidecar ready ({program} {})", script.display());
    Ok(SidecarWorker {
        _child: ManagedChild(child),
        stdin,
        stdout: stdout_reader,
    })
}

fn request_json(
    worker: &mut SidecarWorker,
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let encoded = serde_json::to_string(body).map_err(|error| error.to_string())?;
    worker
        .stdin
        .write_all(encoded.as_bytes())
        .and_then(|_| worker.stdin.write_all(b"\n"))
        .and_then(|_| worker.stdin.flush())
        .map_err(|error| format!("write chordsync sidecar: {error}"))?;
    let line = read_line(&worker.stdout, timeout)?;
    serde_json::from_str(&line).map_err(|error| format!("chordsync sidecar JSON: {error}: {line}"))
}

impl PlayAlongSidecar {
    fn resolve(&self, req: PlayAlongResolveRequest) -> Result<serde_json::Value, String> {
        let mut guard = self
            .worker
            .lock()
            .map_err(|_| "chordsync sidecar lock poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(spawn_worker()?);
        }
        let body = serde_json::json!({
            "op": "resolve",
            "title": req.title,
            "artist": req.artist,
            "album": req.album,
            "durationMs": req.duration_ms,
            "sourceApp": req.source_app,
            "gen": req.gen,
        });
        match request_json(
            guard.as_mut().expect("worker just spawned"),
            &body,
            RESOLVE_TIMEOUT,
        ) {
            Ok(value) => Ok(value),
            Err(error) => {
                *guard = None;
                Err(error)
            }
        }
    }

    fn follow(&self, req: PlayAlongFollowRequest) -> Result<serde_json::Value, String> {
        let mut guard = self
            .worker
            .lock()
            .map_err(|_| "chordsync sidecar lock poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(spawn_worker()?);
        }
        let body = serde_json::json!({
            "op": "follow",
            "title": req.title,
            "artist": req.artist,
            "album": req.album,
            "durationMs": req.duration_ms,
            "positionMs": req.position_ms,
            "sourceApp": req.source_app,
            "playbackStatus": req.playback_status,
            "playing": req.playing,
            "dev": req.dev,
        });
        match request_json(
            guard.as_mut().expect("worker just spawned"),
            &body,
            FOLLOW_TIMEOUT,
        ) {
            Ok(value) => Ok(value),
            Err(error) => {
                *guard = None;
                Err(error)
            }
        }
    }

    fn shutdown(&self) {
        if let Ok(mut guard) = self.worker.lock() {
            *guard = None;
        }
    }
}

static SIDECAR: OnceLock<PlayAlongSidecar> = OnceLock::new();

pub fn sidecar() -> &'static PlayAlongSidecar {
    SIDECAR.get_or_init(PlayAlongSidecar::default)
}

pub fn shutdown_playalong() {
    if let Some(existing) = SIDECAR.get() {
        existing.shutdown();
    }
}

#[tauri::command]
pub fn resolve_playalong(
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_ms: Option<i64>,
    source_app: Option<String>,
    gen: Option<i64>,
) -> Result<serde_json::Value, String> {
    sidecar().resolve(PlayAlongResolveRequest {
        title,
        artist,
        album,
        duration_ms,
        source_app,
        gen,
    })
}

#[tauri::command]
pub fn follow_playalong(
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_ms: Option<i64>,
    position_ms: Option<i64>,
    source_app: Option<String>,
    playback_status: Option<String>,
    playing: Option<bool>,
    dev: Option<bool>,
) -> Result<serde_json::Value, String> {
    sidecar().follow(PlayAlongFollowRequest {
        title,
        artist,
        album,
        duration_ms,
        position_ms,
        source_app,
        playback_status,
        playing,
        dev,
    })
}
