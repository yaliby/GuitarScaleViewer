/**
 * WebKitGTK, the Linux webview, plays an MP3 behind a `blob:` URL from the wrong place: a couple of
 * seconds in, the sound jumps about 87 s ahead while `currentTime` carries on as if nothing had
 * happened (measured on the speaker output: 0-2.5 s of the song, then 1:30 onwards; WAV, and the
 * same bytes behind a `data:` URL, play straight). On WebKit the audio elements are therefore
 * given a `data:` URL; everywhere else a `blob:` URL is cheaper and fine.
 */
export function mediaNeedsDataUrl(agent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /AppleWebKit/.test(agent) && !/Chrome|Chromium|Edg|OPR|jsdom/.test(agent);
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // A blob without a type reads as application/octet-stream, which WebKit will not play.
      resolve(String(reader.result).replace(/^data:[^;,]*/, `data:${blob.type || 'audio/mpeg'}`));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the audio.'));
    reader.readAsDataURL(blob);
  });
}

/** The URL an <audio> element should be given for `blob`. */
export async function playableUrl(blob: Blob): Promise<string> {
  return mediaNeedsDataUrl() ? blobToDataUrl(blob) : URL.createObjectURL(blob);
}
