"""Search -> rank -> pick -> navigate policy."""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse

import httpx
import structlog
from bs4 import BeautifulSoup

from chordsync.browser.result_ranker import RankedResult, rank_results
from chordsync.browser.tab4u_search import search_tab4u
from chordsync.browser.text_match import has_hebrew, search_title
from chordsync.browser.trusted_sources import (
    default_english_trusted_sources,
    is_hebrew_chord_search_mode,
    is_hebrew_trusted_chord_domain,
    trusted_sources_for_search,
    trusted_domain_weight,
    trusted_source_priority,
)
from chordsync.browser.ug_search import search_ultimate_guitar
from chordsync.core.models import CanonicalTrack, PlannedChordQuery, SearchCandidate, UrlStr
from chordsync.core.resolution_models import planned_query_to_dict
from chordsync.resolution.page_verifier import verify_chord_page
from chordsync.resolution.query_planner import plan_chord_queries
from chordsync.resolution.representations import build_song_search_representations

log = structlog.get_logger(__name__)

# Browser-like headers reduce empty/blocked HTML from DuckDuckGo and improve result quality.
_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
}

_DDG_URL = "https://html.duckduckgo.com/html/"


def _extract_ddg_results(html: str) -> list[SearchCandidate]:
    soup = BeautifulSoup(html, "lxml")
    out: list[SearchCandidate] = []
    for a in soup.select("a.result__a"):
        href = a.get("href") or ""
        title = a.get_text(" ", strip=True) or None
        snippet_el = a.find_parent("div", class_=re.compile(r"\bresult\b"))
        snippet = None
        if snippet_el:
            sn = snippet_el.select_one(".result__snippet")
            if sn:
                snippet = sn.get_text(" ", strip=True) or None
        final_url: str | None = None
        if href.startswith("http"):
            # Sometimes DDG already provides an absolute redirect URL.
            try:
                p = urlparse(href)
                if p.netloc.endswith("duckduckgo.com") and p.path.startswith("/l/"):
                    qs = parse_qs(p.query)
                    uddg = qs.get("uddg", [None])[0]
                    final_url = unquote(uddg) if uddg else href
                else:
                    final_url = href
            except Exception:
                final_url = href
        elif href.startswith("//"):
            final_url = "https:" + href
        elif href.startswith("/l/"):
            # DuckDuckGo uses redirect links with `uddg` query param containing the real URL.
            try:
                qs = parse_qs(urlparse(href).query)
                uddg = qs.get("uddg", [None])[0]
                if uddg:
                    final_url = unquote(uddg)
            except Exception:
                final_url = None
        elif href.startswith("/"):
            final_url = urljoin(_DDG_URL, href)

        # Decode if we still ended up with a DDG redirect link (common for //duckduckgo.com/l/...).
        if final_url:
            try:
                p2 = urlparse(final_url)
                if p2.netloc.endswith("duckduckgo.com") and p2.path.startswith("/l/"):
                    qs2 = parse_qs(p2.query)
                    uddg2 = qs2.get("uddg", [None])[0]
                    if uddg2:
                        final_url = unquote(uddg2)
            except Exception:
                pass

        if final_url and final_url.startswith("http"):
            out.append(SearchCandidate(url=UrlStr(final_url), title=title, snippet=snippet, source="duckduckgo"))
    if out:
        return out

    # Fallback: duckduckgo HTML via `r.jina.ai` returns Markdown (not HTML),
    # so `a.result__a` selectors won't match. Parse markdown links that contain
    # DuckDuckGo redirect URLs with `uddg=...`.
    if "Markdown Content:" in (html or ""):
        md = html or ""
        # Matches: [CAPTION](https://duckduckgo.com/l/?uddg=ENC&rut=...)
        link_re = re.compile(
            r"\[([^\]]+)\]\(\s*(https?://duckduckgo\.com/l/\?uddg=[^)]+)\s*\)",
            flags=re.IGNORECASE | re.DOTALL,
        )
        for m in link_re.finditer(md):
            caption = (m.group(1) or "").strip()
            raw_link = m.group(2) or ""
            # r.jina.ai may introduce whitespace/newlines into long URLs.
            raw_link = re.sub(r"\s+", "", raw_link)

            try:
                p = urlparse(raw_link)
                if not (p.netloc and p.netloc.endswith("duckduckgo.com")):
                    continue
                if not p.path.startswith("/l/"):
                    continue
                qs = parse_qs(p.query)
                uddg = (qs.get("uddg", [None])[0]) if qs else None
                final_url = unquote(uddg) if uddg else None
                if not final_url:
                    continue
                if not str(final_url).startswith("http"):
                    continue
            except Exception:
                continue

            out.append(SearchCandidate(url=UrlStr(str(final_url)), title=caption or None, snippet=None, source="duckduckgo"))
    return out


