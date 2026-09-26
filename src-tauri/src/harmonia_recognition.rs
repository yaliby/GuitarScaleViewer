//! Harmonia whole-song recognition, isolated from capture and playback.
//! Only bounded mono PCM crosses IPC. No frontend paths or model downloads.

use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{watch, Semaphore},
};

const MAX_PCM: usize = 22050 * 1200 * 4;
const MAX_RESPONSE: usize = 16 * 1024 * 1024 + 1;
const MAX_STDERR: usize = 4096;
const UNAVAILABLE: &str =
    "Whole-song recognition is unavailable. Check the local recognition runtime.";

fn venv_python(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("ml/.venv/Scripts/python.exe")
    } else {
        root.join("ml/.venv/bin/python")
    }
}

fn gsv_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn python_candidates(root: &Path) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(over) = std::env::var_os("HARMONIA_RECOGNITION_PYTHON") {
        list.push(PathBuf::from(over));
    }
    list.push(venv_python(root));
    let sibling = gsv_root().join("../Harmonia");
    list.push(venv_python(&sibling));
    list
}

fn harmonia_roots() -> Vec<PathBuf> {
    let gsv = gsv_root();
    let mut roots = Vec::new();
    if let Some(over) = std::env::var_os("HARMONIA_ROOT") {
        roots.push(PathBuf::from(over));
    }
    roots.push(gsv.join("harmonia"));
    roots.push(gsv.join("../Harmonia"));
    roots
}

fn resolve_runtime() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    for root in harmonia_roots() {
        let script = root.join("scripts/native-whole-song.py");
        if !script.is_file() {
            continue;
        }
        for python in python_candidates(&root) {
            if python.is_file() {
                return Ok((root, python, script));
            }
        }
    }
    Err(UNAVAILABLE.into())
}

pub fn runtime_available() -> bool {
    resolve_runtime().is_ok()
}

pub fn validate_pcm(bytes: &[u8]) -> Result<usize, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_PCM || bytes.len() % 4 != 0 {
        return Err("Invalid whole-song PCM size");
    }
    if bytes.chunks_exact(4).any(|chunk| {
        let sample = [chunk[0], chunk[1], chunk[2], chunk[3]];
        !f32::from_le_bytes(sample).is_finite()
    }) {
        return Err("Invalid whole-song PCM samples");
    }
    Ok(bytes.len() / 4)
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

#[derive(Default)]
struct Requests {
    active: HashMap<String, watch::Sender<bool>>,
    cancelled: VecDeque<String>,
}

pub struct RecognitionService {
    gate: Semaphore,
    requests: Mutex<Requests>,
}

impl Default for RecognitionService {
    fn default() -> Self {
        Self {
            gate: Semaphore::new(1),
            requests: Mutex::new(Requests::default()),
        }
    }
}

impl RecognitionService {
    pub fn cancel(&self, id: &str) {
        if !valid_request_id(id) {
            return;
        }
        if let Ok(mut requests) = self.requests.lock() {
            if let Some(sender) = requests.active.get(id) {
                let _ = sender.send(true);
            }
            if requests.cancelled.len() >= 32 {
                requests.cancelled.pop_front();
            }
            requests.cancelled.push_back(id.into());
        }
    }

