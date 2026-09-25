"""Unpack dbus_next Variant objects and leaked Variant repr strings.

MPRIS Properties.Get returns a Variant, and Metadata (`a{sv}`) stores every
field as another Variant. ``str(variant)`` looks like
``<dbus_next.signature.Variant ('s', Song Title)>`` which then poisons lyrics
lookup, Tab4U search, and LibreTranslate.
"""

from __future__ import annotations

import ast
import re
from collections.abc import Mapping
from typing import Any

_VARIANT_REPR_RE = re.compile(
    r"^<dbus_next\.signature\.Variant \('([^']*)',\s*(.*)\)>$"
)


def is_dbus_variant_object(value: Any) -> bool:
    if value is None or isinstance(value, (str, bytes, bytearray, int, float, bool)):
        return False
    return type(value).__name__ == "Variant" and hasattr(value, "value")


def unwrap_dbus(value: Any, *, _depth: int = 0) -> Any:
    """Turn nested dbus_next Variant wrappers into plain Python values."""
    if _depth > 12:
        return value
    if is_dbus_variant_object(value):
        return unwrap_dbus(value.value, _depth=_depth + 1)
    if isinstance(value, Mapping) and not isinstance(value, (str, bytes, bytearray)):
        return {
            str(unwrap_dbus(k, _depth=_depth + 1)): unwrap_dbus(v, _depth=_depth + 1)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [unwrap_dbus(v, _depth=_depth + 1) for v in value]
    if isinstance(value, tuple):
        return tuple(unwrap_dbus(v, _depth=_depth + 1) for v in value)
    return value


def strip_dbus_variant_text(text: str | None) -> str:
    """If ``text`` is a Variant repr, return the inner payload; otherwise return it unchanged."""
    if not text:
        return ""
    t = str(text).strip()
    seen: set[str] = set()
    for _ in range(4):
        if t in seen:
            break
        seen.add(t)
        m = _VARIANT_REPR_RE.fullmatch(t)
        if not m:
            break
        inner = (m.group(2) or "").strip()
        if not inner:
            return ""
        if inner.startswith("[") or inner.startswith("(") or inner.startswith("{") or inner[:1] in {"'", '"'}:
            try:
                parsed = ast.literal_eval(inner)
            except (SyntaxError, ValueError):
                t = inner
                continue
            extracted = _first_text(parsed)
            return extracted if extracted is not None else ""
        t = inner
    return t


def _first_text(value: Any) -> str | None:
    value = unwrap_dbus(value)
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except Exception:
            return None
    if isinstance(value, Mapping):
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            got = _first_text(item)
            if got:
                return got
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        text = strip_dbus_variant_text(str(value).strip())
        return text or None
    text = str(value).strip()
    if not text:
        return None
    recovered = strip_dbus_variant_text(text)
    return recovered or None


def plain_text(value: Any) -> str | None:
    """Best-effort string for MPRIS title/artist/album/trackid fields."""
    return _first_text(value)