async def _direct_site_candidates(
    client: httpx.AsyncClient,
    track: CanonicalTrack,
    *,
    hebrew: bool,
) -> list[SearchCandidate]:
    """Halturaz-style: hit Tab4U / Ultimate Guitar first, not a search engine.

    Hebrew: Tab4U with title+artist, then title-only (English YouTube artist
    names usually fail Tab4U's artist filter).
    English: Ultimate Guitar, then Tab4U as fallback.
    """
    title = search_title(track.search_title or track.canonical_title)
    artist = (track.search_artist or track.canonical_artist or "").strip()
    attempts: list[tuple[str, str]] = [(title, artist)]
    if artist:
        attempts.append((title, ""))

    async def tab4u_tries() -> list[SearchCandidate]:
        for t, a in attempts:
            hits = await search_tab4u(client, t, a)
            if hits:
                return hits
        return []

    async def ug_tries() -> list[SearchCandidate]:
        for t, a in attempts:
            hits = await search_ultimate_guitar(client, t, a)
            if hits:
                return hits
        return []

    if hebrew or has_hebrew(title) or has_hebrew(artist):
        # Halturaz: Hebrew charts come from Tab4U only. UG Hebrew hits are often
        # a different song that merely shares words.
        return await tab4u_tries()

    hits = await ug_tries()
    if hits:
        return hits
    return await tab4u_tries()


def _merge_search_candidates(batches: list[list[SearchCandidate]]) -> list[SearchCandidate]:
    """Dedupe URLs across queries; prefer higher-planner-priority source query; richest title/snippet."""
    merged: dict[str, SearchCandidate] = {}
    for batch in batches:
        for c in batch:
            u = str(c.url)
            r = dict(c.raw) if c.raw else {}
            pr_new = int(r.get("priority", 999999))

            if u not in merged:
                merged[u] = c
                continue
            o = merged[u]
            ro = dict(o.raw) if o.raw else {}
            pr_old = int(ro.get("priority", 999999))
            if pr_new < pr_old:
                merged[u] = c
            elif pr_new == pr_old:
                use_title = c.title if len(c.title or "") > len(o.title or "") else o.title
                use_snip = c.snippet if len(c.snippet or "") > len(o.snippet or "") else o.snippet
                merged[u] = replace(o, title=use_title, snippet=use_snip)
    return list(merged.values())


async def _fetch_ddg_candidates(client: httpx.AsyncClient, pq: PlannedChordQuery) -> list[SearchCandidate]:
    url = _DDG_URL + "?q=" + quote_plus(pq.text)
    candidates: list[SearchCandidate] = []
    r = await client.get(url)
    if r.status_code < 400:
        candidates = _extract_ddg_results(r.text)
    if not candidates:
        jina_url = _jina_proxy_url(url)
        r2 = await client.get(jina_url)
        if r2.status_code < 400:
            candidates = _extract_ddg_results(r2.text)
    meta = {"source_query": pq.text, "family": pq.family, "priority": pq.priority}
    out: list[SearchCandidate] = []
    for cand in candidates:
        out.append(replace(cand, raw={**dict(cand.raw or {}), **meta}))
    return out


