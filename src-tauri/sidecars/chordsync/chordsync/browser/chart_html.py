"""Sculpt a Halturaz-style chart document from scraped {c,t} segments.

The original Tab4U/UG page is only clay. This HTML is the working surface:
Hebrew lines ``dir=rtl``, English ``dir=ltr``, chords stacked in ``.chord-seg``,
and ``data-line`` indices the companion can highlight and follow.
"""

from __future__ import annotations

import html
import re

from chordsync.browser.text_match import has_hebrew
from chordsync.core.chart import (
    ChartLine,
    ScrapedChart,
    chart_is_hebrew,
    chart_key,
    chart_lyric_lines,
)
from chordsync.live.transcript import LIVE_LYRICS_SOURCE

_SHARP = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_ALIAS = {
    "Db": "C#",
    "Eb": "D#",
    "Gb": "F#",
    "Ab": "G#",
    "Bb": "A#",
    "Cb": "B",
    "Fb": "E",
    "E#": "F",
    "B#": "C",
}
_ROOT_RE = re.compile(r"^([A-G][#b]?)")

_CSS = """
:root {
  color-scheme: dark;
  --bg: #0e0d0c;
  --ink: #e8e2db;
  --dim: #8d857c;
  --accent: #f1a252;
  --hue-lc: 0.785 0.108;
  --line-gap: 18px;
  --chord-size: 15px;
  --lyric-size: 24px;
  --chord-row: 22px;
  --mono: "JetBrains Mono", "Noto Sans Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: "Noto Sans Hebrew", "Noto Sans", "Segoe UI", system-ui, sans-serif;
}
body { padding: 28px 36px 72px; }
.chart-head { margin: 0 0 28px; }
.chart-head .source {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--accent);
  text-transform: uppercase;
}
.chart-head .source .key { text-transform: none; }
.chart-head h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  unicode-bidi: plaintext;
}
.chart-head .meta {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--dim);
  unicode-bidi: plaintext;
}
.section { margin: 0 0 14px; }
.section-label {
  margin: 28px 0 14px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  unicode-bidi: isolate;
}
.line {
  margin: 0 0 var(--line-gap);
  unicode-bidi: isolate;
  padding: 8px 12px;
  border-radius: 10px;
  position: relative;
  background: transparent;
  box-shadow: inset 0 0 0 1px transparent;
  transform: scale(1);
  transform-origin: inline-start center;
  transition:
    background-color 280ms ease,
    box-shadow 320ms ease,
    transform 380ms cubic-bezier(0.22, 1, 0.36, 1);
}
.line.chords-only { margin-bottom: calc(var(--line-gap) * 0.6); }
.line.is-active {
  background: rgba(241, 162, 82, 0.20);
  box-shadow:
    inset 0 0 0 1px rgba(241, 162, 82, 0.48),
    0 10px 28px rgba(241, 162, 82, 0.12);
  transform: scale(1.018);
  animation: cs-line-pulse 620ms cubic-bezier(0.22, 1, 0.36, 1);
}
.line.is-active::before {
  content: "";
  position: absolute;
  inset-block: 10px;
  inset-inline-start: 0;
  width: 3px;
  border-radius: 3px;
  background: var(--accent);
  transform-origin: center top;
  animation: cs-accent-in 380ms cubic-bezier(0.22, 1, 0.36, 1);
}
.line.is-leaving {
  background: rgba(241, 162, 82, 0.07);
  box-shadow: inset 0 0 0 1px rgba(241, 162, 82, 0.12);
}
@keyframes cs-accent-in {
  from { transform: scaleY(0.15); opacity: 0; }
  to { transform: scaleY(1); opacity: 1; }
}
@keyframes cs-line-pulse {
  0% { box-shadow: inset 0 0 0 1px rgba(241, 162, 82, 0.48), 0 0 0 0 rgba(241, 162, 82, 0.28); }
  100% { box-shadow: inset 0 0 0 1px rgba(241, 162, 82, 0.48), 0 10px 28px rgba(241, 162, 82, 0.12); }
}
.chord-seg { display: inline-block; vertical-align: bottom; }
.chord-seg .c {
  display: block;
  direction: ltr;
  unicode-bidi: isolate;
  font-family: var(--mono);
  font-size: var(--chord-size);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: oklch(var(--hue-lc) var(--h, 62));
  height: var(--chord-row);
  line-height: var(--chord-row);
  padding-inline-end: 0.7em;
}
[dir='rtl'] .chord-seg .c { text-align: right; padding-inline: 0.7em 0; }
.chord-seg .t {
  display: block;
  white-space: pre;
  font-size: var(--lyric-size);
  line-height: 1.4;
  color: var(--ink);
  letter-spacing: -0.008em;
  unicode-bidi: plaintext;
}
.chord-seg .t:empty::after { content: '\\200b'; }
.line.chords-only .chord-seg .t { display: none; }
.line.chords-only .chord-seg .c {
  font-size: calc(var(--chord-size) * 1.25);
  height: calc(var(--chord-row) * 1.4);
  line-height: calc(var(--chord-row) * 1.4);
  padding-inline-end: 1.7em;
}
.empty { color: var(--dim); font-size: 18px; unicode-bidi: plaintext; }
a.src { color: var(--dim); text-decoration: none; }
a.src:hover { color: var(--accent); }
"""

