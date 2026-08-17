// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JASSUBOptions } from 'jassub';
import { activeAssText, assDialogueBounds, shouldUseJassub, SubtitleOverlay } from '../components/dashboard/SubtitleOverlay';
import { SubtitleTrack } from '../lib/faststream/subtitles/SubtitleTrack';

const jassubMock = vi.hoisted(() => {
  const instances: Array<{
    options: JASSUBOptions;
    destroy: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    canvas: HTMLCanvasElement;
  }> = [];
  let constructorError: Error | null = null;
  let readyError: Error | null = null;

  class MockJASSUB {
    options: JASSUBOptions;
    destroy = vi.fn(async () => undefined);
    ready: Promise<void>;
    _canvas = document.createElement('canvas');
    _worker = { terminate: vi.fn() };

    constructor(options: JASSUBOptions) {
      this._canvas.className = 'JASSUB';
      if (constructorError) {
        options.video?.insertAdjacentElement('afterend', this._canvas);
        throw constructorError;
      }
      options.video?.insertAdjacentElement('afterend', this._canvas);
      this.ready = readyError ? Promise.reject(readyError) : Promise.resolve();
      this.options = options;
      instances.push({ options, destroy: this.destroy, terminate: this._worker.terminate, canvas: this._canvas });
    }
  }

  return {
    MockJASSUB,
    instances,
    throwOnConstruct(error: Error | null) { constructorError = error; },
    rejectReady(error: Error | null) { readyError = error; },
  };
});

vi.mock('jassub', () => ({ default: jassubMock.MockJASSUB }));