def _ordered_ranked_list(
    ranked: list[RankedResult],
    trusted: list[Any],
    *,
    limit: int,
) -> tuple[list[RankedResult], str]:
    """Order by trusted-domain priority when applicable; else by rank score."""
    if not ranked:
        return [], "best_overall"
    TRUST_MIN = 0.80
    trusted_ranked: list[tuple[int, float, RankedResult]] = []
    for rnk in ranked:
        try:
            dom = (urlparse(str(rnk.candidate.url)).netloc or "").lower()
        except Exception:
            dom = ""
        tw = trusted_domain_weight(dom, trusted)
        pr = trusted_source_priority(dom, trusted)
        if tw >= TRUST_MIN and pr is not None:
            trusted_ranked.append((pr, tw, rnk))
    if trusted_ranked:
        trusted_ranked.sort(key=lambda t: (t[0], -t[2].score))
        ordered = [t[2] for t in trusted_ranked]
        return ordered[: max(1, int(limit))], "trusted_priority"
    return ranked[: max(1, int(limit))], "best_overall"


def _pick_ranked_urls(
    ranked: list[RankedResult],
    trusted: list[Any],
    *,
    limit: int,
) -> tuple[list[UrlStr], RankedResult, str] | None:
    """Prefer trusted-domain priority; else best overall score in pool."""
    ordered, policy = _ordered_ranked_list(ranked, trusted, limit=limit)
    if not ordered:
        return None
    best = ordered[0]
    out_urls = [rr.candidate.url for rr in ordered]
    return out_urls, best, policy


def _jina_proxy_url(ddg_url: str) -> str:
    """
    r.jina.ai works like:
      https://r.jina.ai/https://<original-url>
    """
    u = (ddg_url or "").strip()
    if u.startswith("https://"):
        return "https://r.jina.ai/https://" + u[len("https://") :]
    if u.startswith("http://"):
        return "https://r.jina.ai/http://" + u[len("http://") :]
    return "https://r.jina.ai/" + u


