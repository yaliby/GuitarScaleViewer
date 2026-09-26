import { describe, expect, it } from "vitest";
import {
  NATIVE_RECOGNITION_UNAVAILABLE,
  desktopWholeSongIdentity,
  desktopWholeSongMode,
  requireDesktopNative,
} from "../../harmonia/packages/audio/desktop-native-gate";
import { NATIVE_MODEL_VERSION, NATIVE_PIPELINE_VERSION } from "../../harmonia/packages/audio/native-whole";
import {
  WHOLE_SONG_MODEL_VERSION,
  WHOLE_SONG_PIPELINE_VERSION,
} from "../../harmonia/packages/audio/whole-pipeline";

describe("desktop whole-song recognizer", () => {
  it("keeps a browser preview on the prototype decoder", () => {
    expect(desktopWholeSongMode(false, false)).toBe("browser-dsp");
    expect(desktopWholeSongIdentity("browser-dsp")).toEqual({
      pipelineVersion: WHOLE_SONG_PIPELINE_VERSION,
      modelVersion: WHOLE_SONG_MODEL_VERSION,
    });
  });

  it("refuses the desktop song library when the local recognizer is missing", () => {
    expect(desktopWholeSongMode(true, false)).toBe("missing");
    expect(desktopWholeSongIdentity("missing")).toEqual({
      pipelineVersion: NATIVE_PIPELINE_VERSION,
      modelVersion: NATIVE_MODEL_VERSION,
    });
    expect(() => requireDesktopNative("missing")).toThrow(NATIVE_RECOGNITION_UNAVAILABLE);
  });

  it("selects the native recognizer when the desktop runtime is present", () => {
    expect(desktopWholeSongMode(true, true)).toBe("native");
    expect(desktopWholeSongIdentity("native").modelVersion).toBe(NATIVE_MODEL_VERSION);
    expect(() => requireDesktopNative("native")).not.toThrow();
  });
});