afterEach(() => {
  cleanup();
  delete (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri;
  jassubMock.instances.length = 0;
  jassubMock.throwOnConstruct(null);
  jassubMock.rejectReady(null);
});

describe('SubtitleOverlay', () => {
  it('reports absolute ASS dialogue bounds from the shipped content', () => {
    const content = `[Events]\nDialogue: 0,0:22:01.25,0:22:03.50,Default,,0,0,0,,First\nDialogue: 0,1:10:37.10,1:10:40.00,Default,,0,0,0,,Last`;
    expect(assDialogueBounds(content)).toEqual({ first: 1321.25, last: 4240, count: 2 });
    expect(assDialogueBounds('[Events]\nComment: no cues')).toBeNull();
    expect(activeAssText(content, 1322)).toEqual(['First']);
    expect(activeAssText(content, 4238)).toEqual(['Last']);
    expect(activeAssText(content, 2000)).toEqual([]);
  });

  it('parses CRLF ASS with reordered event fields', () => {
    const crlf = String.fromCharCode(13, 10);
    const content = [
      '[Events]',
      'Format: Layer, Text, End, Start, Style',
      'Dialogue: 0,Hello world,0:00:03.00,0:00:01.00,Default',
      'Dialogue: 0,ignored,0:00:05.00,0:00:04.00,Default',
    ].join(crlf);
    expect(assDialogueBounds(content)).toEqual({ first: 1, last: 5, count: 2 });
    expect(activeAssText(content, 1.5)).toEqual(['Hello world']);
  });

  it('preserves commas when Text is the final ASS event field', () => {
    const content = '[Events]\nFormat: Layer, Start, End, Text\n' +
      'Dialogue: 0,0:00:01.00,0:00:03.00,Hello, world';
    expect(activeAssText(content, 1.5)).toEqual(['Hello, world']);
  });

  it('uses the DOM ASS renderer in Tauri without constructing a JASSUB canvas', () => {
    (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
    const videoRef = createRef<HTMLVideoElement>();
    const track = new SubtitleTrack('English', 'eng');
    track.loadText(
      `[Script Info]\nScriptType: v4.00+\n\n[Events]\n` +
      `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
      `Dialogue: 0,0:13:29.00,0:13:11.00,Default,,0,0,0,,Invalid interval\n` +
      `Dialogue: 0,0:13:29.00,0:13:31.00,Default,,0,0,0,,{\\an8}Hello, world\\NSecond line\\h!`,
    );

    const result = render(
      <div>
        <video ref={videoRef} />
        <SubtitleOverlay vidRef={videoRef} activeTracks={[track]} currentTime={810} />
      </div>,
    );

    expect(shouldUseJassub()).toBe(false);
    expect(jassubMock.instances).toHaveLength(0);
    expect(videoRef.current?.parentElement?.querySelector('canvas.JASSUB')).toBeNull();
    expect(result.container.textContent).toContain('Hello, world');
    expect(result.container.textContent).toContain('Second line\u00a0!');
    expect(result.container.querySelectorAll('[data-ass-subtitle]')).toHaveLength(1);

    result.rerender(
      <div>
        <video ref={videoRef} />
        <SubtitleOverlay vidRef={videoRef} activeTracks={[track]} currentTime={812} />
      </div>,
    );
    expect(videoRef.current?.parentElement?.querySelector('canvas.JASSUB')).toBeNull();
    expect(result.container.textContent).not.toContain('Hello, world');
    expect(result.container.querySelectorAll('[data-ass-subtitle]')).toHaveLength(0);
  });

  it('boots an active ASS track through JASSUB controller worker', async () => {
    const videoRef = createRef<HTMLVideoElement>();
    const track = new SubtitleTrack('English', 'eng');
    const ass = `[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name\nStyle: Default\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello`;
    track.loadText(ass);

    const result = render(
      <div>
        <video ref={videoRef} />
        <SubtitleOverlay
          vidRef={videoRef}
          activeTracks={[track]}
          currentTime={1.5}
        />
      </div>,
    );

    await waitFor(() => expect(jassubMock.instances).toHaveLength(1));
    const instance = jassubMock.instances[0];
    expect(instance.options.video).toBe(videoRef.current);
    expect(instance.options.subContent).toBe(ass);
    expect(instance.options.workerUrl).toContain('worker.js');
    expect(instance.options.workerUrl).not.toContain('wasm/jassub-worker.js');
    expect(instance.options.defaultFont).toBe('liberation sans');
    expect(instance.options.availableFonts?.['liberation sans']).toContain('default.woff2');
    expect(instance.canvas.style.zIndex).toBe('20');

    result.unmount();
    await waitFor(() => expect(instance.destroy).toHaveBeenCalledTimes(1));
  });

  it('contains and reports a synchronous ASS renderer startup failure', async () => {
    const videoRef = createRef<HTMLVideoElement>();
    const track = new SubtitleTrack('English', 'eng');
    track.loadText(`[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name\nStyle: Default\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Fallback Hello`);
    const error = new Error('worker bootstrap failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    jassubMock.throwOnConstruct(error);

    const result = render(
      <div>
        <video ref={videoRef} />
        <SubtitleOverlay vidRef={videoRef} activeTracks={[track]} currentTime={1.5} />
      </div>,
    );

    await waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      '[SUBS-RENDER] ASS renderer startup failed:', error,
    ));
    expect(videoRef.current?.parentElement?.querySelector('canvas.JASSUB')).toBeNull();
    expect(result.container.textContent).toContain('Fallback Hello');
    consoleError.mockRestore();
  });

  it('contains and reports an asynchronous ASS worker startup failure', async () => {
    const videoRef = createRef<HTMLVideoElement>();
    const track = new SubtitleTrack('English', 'eng');
    track.loadText(`[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name\nStyle: Default\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Fallback Hello`);
    const error = new Error('worker module failed to load');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    jassubMock.rejectReady(error);

    const result = render(
      <div>
        <video ref={videoRef} />
        <SubtitleOverlay vidRef={videoRef} activeTracks={[track]} currentTime={1.5} />
      </div>,
    );

    await waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      '[SUBS-RENDER] ASS renderer failed:', error,
    ));
    const instance = jassubMock.instances[0];
    expect(videoRef.current?.parentElement?.querySelector('canvas.JASSUB')).toBeNull();
    await waitFor(() => expect(result.container.textContent).toContain('Fallback Hello'));
    await waitFor(() => expect(instance.terminate).toHaveBeenCalledTimes(1));
    result.unmount();
    expect(instance.destroy).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('recomputes DOM subtitle lines when revision changes after in-place cue mutation', () => {
    const videoRef = createRef<HTMLVideoElement>();
    const track = new SubtitleTrack('English', 'eng');
    track.loadText('1\n00:00:01,000 --> 00:00:02,000\nFirst\n');
    const activeTracks = [track];

    const result = render(
      <div>
        <video ref={videoRef} />
        <SubtitleOverlay vidRef={videoRef} activeTracks={activeTracks} currentTime={1.5} revision={0} />
      </div>,
    );
    expect(result.container.textContent).not.toContain('Second');

    const replacement = new SubtitleTrack('replacement', 'eng');
    replacement.loadText('2\n00:00:01,000 --> 00:00:02,000\nSecond\n');
    track.cues.splice(0, track.cues.length, ...replacement.cues);
    result.rerender(
      <div>
        <video ref={videoRef} />
        <SubtitleOverlay vidRef={videoRef} activeTracks={activeTracks} currentTime={1.5} revision={0} />
      </div>,
    );
    expect(result.container.textContent).not.toContain('Second');

    result.rerender(
      <div>
        <video ref={videoRef} />
        <SubtitleOverlay vidRef={videoRef} activeTracks={activeTracks} currentTime={1.5} revision={1} />
      </div>,
    );

    expect(result.container.textContent).toContain('Second');
  });
});
