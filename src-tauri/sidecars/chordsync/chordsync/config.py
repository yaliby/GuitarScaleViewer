"""Application configuration.

Configuration is sourced from environment variables (and optionally a .env file
loaded by the user). Keep this importable without initializing any UI objects.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CHORDSYNC_",
        case_sensitive=False,
    )

    app_name: str = "ChordSync Companion"
    data_dir: Path = Field(default_factory=lambda: Path.home() / ".chordsync_companion")
    db_path: Path | None = None

    log_level: str = "INFO"
    log_json: bool = False
    log_to_file: bool = True
    log_file_name: str = "chordsync.log"
    log_file_max_bytes: int = 5_000_000
    log_file_backup_count: int = 3

    # Metadata
    metadata_poll_interval_ms: int = 750
    metadata_debounce_ms: int = 0
    metadata_stale_after_ms: int = 5000

    # Sync loop (metadata position vs timed lyrics)
    # Keep low but non-zero to avoid busy-spinning CPU.
    sync_loop_interval_ms: int = 10
    render_fps: int = 60
    metadata_holdover_ms: int = 1200

    # Time engine tuning (Windows GSMTC)
    time_tiny_drift_ignore_ms: int = 40
    time_small_drift_ms: int = 250
    time_medium_drift_ms: int = 800
    time_jump_threshold_ms: int = 1500

    # DisplayClock correction tuning
    display_clock_max_offset_change_ms_per_s: float = 3000.0
    display_clock_tiny_tau_ms: float = 2000.0
    display_clock_small_tau_ms: float = 220.0
    display_clock_medium_tau_ms: float = 450.0

    # Lyric synchronizer: unused leftover knobs (line pick is player time vs LRC only).
    lyric_line_switch_guard_ms: int = 0
    lyric_line_anti_jitter_ms: int = 0
    lyric_future_offset_ms: int = 0

    # Open chords pages in an external Brave browser to leverage native adblocking.
    # Note: in this mode, our embedded DOM marking/scrolling won't work because the page isn't
    # loaded into the Qt WebEngine view.
    open_chords_in_external_brave: bool = False

    # Generic remote provider
    remote_http_host: str = "127.0.0.1"
    remote_http_port: int = 18765
    remote_ws_path: str = "/ws"
    remote_http_path: str = "/now-playing"

    # LRCLIB
    lrclib_base_url: str = "https://lrclib.net"
    lrclib_timeout_s: float = 8.0
    lrclib_retries: int = 2

    # Browser/search: Hebrew mode when enable_hebrew_queries and (preferred_language starts with `he` OR title/artist/album contain Hebrew script); otherwise English-only sites + `chords` queries.
    preferred_language: str = "en"
    enable_hebrew_queries: bool = True
    # When Hebrew search mode sees mixed Hebrew + Latin, translate Latin fields via LibreTranslate HTTP API (real MT, not local maps).
    chord_search_translate_to_he: bool = True
    libretranslate_base_url: str = "https://libretranslate.com"
    libretranslate_api_key: str | None = None
    libretranslate_timeout_s: float = 12.0
    libretranslate_retries: int = 2
    # If DDG returns no Hebrew chord domains, allow best English chord result as last resort.
    chord_search_allow_english_fallback: bool = True
    # Fetch top HTML candidates and score chord+lyrics structure before final pick.
    chord_search_verify_pages: bool = True
    chord_search_max_verify_candidates: int = 4
    chord_search_verify_timeout_s: float = 8.0

    # Live lyrics: when a song has no synced LRC and no YouTube captions, listen to
    # what the speakers play and transcribe it with Whisper (faster-whisper).
    live_lyrics_enabled: bool = True
    live_lyrics_model: str = "deepdml/faster-whisper-large-v3-turbo-ct2"
    live_lyrics_model_he: str = "ivrit-ai/whisper-large-v3-turbo-ct2"
    live_lyrics_device: str = "auto"  # auto | cuda | cpu
    live_lyrics_compute_type: str = "auto"  # auto: float16 on the GPU, int8 on the CPU
    live_lyrics_beam_size: int = 5
    # Seconds of new audio before the next Whisper pass over the buffer.
    live_lyrics_step_s: float = 1.0
    # Unload the Whisper models after this long without a song to transcribe.
    live_lyrics_idle_unload_s: float = 900.0

    def resolved_db_path(self) -> Path:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.db_path or (self.data_dir / "chordsync.sqlite3")


def load_config() -> AppConfig:
    cfg = AppConfig()
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return cfg

