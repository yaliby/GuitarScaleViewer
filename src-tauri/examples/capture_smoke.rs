//! Explicit hardware smoke test: cargo run --example capture_smoke
//! Plays a quiet five-second tone and checks real Windows loopback.
//! --process exercises player discovery with endpoint fallback when Windows does
//! not expose a unique render session for SoundPlayer.
#![allow(dead_code)]
#[path = "../src/audio_models.rs"] mod audio_models;
#[path = "../src/audio_capture.rs"] mod audio_capture;

#[cfg(windows)]
fn main() {
    struct SmokeLogger;
    impl log::Log for SmokeLogger {
        fn enabled(&self, _: &log::Metadata) -> bool { true }
        fn log(&self, record: &log::Record) {
            if !record.args().to_string().contains("received audio peak") { eprintln!("{}", record.args()); }
        }
        fn flush(&self) {}
    }
    static LOGGER: SmokeLogger = SmokeLogger;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Debug);
    use std::{process::{Command, Stdio}, time::{Duration, Instant}};
    use std::os::windows::process::CommandExt;
    let wav = std::env::temp_dir().join(format!("fretboard-capture-smoke-{}.wav", std::process::id()));
    let mut writer = hound::WavWriter::create(&wav, hound::WavSpec {
        channels: 1, sample_rate: 44_100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int,
    }).unwrap();
    for index in 0..44_100 * 5 {
        let tone = (2.0 * std::f32::consts::PI * 440.0 * index as f32 / 44_100.0).sin();
        writer.write_sample((tone * 0.03 * i16::MAX as f32) as i16).unwrap();
    }
    writer.finalize().unwrap();
    let mut capture = audio_capture::AudioCaptureManager::new();
    let process_mode = std::env::args().any(|arg| arg == "--process");
    if !process_mode {
        capture.force_endpoint_fallback("explicit_hardware_smoke_test");
        std::thread::sleep(Duration::from_millis(300));
    }
    let mut player = Command::new("powershell.exe").args(["-NoProfile", "-Command",
        "$tone = New-Object System.Media.SoundPlayer $env:GSV_CAPTURE_TEST_WAV; $tone.Load(); [Console]::WriteLine('ready'); $tone.PlaySync()"])
        .env("GSV_CAPTURE_TEST_WAV", &wav).stdin(Stdio::null()).stdout(Stdio::piped())
        .stderr(Stdio::piped()).creation_flags(0x08000000).spawn().unwrap();
    if process_mode {
        // Discover the PowerShell process that is actually playing, among the
        // shell/editor helper processes. Exercise discovery on this fresh thread.
        use std::io::BufRead;
        let mut ready = String::new();
        std::io::BufReader::new(player.stdout.take().unwrap()).read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "ready", "Test player did not load its sound");
        std::thread::sleep(Duration::from_millis(400));
        capture.ensure_capture_running_for_target(Some("powershell.exe".into()));
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        capture.poll_capture_samples();
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = player.kill();
    let _ = player.wait();
    let samples = capture.latest_samples(5);
    let peak = samples.iter().map(|value| value.abs()).fold(0.0_f32, f32::max);
    println!("mode={:?} samples={} sample_rate={} peak={:.6}",
        capture.snapshot().capture_mode, samples.len(), capture.sample_rate_hz(), peak);
    // Both process capture and its documented endpoint fallback are valid here.
    // The contract is capturing the player's audible samples, not forcing a
    // process session that Windows may group with system sounds.
    capture.stop_capture("hardware_smoke_complete");
    let _ = std::fs::remove_file(wav);
    assert!(samples.len() > 44_100, "Loopback did not receive a second of audio");
    assert!(peak > 0.001, "Loopback received only silence; check output device or volume");
}

#[cfg(not(windows))]
fn main() { panic!("This smoke test requires Windows"); }
