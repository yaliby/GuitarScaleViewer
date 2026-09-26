// @ts-nocheck
import type { CatalogRecording, RecordingCatalogPort } from '../application/catalog-contracts';
export type { CatalogRecording } from '../application/catalog-contracts';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_SECONDS = 1200;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const AUDIO_MIMES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'application/ogg',
]);

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Metadata is always returned as bounded text, never inserted into an HTML document. */
function plain(value: unknown, limit = 400): string {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, 20_000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
      };
      if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? '';
      const n =
        entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    })
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function secureUrl(value: unknown, host: string): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === host &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}
function audioUrl(value: unknown): URL | null {
  const url = secureUrl(value, 'upload.wikimedia.org');
  return url &&
    /^\/wikipedia\/commons\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+\.(wav|mp3|flac|ogg|oga)$/i.test(
      url.pathname,
    )
    ? url
    : null;
}
function license(value: unknown): { url: string; label: string; by: boolean } | null {
  // Older Commons templates use HTTP CC links; normalize the same exact host to HTTPS.
  const url = secureUrl(
    typeof value === 'string' ? value.replace(/^http:\/\//, 'https://') : value,
    'creativecommons.org',
  );
  if (!url || url.search) return null;
  if (/^\/publicdomain\/zero\/1\.0(?:\/deed\.[a-z-]+)?\/?$/.test(url.pathname))
    return {
      url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      label: 'CC0 1.0',
      by: false,
    };
  const match = /^\/licenses\/(by|by-sa)\/(1\.0|2\.0|2\.5|3\.0|4\.0)(?:\/deed\.[a-z-]+)?\/?$/.exec(
    url.pathname,
  );
  return match
    ? {
        url: `https://creativecommons.org/licenses/${match[1]}/${match[2]}/`,
        label: `CC ${match[1].toUpperCase()} ${match[2]}`,
        by: true,
      }
    : null;
}

function commonsRecording(value: unknown): CatalogRecording | null {
  const page = object(value),
    info = object(array(page.imageinfo)[0]),
    ext = object(info.extmetadata);
  const field = (key: string) => object(ext[key]).value;
  const rights = license(field('LicenseUrl')),
    url = audioUrl(info.url);
  const pageUrl = secureUrl(info.descriptionurl, 'commons.wikimedia.org');
  const artist = plain(field('Artist'), 1000);
  const duration = typeof info.duration === 'number' ? info.duration : null;
  if (
    page.ns !== 6 ||
    !Number.isSafeInteger(page.pageid) ||
    Number(page.pageid) <= 0 ||
    typeof page.title !== 'string' ||
    !page.title.startsWith('File:') ||
    !url ||
    !pageUrl ||
    !pageUrl.pathname.startsWith('/wiki/File:') ||
    !rights ||
    info.mediatype !== 'AUDIO' ||
    !AUDIO_MIMES.has(String(info.mime)) ||
    !Number.isSafeInteger(info.size) ||
    Number(info.size) <= 0 ||
    Number(info.size) > MAX_BYTES ||
    (duration !== null &&
      (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS)) ||
    plain(field('Restrictions')) ||
    (rights.by && !artist)
  )
    return null;
  // Commons adds attribution tracking parameters; the original media path is
  // the stable source identity used for acquisition and persisted cache matching.
  url.search = '';
  const title = plain(field('ObjectName')) || plain(page.title.slice(5));
  const credit = plain(field('Credit'), 1000),
    requiredAttribution = plain(field('Attribution'), 2000);
  const attribution = [title, artist, requiredAttribution, credit, rights.label, pageUrl.href]
    .filter(Boolean)
    .join(' — ');
  return {
    id: String(page.pageid),
    provider: 'commons',
    title,
    artist: artist || 'Creator not supplied (CC0)',
    duration,
    thumbnail: null,
    pageUrl: pageUrl.href,
    audio: {
      url: url.href,
      license: rights.label,
      licenseUrl: rights.url,
      attribution,
      size: Number(info.size),
    },
  };
}

function commonsParams(): URLSearchParams {
  return new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata|mime|mediatype',
    iiextmetadatalanguage: 'en',
  });
}
function pages(data: unknown): unknown[] {
  return Object.values(object(object(object(data).query).pages));
}
function durationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!m) return null;
  const n =
    Number(m[1] ?? 0) * 86400 +
    Number(m[2] ?? 0) * 3600 +
    Number(m[3] ?? 0) * 60 +
    Number(m[4] ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Official catalog metadata and explicitly licensed Commons originals only. */
export class RecordingCatalog implements RecordingCatalogPort {
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async search(
    query: string,
    provider: CatalogRecording['provider'],
    signal: AbortSignal,
    apiKey?: string,
  ): Promise<CatalogRecording[]> {
    signal.throwIfAborted();
    const text = query.trim();
    if (!text || text.length > 200) throw new Error('Enter a search between 1 and 200 characters.');
    return this.bounded(signal, 25_000, async (active) => {
      if (provider === 'commons') {
        const params = commonsParams();
        params.set('generator', 'search');
        params.set('gsrsearch', `filetype:audio ${text}`);
        params.set('gsrnamespace', '6');
        params.set('gsrlimit', '12');
        const data = await this.json(`${COMMONS_API}?${params}`, active);
        return pages(data)
          .sort((a, b) => Number(object(a).index ?? 0) - Number(object(b).index ?? 0))
          .slice(0, 12)
          .map(commonsRecording)
          .filter((r): r is CatalogRecording => r !== null);
      }
      if (provider !== 'youtube') throw new Error('Unknown recording catalog.');
      const key = apiKey?.trim();
      if (!key || key.length > 256 || /\s/.test(key))
        throw new Error('Supply a valid YouTube Data API key for this session.');
      const params = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        maxResults: '12',
        q: text,
        key,
      });
      const data = await this.json(
        `https://www.googleapis.com/youtube/v3/search?${params}`,
        active,
      );
      const items = array(data.items)
        .slice(0, 12)
        .filter((item) => VIDEO_ID.test(String(object(object(item).id).videoId ?? '')));
      if (!items.length) return [];
      const ids = items.map((item) => String(object(object(item).id).videoId));
      const details = await this.json(
        `https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'contentDetails', id: ids.join(','), key })}`,
        active,
      );
      const durations = new Map(
        array(details.items).map((item) => [
          String(object(item).id),
          durationSeconds(object(object(item).contentDetails).duration),
        ]),
      );
      return items.map((item, index) => {
        const snippet = object(object(item).snippet),
          id = ids[index];
        const thumbnail = secureUrl(object(object(snippet.thumbnails).medium).url, 'i.ytimg.com');
        return {
          id,
          provider: 'youtube',
          title: plain(snippet.title) || 'Untitled video',
          artist: plain(snippet.channelTitle),
          duration: durations.get(id) ?? null,
          thumbnail: thumbnail?.href ?? null,
          pageUrl: `https://www.youtube.com/watch?v=${id}`,
          audio: null,
        };
      });
    });
  }

  async acquire(
    recording: CatalogRecording,
    signal: AbortSignal,
    onProgress: (received: number, total: number | null) => void,
  ): Promise<File> {
    signal.throwIfAborted();
    if (recording.provider === 'youtube')
      throw new Error(
        'YouTube provides playback and metadata, not permitted analysis audio. Choose an openly licensed recording.',
      );
    if (recording.provider !== 'commons' || !/^\d{1,12}$/.test(recording.id) || !recording.audio)
      throw new Error('This recording has no verified permitted audio.');
    return this.bounded(signal, 120_000, async (active) => {
      const params = commonsParams();
      params.set('pageids', recording.id);
      const data = await this.json(`${COMMONS_API}?${params}`, active);
      const fresh = pages(data)
        .map(commonsRecording)
        .find((r) => r?.id === recording.id);
      if (
        !fresh?.audio ||
        fresh.audio.url !== recording.audio!.url ||
        fresh.audio.licenseUrl !== recording.audio!.licenseUrl ||
        fresh.audio.size !== recording.audio!.size ||
        fresh.audio.attribution !== recording.audio!.attribution
      )
        throw new Error(
          'The recording or its license metadata changed or could not be verified. Search again before downloading.',
        );
      const response = await this.request(fresh.audio.url, active);
      const advertised = response.headers.get('content-length');
      if (
        advertised !== null &&
        (!/^\d+$/.test(advertised) || Number(advertised) !== fresh.audio.size)
      ) {
        await response.body?.cancel();
        throw new Error('Audio size does not match the verified recording.');
      }
      const receivedType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (
        receivedType &&
        !AUDIO_MIMES.has(receivedType) &&
        receivedType !== 'application/octet-stream'
      ) {
        await response.body?.cancel();
        throw new Error('The server did not return a supported audio file.');
      }
      const bytes = await this.read(response, active, fresh.audio.size, (n) =>
        onProgress(n, fresh.audio!.size),
      );
      if (bytes.byteLength !== fresh.audio.size)
        throw new Error('Audio size does not match the verified recording.');
      active.throwIfAborted();
      const pathname = new URL(fresh.audio.url).pathname;
      const filename = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)).replace(
        /\.oga$/i,
        '.ogg',
      );
      return new File([bytes], filename, { type: receivedType || 'application/octet-stream' });
    });
  }

  private async request(url: string, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      signal.throwIfAborted();
      throw new Error(
        'The catalog request failed. Check your network connection and browser CORS access.',
      );
    }
    signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 403
          ? 'Catalog access was denied. For YouTube, check the API key, enabled API and quota.'
          : `The catalog request failed (HTTP ${response.status}). Try again later.`,
      );
    }
    if (response.redirected || (response.url && new URL(response.url).href !== new URL(url).href)) {
      await response.body?.cancel();
      throw new Error('An unexpected catalog redirect was rejected.');
    }
    return response;
  }

  private async json(url: string, signal: AbortSignal): Promise<JsonObject> {
    const response = await this.request(url, signal);
    const bytes = await this.read(response, signal, MAX_METADATA_BYTES);
    let data: JsonObject;
    try {
      data = object(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new Error('The catalog returned invalid metadata. Try again later.');
    }
    if (data.error)
      throw new Error(
        'The catalog could not complete this search. Check access, API quota, or try again later.',
      );
    return data;
  }

  private async read(
    response: Response,
    signal: AbortSignal,
    limit: number,
    progress?: (bytes: number) => void,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (!response.body) throw new Error('The catalog response has no readable content.');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let received = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      progress?.(0);
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        received += value.byteLength;
        if (received > limit || received > MAX_BYTES)
          throw new Error('The download exceeds the permitted size limit.');
        chunks.push(value);
        progress?.(received);
      }
      const result = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      signal.throwIfAborted();
      if (error instanceof TypeError)
        throw new Error('The network connection ended while reading the recording. Try again.', {
          cause: error,
        });
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }

  private async bounded<T>(
    signal: AbortSignal,
    milliseconds: number,
    work: (active: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException('The catalog request timed out. Try again.', 'TimeoutError'),
        ),
      milliseconds,
    );
    try {
      signal.throwIfAborted();
      return await work(controller.signal);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  }
}
