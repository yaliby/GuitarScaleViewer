"""Reject search-result URLs that are site hubs / category roots, not concrete song pages."""

from __future__ import annotations

from urllib.parse import urlparse


def is_degenerate_chord_hub_url(url: str) -> bool:
    """
    True if the URL is a generic landing/category page we should never load as a chord source.

    Examples that must return True:
    - https://www.ultimate-guitar.com/chords
    - https://www.ultimate-guitar.com/chords/foo (still not a full song sheet path)
    """
    try:
        p = urlparse(url)
        host = (p.netloc or "").lower()
        path = (p.path or "").strip("/")
        segs = [s for s in path.split("/") if s]
    except Exception:
        return True

    if not host:
        return True

    # Ultimate Guitar: DDG often surfaces https://www.ultimate-guitar.com/chords (hub → Access denied in WebView).
    # www host: need a full song path (typically 3+ segments). tabs subdomain often uses /tab/... with 2+ segments.
    if host.endswith("ultimate-guitar.com"):
        if host == "tabs.ultimate-guitar.com" or host.startswith("tabs."):
            return len(segs) < 2
        return len(segs) < 3

    if host.endswith("e-chords.com") or host.endswith("azchords.com"):
        return len(segs) < 2

    # Hebrew portals: require a concrete song path, not the homepage/search hub.
    if host.endswith("tab4u.com"):
        leaf = segs[-1].lower() if segs else ""
        if not segs or leaf in {"index.html", "index2.html", "index.php"}:
            return True
        if segs[0].lower() in {"results", "resultssimple", "search"}:
            return True
        return False
    if host.endswith("nagnu.co.il") or host.endswith("negina.co.il"):
        return len(segs) < 1

    return False
