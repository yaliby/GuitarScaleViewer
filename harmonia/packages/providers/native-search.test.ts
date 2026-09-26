// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { NativeYouTubeSearch } from './native-search';

describe('native YouTube search', () => {
  it('reports an honest browser limitation without invoking native code', async () => {
    const invoke = vi.fn();
    const service = new NativeYouTubeSearch(invoke, () => false);
    await expect(service.status()).resolves.toEqual({ configured: false });
    await expect(service.search('song', new AbortController().signal)).rejects.toMatchObject({
      code: 'native_unavailable',
    });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('passes only a query and request ID, and reads only boolean configuration', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'search_status' ? { configured: true, secret: 'must not propagate' } : [],
    );
    const service = new NativeYouTubeSearch(invoke, () => true);
    await expect(service.status()).resolves.toEqual({ configured: true });
    await expect(service.search('  song  ', new AbortController().signal)).resolves.toEqual([]);
    expect(invoke).toHaveBeenLastCalledWith('youtube_search', {
      query: 'song',
      requestId: expect.any(String),
    });
  });
  it('cancels the matching native request and rejects late results', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const invoke = vi.fn((command: string, _args?: Record<string, unknown>) =>
      command === 'youtube_search'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(),
    );
    const service = new NativeYouTubeSearch(invoke, () => true);
    const controller = new AbortController();
    const result = service.search('song', controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(invoke).toHaveBeenLastCalledWith('search_cancel', {
      requestId: invoke.mock.calls[0][1]?.requestId,
    });
    finish?.([]);
  });
  it('does not send already aborted or overlong queries', async () => {
    const invoke = vi.fn();
    const service = new NativeYouTubeSearch(invoke, () => true);
    const controller = new AbortController();
    controller.abort();
    await expect(service.search('song', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      service.search('x'.repeat(201), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid_query' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('never exposes arbitrary native error details', async () => {
    const invoke = vi.fn(async () => {
      throw { code: 'network', message: 'https://bad/?key=secret' };
    });
    const service = new NativeYouTubeSearch(invoke, () => true);
    await expect(service.search('song', new AbortController().signal)).rejects.toMatchObject({
      code: 'network',
      message: 'Search is temporarily unavailable. Please try again.',
    });
  });
});
