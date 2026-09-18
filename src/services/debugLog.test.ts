import { afterEach, describe, expect, it } from 'vitest';
import { clearTraceBuffer, debugLog, formatTraceLine, getTraceBuffer, subscribeTrace, trace } from './debugLog';

afterEach(() => {
  clearTraceBuffer();
});

describe('pipeline tracer', () => {
  it('formats a scannable line with a padded sequence number', () => {
    expect(
      formatTraceLine({
        seq: 7,
        scope: 'cloud',
        event: 'lookup.start',
        level: 'start',
        message: 'asking verified DB then catalogs',
      }),
    ).toBe('[GSV #0007 cloud] lookup.start  asking verified DB then catalogs');
  });

  it('records every trace into the ring even when the console is off in tests', () => {
    trace('catalog', 'http.reject', 'Worker returned HTTP 500 — not a song miss', {
      status: 500,
      why: 'falling through to client catalogs',
    }, 'fail');
    const rows = getTraceBuffer();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: 'catalog',
      event: 'http.reject',
      level: 'fail',
      message: 'Worker returned HTTP 500 — not a song miss',
    });
  });

  it('keeps debugLog working as a thin wrapper', () => {
    debugLog('key_resolution: cloud cache hit', { trackIdentity: 'src=spotify|title=numb' });
    expect(getTraceBuffer()[0]).toMatchObject({
      scope: 'app',
      event: 'log',
      message: 'key_resolution: cloud cache hit',
      detail: { trackIdentity: 'src=spotify|title=numb' },
    });
  });

  it('notifies subscribers when a line is appended or the buffer is cleared', () => {
    let ticks = 0;
    const stop = subscribeTrace(() => {
      ticks += 1;
    });
    trace('ui', 'boot', 'React UI mounting', undefined, 'start');
    expect(ticks).toBe(1);
    clearTraceBuffer();
    expect(ticks).toBe(2);
    expect(getTraceBuffer()).toEqual([]);
    stop();
  });
});