    pub async fn recognize(&self, id: &str, bytes: Vec<u8>) -> Result<Value, String> {
        if !valid_request_id(id) {
            return Err("Invalid recognition request".into());
        }
        if bytes.len() > MAX_PCM {
            return Err("Recording exceeds recognition bounds".into());
        }
        let mut receiver = {
            let mut requests = self.requests.lock().map_err(|_| UNAVAILABLE)?;
            if requests.cancelled.iter().any(|s| s == id) {
                return Err("Recognition cancelled".into());
            }
            if requests.active.len() >= 2 || requests.active.contains_key(id) {
                return Err("Recognition is busy".into());
            }
            let (sender, receiver) = watch::channel(false);
            requests.active.insert(id.into(), sender);
            receiver
        };
        let result = tokio::select! {
            _ = receiver.changed() => Err("Recognition cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(240), self.run(bytes)) =>
                result.unwrap_or_else(|_| Err("Whole-song recognition timed out".into())),
        };
        if let Ok(mut requests) = self.requests.lock() {
            requests.active.remove(id);
        }
        result
    }

    async fn run(&self, bytes: Vec<u8>) -> Result<Value, String> {
        let _permit = self.gate.acquire().await.map_err(|_| UNAVAILABLE)?;
        let (bytes, samples) =
            tauri::async_runtime::spawn_blocking(move || validate_pcm(&bytes).map(|n| (bytes, n)))
                .await
                .map_err(|_| UNAVAILABLE)??;
        let (root, python, script) = resolve_runtime()?;
        let mut command = tokio::process::Command::new(python);
        command
            .arg("-I")
            .arg(script)
            .arg("--samples")
            .arg(samples.to_string())
            .current_dir(root.join("ml"))
            .env("OMP_NUM_THREADS", "2")
            .env("MKL_NUM_THREADS", "2")
            .env("OPENBLAS_NUM_THREADS", "2")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let child = command.spawn().map_err(|_| UNAVAILABLE)?;
        let output = exchange_pcm(child, &bytes).await?;
        let result: Value =
            serde_json::from_slice(&output).map_err(|_| "Invalid recognition response")?;
        if result.get("schemaVersion").and_then(Value::as_u64) != Some(1)
            || result.get("sampleCount").and_then(Value::as_u64) != Some(samples as u64)
        {
            return Err("Recognition input identity mismatch".into());
        }
        Ok(result)
    }
}

fn recognition_failure(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    for line in text.lines() {
        let Some(message) = line.split("RuntimeError: ").nth(1) else {
            continue;
        };
        let message = message.trim();
        if message.len() <= 240
            && message.is_ascii()
            && (message.contains("GiB free for this recording")
                || message.contains("keep the system responsive"))
        {
            return message.to_string();
        }
    }
    UNAVAILABLE.into()
}

async fn exchange_pcm(mut child: tokio::process::Child, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut input = child.stdin.take().ok_or(UNAVAILABLE)?;
    let output = child.stdout.take().ok_or(UNAVAILABLE)?;
    let stderr = child.stderr.take();
    let send = async move {
        input.write_all(bytes).await?;
        input.flush().await?;
        drop(input);
        Ok::<_, std::io::Error>(())
    };
    let receive = async {
        let mut buffer = Vec::new();
        output
            .take((MAX_RESPONSE + 1) as u64)
            .read_to_end(&mut buffer)
            .await?;
        Ok::<_, std::io::Error>(buffer)
    };
    let receive_err = async {
        let mut buffer = Vec::new();
        if let Some(err) = stderr {
            err.take((MAX_STDERR + 1) as u64)
                .read_to_end(&mut buffer)
                .await?;
        }
        Ok::<_, std::io::Error>(buffer)
    };
    let (_, output, err) = tokio::try_join!(send, receive, receive_err).map_err(|_| UNAVAILABLE)?;
    if output.len() > MAX_RESPONSE {
        return Err("Recognition response exceeds bounds".into());
    }
    if !child.wait().await.map_err(|_| UNAVAILABLE)?.success() {
        return Err(recognition_failure(&err));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{recognition_failure, UNAVAILABLE};

    #[test]
    fn ram_headroom_failure_is_reported_instead_of_a_generic_unavailable_message() {
        let stderr = b"Whole-song recognition failed: RuntimeError: Native recognition needs 1.7 GiB free for this recording; 0.9 GiB is available. Close other apps and try again.\n";
        let error = recognition_failure(stderr);
        assert!(error.contains("GiB free for this recording"));
    }

    #[test]
    fn unrelated_recognizer_stderr_stays_generic() {
        assert_eq!(
            recognition_failure(b"Whole-song recognition failed: RuntimeError: model exploded\n"),
            UNAVAILABLE
        );
    }
}

#[tauri::command]
pub fn recognition_available() -> bool {
    runtime_available()
}

#[tauri::command]
pub async fn recognition_run(
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, Arc<RecognitionService>>,
) -> Result<Value, String> {
    let id = request
        .headers()
        .get("x-harmonia-request-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing recognition ID")?
        .to_owned();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected binary PCM".into());
    };
    if bytes.len() > MAX_PCM {
        return Err("Recording exceeds recognition bounds".into());
    }
    state.recognize(&id, bytes.clone()).await
}

#[tauri::command]
pub fn recognition_cancel(
    request_id: String,
    state: tauri::State<'_, Arc<RecognitionService>>,
) {
    state.cancel(&request_id);
}
