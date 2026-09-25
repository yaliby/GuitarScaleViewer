"""Shared error types."""

from __future__ import annotations


class ChordSyncError(Exception):
    """Base exception for recoverable application errors."""


class ProviderUnavailableError(ChordSyncError):
    """Raised when a provider is requested but not available."""


class ExternalServiceError(ChordSyncError):
    """Raised when a remote service (e.g. LRCLIB) fails."""


class DomAnalysisError(ChordSyncError):
    """Raised when DOM extraction/analysis fails in a recoverable way."""