@dataclass(slots=True)
class PageRouter:
    preferred_language: str | None
    enable_hebrew: bool
    allow_english_fallback: bool = True
    timeout_s: float = 10.0
    verify_chord_pages: bool = True
    max_verify_candidates: int = 4
    verify_timeout_s: float = 8.0

    @classmethod
    def defaults(
        cls,
        *,
        preferred_language: str | None,
        enable_hebrew: bool,
        allow_english_fallback: bool = True,
        verify_chord_pages: bool = True,
        max_verify_candidates: int = 4,
        verify_timeout_s: float = 8.0,
    ) -> "PageRouter":
        return cls(
            preferred_language,
            enable_hebrew,
            allow_english_fallback,
            verify_chord_pages=verify_chord_pages,
            max_verify_candidates=max_verify_candidates,
            verify_timeout_s=verify_timeout_s,
        )

    async def _apply_page_verification(
        self,
        client: httpx.AsyncClient,
        ordered: list[RankedResult],
        track: CanonicalTrack,
        *,
        limit: int,
    ) -> tuple[list[UrlStr], RankedResult, list[dict[str, Any]]]:
        if not ordered:
            raise ValueError("ordered ranked list empty")
        if not self.verify_chord_pages:
            best = ordered[0]
            urls = [r.candidate.url for r in ordered[: max(1, int(limit))]]
            return urls, best, []

        take = ordered[: max(1, self.max_verify_candidates)]
        scored: list[tuple[RankedResult, float, Any]] = []
        details: list[dict[str, Any]] = []
        for rnk in take:
            vr = await verify_chord_page(
                client,
                str(rnk.candidate.url),
                track,
                preferred_language=self.preferred_language,
                enable_hebrew=self.enable_hebrew,
                timeout_s=self.verify_timeout_s,
            )
            comb = 0.55 * float(rnk.score) + 0.45 * float(vr.score)
            scored.append((rnk, comb, vr))
            details.append(
                {
                    "url": str(rnk.candidate.url),
                    "rank_score": rnk.score,
                    "verify_score": vr.score,
                    "combined": comb,
                    "verify_ok": vr.ok,
                    "reasons": list(vr.reasons),
                }
            )
        scored.sort(key=lambda t: -t[1])
        best = scored[0][0]
        seen: set[str] = set()
        out_urls: list[UrlStr] = []
        for rnk, _comb, _vr in scored:
            u = str(rnk.candidate.url)
            if u not in seen:
                seen.add(u)
                out_urls.append(rnk.candidate.url)
            if len(out_urls) >= limit:
                break
        for rnk in ordered:
            if len(out_urls) >= limit:
                break
            u = str(rnk.candidate.url)
            if u not in seen:
                seen.add(u)
                out_urls.append(rnk.candidate.url)
        return out_urls, best, details

    async def _finalize_tier(
        self,
        client: httpx.AsyncClient,
        ordered: list[RankedResult],
        policy: str,
        *,
        tier: str,
        limit: int,
        track: CanonicalTrack,
        meta_base: dict[str, Any],
    ) -> tuple[list[UrlStr], dict[str, Any]]:
        urls, best, verify_details = await self._apply_page_verification(client, ordered, track, limit=limit)
        log.info(
            "search_best",
            policy=policy,
            tier=tier,
            url=str(urls[0]) if urls else None,
            score=best.score,
            verified=self.verify_chord_pages,
        )
        explanation = (
            f"tier={tier}; policy={policy}; rank_score={best.score:.3f}"
            + ("; page_verification_applied" if self.verify_chord_pages and verify_details else "")
        )
        chosen = str(urls[0]) if urls else None
        chosen_dom = ""
        if chosen:
            try:
                chosen_dom = (urlparse(chosen).netloc or "").lower()
            except Exception:
                chosen_dom = ""
        return list(urls), {
            **meta_base,
            "rank_reasons": best.reasons,
            "score": best.score,
            "policy": policy,
            "tier": tier,
            "page_verification": verify_details,
            "resolution_explanation": explanation,
            "chosen_url": chosen,
            "chosen_domain": chosen_dom or None,
        }

    async def find_best_chords_url(self, track: CanonicalTrack) -> tuple[UrlStr | None, dict[str, Any]]:
        urls, meta = await self.find_candidate_chords_urls(track, limit=1)
        if not urls:
            return None, meta
        return urls[0], meta

    async def find_candidate_chords_urls(
        self,
        track: CanonicalTrack,
        *,
        limit: int = 5,
        translation_used_for_search: bool = False,
    ) -> tuple[list[UrlStr], dict[str, Any]]:
        trusted = trusted_sources_for_search(self.preferred_language, self.enable_hebrew, track)
        trusted_en = default_english_trusted_sources()
        reps = build_song_search_representations(track, translation_used_for_search=translation_used_for_search)
        planned = plan_chord_queries(
            track,
            reps,
            preferred_language=self.preferred_language,
            enable_hebrew=self.enable_hebrew,
        )
        he_search = is_hebrew_chord_search_mode(self.preferred_language, self.enable_hebrew, track=track)
        max_queries = min(len(planned), 28 if he_search else 22)

        meta_base: dict[str, Any] = {
            "search_mode": "merged_queries_planned",
            "planned_query_count": len(planned),
            "planned_queries": [planned_query_to_dict(q) for q in planned[:max_queries]],
            "language_guess": track.language_guess.value if track.language_guess else None,
        }

        async with httpx.AsyncClient(
            timeout=self.timeout_s,
            headers=_HTTP_HEADERS,
            follow_redirects=True,
        ) as client:
            try:
                direct = await _direct_site_candidates(client, track, hebrew=he_search)
            except Exception:
                log.exception("direct_site_search_failed")
                direct = []
            if direct:
                urls = [c.url for c in direct[: max(1, int(limit))]]
                chosen = str(urls[0])
                try:
                    chosen_dom = (urlparse(chosen).netloc or "").lower()
                except Exception:
                    chosen_dom = ""
                log.info(
                    "direct_site_search_ok",
                    n=len(urls),
                    source=direct[0].source,
                    url=chosen,
                    title=direct[0].title,
                )
                return urls, {
                    **meta_base,
                    "search_mode": "direct_site",
                    "direct_source": direct[0].source,
                    "merged_candidates": len(direct),
                    "queries_with_hits": 1,
                    "chosen_url": chosen,
                    "chosen_domain": chosen_dom or None,
                    "resolution_explanation": f"tier=direct_{direct[0].source}",
                }

            batches: list[list[SearchCandidate]] = []
            for pq in planned[:max_queries]:
                try:
                    log.info("search_begin", query=pq.text, family=pq.family, hebrew_search=he_search)
                    cands = await _fetch_ddg_candidates(client, pq)
                    if cands:
                        batches.append(cands)
                        log.info("search_query_hits", query=pq.text, n=len(cands))
                except Exception as e:
                    log.warning("search_failed", query=pq.text, error=str(e))

            merged = _merge_search_candidates(batches)
            meta_base["merged_candidates"] = len(merged)
            meta_base["queries_with_hits"] = len(batches)

            if not merged:
                log.info("search_no_merged_candidates", queries_tried=min(len(planned), max_queries))
                return [], {**meta_base, "error": "no_results"}

            def run_rank(strict_domain: bool) -> list[RankedResult]:
                return rank_results(
                    track,
                    merged,
                    trusted=trusted,
                    preferred_language=self.preferred_language,
                    enable_hebrew=self.enable_hebrew,
                    hebrew_domain_strict=strict_domain,
                )

            def _dom(r: RankedResult) -> str:
                try:
                    return (urlparse(str(r.candidate.url)).netloc or "").lower()
                except Exception:
                    return ""

            ranked_strict = run_rank(True)

            if he_search:
                pool_he_strict = [r for r in ranked_strict if is_hebrew_trusted_chord_domain(_dom(r))]
                ordered, policy = _ordered_ranked_list(pool_he_strict, trusted, limit=limit) if pool_he_strict else ([], "best_overall")
                if ordered:
                    return await self._finalize_tier(
                        client, ordered, policy, tier="hebrew_strict_merged", limit=limit, track=track, meta_base=meta_base
                    )

                ranked_loose = run_rank(False)
                pool_he_relaxed = [r for r in ranked_loose if is_hebrew_trusted_chord_domain(_dom(r))]
                ordered2, policy2 = _ordered_ranked_list(pool_he_relaxed, trusted, limit=limit) if pool_he_relaxed else ([], "best_overall")
                if ordered2:
                    return await self._finalize_tier(
                        client, ordered2, policy2, tier="hebrew_relaxed_merged", limit=limit, track=track, meta_base=meta_base
                    )

                if self.allow_english_fallback:
                    pool_en = [r for r in ranked_loose if not is_hebrew_trusted_chord_domain(_dom(r))]
                    ordered3, policy3 = _ordered_ranked_list(pool_en, trusted_en, limit=limit) if pool_en else ([], "best_overall")
                    if ordered3:
                        return await self._finalize_tier(
                            client, ordered3, policy3, tier="english_fallback_merged", limit=limit, track=track, meta_base=meta_base
                        )

                return [], {**meta_base, "error": "no_results"}

            ordered_en, policy_en = _ordered_ranked_list(ranked_strict, trusted, limit=limit) if ranked_strict else ([], "best_overall")
            if ordered_en:
                return await self._finalize_tier(
                    client, ordered_en, policy_en, tier="english_strict_merged", limit=limit, track=track, meta_base=meta_base
                )

            ranked_loose_en = run_rank(False)
            ordered_lr, policy_lr = _ordered_ranked_list(ranked_loose_en, trusted, limit=limit) if ranked_loose_en else ([], "best_overall")
            if ordered_lr:
                return await self._finalize_tier(
                    client, ordered_lr, policy_lr, tier="english_relaxed_merged", limit=limit, track=track, meta_base=meta_base
                )

        return [], {**meta_base, "error": "no_results"}

