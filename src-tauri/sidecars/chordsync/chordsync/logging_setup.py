"""Logging configuration for the app."""

from __future__ import annotations

import logging
import logging.handlers
import sys
from typing import Any

import structlog

from chordsync.config import AppConfig


def configure_logging(cfg: AppConfig) -> None:
    level = getattr(logging, cfg.log_level.upper(), logging.INFO)

    # On Windows, the default console encoding may not support Hebrew/Unicode.
    # Make logs resilient rather than crashing the app.
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[attr-defined]
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[attr-defined]
    except Exception:
        pass

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()

    pre_chain: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]

    renderer = structlog.processors.JSONRenderer() if cfg.log_json else structlog.dev.ConsoleRenderer(colors=True)

    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=pre_chain,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
    )

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(level)
    console.setFormatter(formatter)
    root.addHandler(console)

    if cfg.log_to_file:
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        file_path = cfg.data_dir / cfg.log_file_name
        fh = logging.handlers.RotatingFileHandler(
            file_path,
            maxBytes=int(cfg.log_file_max_bytes),
            backupCount=int(cfg.log_file_backup_count),
            encoding="utf-8",
        )
        fh.setLevel(level)
        # File logs should be readable even when console uses colors.
        file_formatter = structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=pre_chain,
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                structlog.processors.StackInfoRenderer(),
                structlog.processors.format_exc_info,
                structlog.processors.JSONRenderer(),
            ],
        )
        fh.setFormatter(file_formatter)
        root.addHandler(fh)

    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    # Reduce noisy logs unless explicitly enabled.
    logging.getLogger("httpx").setLevel(max(level, logging.WARNING))