_JS = """
function csEase(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function csScrollToCenter(el, duration) {
  var scroller = document.scrollingElement || document.documentElement;
  var rect = el.getBoundingClientRect();
  var start = scroller.scrollTop;
  var target = start + rect.top - (window.innerHeight / 2) + (rect.height / 2);
  var max = Math.max(0, scroller.scrollHeight - window.innerHeight);
  target = Math.max(0, Math.min(target, max));
  if (Math.abs(target - start) < 6) return;
  if (window.__csScrollRaf) cancelAnimationFrame(window.__csScrollRaf);
  var t0 = performance.now();
  function step(now) {
    var p = Math.min(1, (now - t0) / duration);
    scroller.scrollTop = start + (target - start) * csEase(p);
    if (p < 1) window.__csScrollRaf = requestAnimationFrame(step);
  }
  window.__csScrollRaf = requestAnimationFrame(step);
}
window.scrollToChartLine = function(i) {
  var nextId = (i == null || i < 0) ? -1 : Number(i);
  document.querySelectorAll('.line.is-leaving').forEach(function(el) {
    el.classList.remove('is-leaving');
  });
  document.querySelectorAll('.line.is-active').forEach(function(el) {
    el.classList.remove('is-active');
    var cur = el.getAttribute('data-line');
    if (cur != null && Number(cur) !== nextId) {
      el.classList.add('is-leaving');
      setTimeout(function() { el.classList.remove('is-leaving'); }, 360);
    }
  });
  window.__csActive = nextId;
  if (nextId < 0) return false;
  var el = document.querySelector('.line[data-line="' + String(nextId) + '"]');
  if (!el) return false;
  el.classList.add('is-active');
  csScrollToCenter(el, 520);
  return true;
};
"""


_LIVE_CSS = """
.live-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-inline-end: 8px;
  border-radius: 50%;
  background: #ef4444;
  vertical-align: 1px;
  animation: cs-live-dot 1.6s ease-in-out infinite;
}
@keyframes cs-live-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.8); }
}
.line.live .t {
  display: block;
  font-size: var(--lyric-size);
  line-height: 1.4;
  color: var(--ink);
  unicode-bidi: plaintext;
  white-space: pre-wrap;
  transition: color 260ms ease;
}
.line.live.tentative .t { color: var(--dim); }
"""

# Lines are pushed as they are heard; the page is never reloaded (no flicker).
_LIVE_JS = """
window.csLiveSync = function(lines) {
  var host = document.getElementById('cs-live');
  if (!host) return false;
  var empty = document.getElementById('cs-live-empty');
  if (empty) empty.style.display = lines.length ? 'none' : '';
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var el = host.children[i];
    if (!el) {
      el = document.createElement('p');
      el.className = 'line live';
      el.setAttribute('data-line', String(i));
      var t = document.createElement('span');
      t.className = 't';
      el.appendChild(t);
      host.appendChild(el);
    }
    if (el.__csText !== ln.t) {
      el.firstChild.textContent = ln.t;
      el.__csText = ln.t;
    }
    var dir = ln.rtl ? 'rtl' : 'ltr';
    if (el.getAttribute('dir') !== dir) {
      el.setAttribute('dir', dir);
      el.setAttribute('lang', ln.rtl ? 'he' : 'en');
    }
    el.classList.toggle('tentative', !ln.final);
  }
  while (host.children.length > lines.length) host.removeChild(host.lastChild);
  var last = lines.length - 1;
  if (last < 0) return window.scrollToChartLine(-1);
  var cur = host.children[last];
  if (window.__csActive !== last || !cur.classList.contains('is-active')) {
    return window.scrollToChartLine(last);
  }
  csScrollToCenter(cur, 360);
  return true;
};
"""


