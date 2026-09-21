mod audio_capture;
/// Public for the same reason as `key_engine`: the accuracy harness replays a growing capture
/// buffer through the real decision path, which means it has to hold the real window type.
pub mod audio_models;
/// Public so the harness analyzes audio with the *shipped* detector. A second implementation of
/// "call the CLI and read its JSON" is a second thing to keep in step, and the one it would
/// diverge from is the one that ships.
pub mod key_detection;
/// Public so the accuracy harness (`tests/key_accuracy_scoreboard.rs`) scores the *shipped*
/// tonic-evidence gate rather than a copy of it that can drift away from the real one.
pub mod key_engine;
pub mod key_reranker;
mod media_session;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Dedicated log file that resets on every run.
            {
                use tauri::Manager;
                use tauri_plugin_log::{Target, TargetKind};
                let configured_dir = std::env::var("GSV_LOG_DIR")
                    .ok()
                    .map(std::path::PathBuf::from);
                let log_dir = if let Some(dir) = configured_dir {
                    dir
                } else {
                    app.path()
                        .app_log_dir()
                        .map_err(|e| format!("resolve app_log_dir: {e}"))?
                };
                std::fs::create_dir_all(&log_dir).ok();
                let log_file = log_dir.join("gsv-dev.log");
                let _ = std::fs::remove_file(&log_file);

                app.handle().plugin(
                    tauri_plugin_log::Builder::new()
                        // Capture everything into one growing file for the whole run.
                        .level(log::LevelFilter::Debug)
                        // Keep a single file during the run; set a very high cap to avoid mid-run discard/rotation.
                        .max_file_size(1024 * 1024 * 1024) // 1GB
                        .targets([
                            Target::new(TargetKind::Stdout),
                            Target::new(TargetKind::Folder {
                                path: log_dir.clone(),
                                file_name: Some("gsv-dev.log".to_string()),
                            }),
                        ])
                        .build(),
                )?;

                log::info!(
                    "gsv: rust backend starting; log='{}' os={} arch={}",
                    log_file.display(),
                    std::env::consts::OS,
                    std::env::consts::ARCH
                );
            }
            // Both pollers gate on the supported platforms internally (Windows
            // via WASAPI/GSMTC, Linux via PulseAudio/MPRIS), so call them
            // unconditionally rather than re-gating on Windows only.
            media_session::spawn_media_session_poller(app.handle().clone());
            key_engine::spawn_key_engine(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            media_session::get_current_media,
            media_session::get_media_sessions_debug,
            key_engine::get_detected_key,
            key_engine::reset_detected_key,
            key_engine::set_cloud_resolution,
            key_engine::get_cloud_resolution
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                key_engine::shutdown_key_engine();
            }
        });
}
