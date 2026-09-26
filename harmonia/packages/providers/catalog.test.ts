// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { RecordingCatalog } from './catalog';

const signal = () => new AbortController().signal;
const url = 'https://upload.wikimedia.org/wikipedia/commons/d/d8/Example.oga';
const page = () => ({
  pageid: 123,
  ns: 6,
  title: 'File:Example.oga',
  imageinfo: [
    {
      size: 4,
      duration: 122,
      url,
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Example.oga',
      mime: 'application/ogg',
      mediatype: 'AUDIO',
      extmetadata: {
        Artist: { value: '<a href="//example.test">A &amp; B</a>' },
        ObjectName: { value: '<b>Example</b>' },
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/3.0' },
        LicenseShortName: { value: 'CC BY-SA 3.0' },
        Restrictions: { value: '' },
      },
    },
  ],
});
const json = (data: unknown) => new Response(JSON.stringify(data));
const metadata = (p = page()) => json({ query: { pages: { '123': p } } });

describe('recording catalog', () => {
  it('canonicalizes Commons tracking queries for stable persisted source identity', async () => {
    const p = page();
    p.imageinfo[0].url = `${url}?utm_source=commons.wikimedia.org&utm_content=original`;
    const [recording] = await new RecordingCatalog(vi.fn().mockResolvedValue(metadata(p))).search(
      'Example',
      'commons',
      signal(),
    );
    expect(recording.audio?.url).toBe(url);
  });
  it('uses the official anonymous Commons search and returns plain attributed metadata', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(metadata());
    const [result] = await new RecordingCatalog(fetcher).search('Example', 'commons', signal());
    expect(result).toMatchObject({
      id: '123',
      title: 'Example',
      artist: 'A & B',
      duration: 122,
      audio: { url, license: 'CC BY-SA 3.0', size: 4 },
    });
    expect(result.audio?.attribution).toContain('A & B');
    const request = new URL(String(fetcher.mock.calls[0][0]));
    expect(request.hostname).toBe('commons.wikimedia.org');
    expect(request.searchParams.get('gsrsearch')).toBe('filetype:audio Example');
    expect(request.searchParams.get('origin')).toBe('*');
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  });

  it.each([
    'https://creativecommons.org/licenses/by-nc/4.0/',
    'https://creativecommons.org.evil.test/licenses/by/4.0/',
    'https://creativecommons.org/licenses/by/4.0/../../by-nc/4.0/',
    'https://creativecommons.org/licenses/by/4.0deed.en',
    'https://creativecommons.org/publicdomain/zero/1.0deed.en',
    '',
  ])('rejects unavailable or unpermitted license %s', async (license) => {
    const p = page();
    p.imageinfo[0].extmetadata.LicenseUrl.value = license;
    expect(
      await new RecordingCatalog(vi.fn().mockResolvedValue(metadata(p))).search(
        'a',
        'commons',
        signal(),
      ),
    ).toEqual([]);
  });

  it.each(['restriction', 'artist', 'size', 'duration', 'url', 'mime', 'video'])(
    'rejects unsafe %s metadata',
    async (kind) => {
      const p = page(),
        info = p.imageinfo[0];
      if (kind === 'restriction') info.extmetadata.Restrictions.value = 'personality rights';
      if (kind === 'artist') info.extmetadata.Artist.value = '';
      if (kind === 'size') info.size = 101 * 1024 * 1024;
      if (kind === 'duration') info.duration = 1201;
      if (kind === 'url') info.url = 'https://evil.test/song.oga';
      if (kind === 'mime') info.mime = 'audio/midi';
      if (kind === 'video') info.mediatype = 'VIDEO';
      expect(
        await new RecordingCatalog(vi.fn().mockResolvedValue(metadata(p))).search(
          'a',
          'commons',
          signal(),
        ),
      ).toEqual([]);
    },
  );

  it('revalidates metadata before downloading and normalizes OGA for local decoding', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(new Response(new Uint8Array([79, 103, 103, 83])));
    const catalog = new RecordingCatalog(fetcher),
      progress = vi.fn();
    const [recording] = await catalog.search('a', 'commons', signal());
    const file = await catalog.acquire(recording, signal(), progress);
    expect(file.name).toBe('Example.ogg');
    expect(file.size).toBe(4);
    expect(progress).toHaveBeenLastCalledWith(4, 4);
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get('pageids')).toBe('123');
    expect(fetcher.mock.calls[2][0]).toBe(url);
  });

  it('rejects forged URLs and changed rights without contacting media', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(metadata());
    const catalog = new RecordingCatalog(fetcher);
    const [recording] = await catalog.search('a', 'commons', signal());
    recording.audio!.url = 'https://evil.test/audio.ogg';
    await expect(catalog.acquire(recording, signal(), vi.fn())).rejects.toThrow(
      /changed|verified/i,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('counts actual streamed bytes and rejects a false advertised size', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(
        new Response(new Uint8Array(5), { headers: { 'Content-Length': '4' } }),
      );
    const catalog = new RecordingCatalog(fetcher);
    const [recording] = await catalog.search('a', 'commons', signal());
    await expect(catalog.acquire(recording, signal(), vi.fn())).rejects.toThrow(/size/i);
  });

  it('rejects cancellation before network activity', async () => {
    const fetcher = vi.fn(),
      controller = new AbortController();
    controller.abort();
    await expect(
      new RecordingCatalog(fetcher).search('a', 'commons', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels a stalled media stream and releases its reader', async () => {
    const cancel = vi.fn(),
      controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(new Response(stream));
    const catalog = new RecordingCatalog(fetcher);
    const [recording] = await catalog.search('a', 'commons', signal());
    const acquisition = catalog.acquire(recording, controller.signal, (received) => {
      if (received === 0) controller.abort();
    });
    await expect(acquisition).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it('applies a deadline to a stalled metadata response', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(new ReadableStream({ cancel })));
      const request = new RecordingCatalog(fetcher).search('a', 'commons', signal());
      const assertion = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(25_000);
      await assertion;
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks permission and stops if a license changed after search', async () => {
    const changed = page();
    changed.imageinfo[0].extmetadata.LicenseUrl.value =
      'https://creativecommons.org/licenses/by-nc/4.0/';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(metadata(changed));
    const catalog = new RecordingCatalog(fetcher);
    const [recording] = await catalog.search('a', 'commons', signal());
    await expect(catalog.acquire(recording, signal(), vi.fn())).rejects.toThrow(/changed|verified/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('supports CC0 legacy HTTP license URLs and filters invalid IDs', async () => {
    const p = page();
    p.imageinfo[0].extmetadata.LicenseUrl.value =
      'http://creativecommons.org/publicdomain/zero/1.0/deed.en';
    p.imageinfo[0].extmetadata.Artist.value = '';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata(p));
    const [recording] = await new RecordingCatalog(fetcher).search('a', 'commons', signal());
    expect(recording.audio?.licenseUrl).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(recording.audio?.license).toBe('CC0 1.0');
    p.pageid = -1;
    expect(
      await new RecordingCatalog(vi.fn().mockResolvedValue(metadata(p))).search(
        'a',
        'commons',
        signal(),
      ),
    ).toEqual([]);
  });

  it('rejects redirected responses, HTTP errors and malformed metadata', async () => {
    const redirected = metadata();
    Object.defineProperty(redirected, 'redirected', { value: true });
    await expect(
      new RecordingCatalog(vi.fn().mockResolvedValue(redirected)).search('a', 'commons', signal()),
    ).rejects.toThrow(/redirect/);
    await expect(
      new RecordingCatalog(
        vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })),
      ).search('a', 'youtube', signal(), 'key'),
    ).rejects.toThrow(/API key/);
    await expect(
      new RecordingCatalog(vi.fn().mockResolvedValue(new Response('broken'))).search(
        'a',
        'commons',
        signal(),
      ),
    ).rejects.toThrow(/invalid metadata/);
  });

  it('reports network/CORS failures without leaking provider request URLs or keys', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch secret-key'));
    await expect(new RecordingCatalog(fetcher).search('a', 'commons', signal())).rejects.toThrow(
      /network|CORS/i,
    );
    await expect(
      new RecordingCatalog(fetcher).search('a', 'youtube', signal(), 'secret-key'),
    ).rejects.not.toThrow(/secret-key/);
  });

  it('uses only official YouTube metadata APIs with session key and never offers media acquisition', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          items: [
            {
              id: { videoId: 'abcdefghijk' },
              snippet: { title: 'A &amp; B', channelTitle: 'Artist' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({ items: [{ id: 'abcdefghijk', contentDetails: { duration: 'PT2M3S' } }] }),
      );
    const catalog = new RecordingCatalog(fetcher);
    const [recording] = await catalog.search('song', 'youtube', signal(), 'session-key');
    expect(recording).toMatchObject({
      id: 'abcdefghijk',
      title: 'A & B',
      duration: 123,
      audio: null,
    });
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/youtube/v3/search',
      '/youtube/v3/videos',
    ]);
    expect(
      fetcher.mock.calls.every(
        ([input]) => new URL(String(input)).hostname === 'www.googleapis.com',
      ),
    ).toBe(true);
    await expect(catalog.acquire(recording, signal(), vi.fn())).rejects.toThrow(/YouTube/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('requires an API key for YouTube without making a request', async () => {
    const fetcher = vi.fn();
    await expect(new RecordingCatalog(fetcher).search('song', 'youtube', signal())).rejects.toThrow(
      /API key/,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