def render_live_html(*, title: str | None, artist: str | None) -> str:
    """Empty live-transcript page; ``window.csLiveSync(lines)`` fills it in place."""
    hebrew = has_hebrew(title) or has_hebrew(artist)
    page_dir = "rtl" if hebrew else "ltr"
    page_lang = "he" if hebrew else "en"
    meta = " · ".join(bit for bit in (artist or "", "מקשיב לשיר ומתמלל בזמן אמת") if bit)
    return (
        "<!DOCTYPE html>"
        f"<html lang='{page_lang}' dir='{page_dir}'>"
        "<head><meta charset='utf-8'>"
        f"<title>{_esc(title or LIVE_LYRICS_SOURCE)}</title>"
        f"<style>{_CSS}{_LIVE_CSS}</style></head><body>"
        f'<header class="chart-head" dir="{page_dir}" lang="{page_lang}">'
        f'<p class="source"><span class="live-dot"></span>{_esc(LIVE_LYRICS_SOURCE)}</p>'
        f"<h1>{_esc(title or 'Live lyrics')}</h1>"
        f'<p class="meta">{_esc(meta)}</p>'
        "</header>"
        '<p class="empty" id="cs-live-empty">מקשיב לשיר… המילים יופיעו כאן ברגע שיישמעו.</p>'
        '<section class="section" id="cs-live"></section>'
        f"<script>{_JS}{_LIVE_JS}</script></body></html>"
    )


def _pitch_class(name: str) -> int:
    m = _ROOT_RE.match(name or "")
    if not m:
        return -1
    root = _ALIAS.get(m.group(1), m.group(1))
    try:
        return _SHARP.index(root)
    except ValueError:
        return -1


def _chord_hue(name: str | None) -> int | None:
    pc = _pitch_class(name or "")
    if pc < 0:
        return None
    return (40 + pc * 30) % 360


def _esc(text: str | None) -> str:
    return html.escape(text or "", quote=True)


def _render_line(line: ChartLine, lyric_index: int | None) -> str:
    direction = "rtl" if line.rtl else "ltr"
    lang = "he" if line.rtl else "en"
    classes = "line"
    if line.chords_only:
        classes += " chords-only"
    data = f' data-line="{lyric_index}"' if lyric_index is not None else ""
    parts: list[str] = []
    for seg in line.segs:
        hue = _chord_hue(seg.c)
        style = f' style="--h: {hue}"' if hue is not None else ""
        chord = _esc(seg.c) if seg.c else "&nbsp;"
        text = _esc(seg.t)
        parts.append(
            f'<span class="chord-seg"><span class="c"{style}>{chord}</span>'
            f'<span class="t">{text}</span></span>'
        )
    inner = "".join(parts)
    return f'<p class="{classes}" dir="{direction}" lang="{lang}"{data}>{inner}</p>'


def render_chart_html(chart: ScrapedChart | None, *, empty_message: str | None = None) -> str:
    """Full HTML document. Empty chart → waiting page, or ``empty_message`` when set."""
    if chart is None:
        message = _esc(empty_message) if empty_message else "מחכים לצ׳ארט מ־Tab4U / Ultimate Guitar…"
        return (
            "<!DOCTYPE html><html lang='he' dir='rtl'><head><meta charset='utf-8'>"
            f"<style>{_CSS}</style></head><body>"
            f"<p class='empty'>{message}</p>"
            f"<script>{_JS}</script></body></html>"
        )

    hebrew = chart_is_hebrew(chart)
    page_dir = "rtl" if hebrew else "ltr"
    page_lang = "he" if hebrew else "en"
    title = chart.title or "Chord chart"
    artist = chart.artist or ""
    src = chart.source.replace("_", " ")
    song_key = chart_key(chart)
    key = f" · סולם {song_key}" if song_key else ""
    n_lines = len(chart_lyric_lines(chart))
    meta_bits = [f"{src}{key}", f"{n_lines} lines"]
    if artist:
        meta_bits.insert(0, artist)
    meta = " · ".join(meta_bits)
    src_link = ""
    if chart.source_url:
        src_link = f' <a class="src" href="{_esc(chart.source_url)}">source</a>'

    body: list[str] = [
        f'<header class="chart-head" dir="{page_dir}" lang="{page_lang}">',
        f'<p class="source">{_esc(src)}<span class="key">{_esc(key)}</span></p>',
        f"<h1>{_esc(title)}</h1>",
        f'<p class="meta">{_esc(meta)}{src_link}</p>',
        "</header>",
    ]

    lyric_i = 0
    for sec in chart.sections:
        label_dir = "rtl" if has_hebrew(sec.label) else "ltr"
        body.append('<section class="section">')
        if sec.label:
            body.append(
                f'<h2 class="section-label" dir="{label_dir}">{_esc(sec.label)}</h2>'
            )
        for line in sec.lines:
            idx = None if line.chords_only else lyric_i
            body.append(_render_line(line, idx))
            if idx is not None:
                lyric_i += 1
        body.append("</section>")

    return (
        "<!DOCTYPE html>"
        f"<html lang='{page_lang}' dir='{page_dir}'>"
        "<head><meta charset='utf-8'>"
        f"<title>{_esc(title)}</title>"
        f"<style>{_CSS}</style></head><body>"
        f"{''.join(body)}"
        f"<script>{_JS}</script></body></html>"
    )
