/**
 * Type surface for the vendored videojs/vtt.js bundle (`./vtt.mjs`).
 * `.d.mts` pairs with the `.mjs` file under `moduleResolution: bundler`.
 * Importing the bundle assigns `window.WebVTT` / `window.vttjs` as a side
 * effect, then re-exports `window.WebVTT` as the named export `WebVTT`.
 */

export interface VTTCue {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  /** Cached DOM tree produced by convertCueToDOMTree (NoBuf renderer adds this). */
  dom?: DocumentFragment | null;
  [key: string]: unknown;
}

export interface VTTRegion {
  id: string;
  [key: string]: unknown;
}

export interface VTTParser {
  oncue: ((cue: VTTCue) => void) | null;
  onregion: ((region: VTTRegion) => void) | null;
  onRegion: ((region: VTTRegion) => void) | null;
  onflush: (() => void) | null;
  onparsingerror: ((error: Error) => void) | null;
  parse(data?: string): void;
  flush(): void;
}

export interface WebVTTStatic {
  Parser: new (window: Window, decoder: unknown) => VTTParser;
  StringDecoder: () => unknown;
  convertCueToDOMTree: (window: Window, cuetext: string) => DocumentFragment | null;
}

export const WebVTT: WebVTTStatic;
