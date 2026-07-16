// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { SubtitleTrack } from '../lib/faststream/subtitles/SubtitleTrack';

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,500 --> 00:00:06,000
Second line
with a wrap
`;

const VTT = `WEBVTT

00:00:02.000 --> 00:00:05.000
Already VTT
`;

describe('SubtitleTrack end-to-end parsing (vendored vtt.mjs)', () => {
  it('parses SRT into sorted cues', () => {
    const t = new SubtitleTrack('English', 'en');
    t.loadText(SRT);
    expect(t.cues.length).toBe(2);
    expect(t.cues[0].startTime).toBeCloseTo(1.0, 3);
    expect(t.cues[0].endTime).toBeCloseTo(3.0, 3);
    expect(t.cues[0].text).toContain('Hello world');
    expect(t.cues[1].startTime).toBeCloseTo(4.5, 3);
    expect(t.cues[1].text).toContain('Second line');
  });

  it('parses native WebVTT directly', () => {
    const t = new SubtitleTrack('VTT', 'en');
    t.loadText(VTT);
    expect(t.cues.length).toBe(1);
    expect(t.cues[0].startTime).toBeCloseTo(2.0, 3);
    expect(t.cues[0].text).toContain('Already VTT');
  });

  it('shift() moves all cues by a delta', () => {
    const t = new SubtitleTrack('English', 'en');
    t.loadText(SRT);
    t.shift(1.5);
    expect(t.cues[0].startTime).toBeCloseTo(2.5, 3);
    expect(t.cues[0].endTime).toBeCloseTo(4.5, 3);
  });

  it('shiftAfter() only shifts the given cue and later ones', () => {
    const t = new SubtitleTrack('English', 'en');
    t.loadText(SRT);
    const before0 = t.cues[0].startTime;
    t.shiftAfter(t.cues[1], 2.0);
    expect(t.cues[0].startTime).toBeCloseTo(before0, 3); // unchanged
    expect(t.cues[1].startTime).toBeCloseTo(6.5, 3);     // 4.5 + 2.0
  });

  it('equals() dedups identical tracks', () => {
    const a = new SubtitleTrack('English', 'en');
    a.loadText(SRT);
    const b = new SubtitleTrack('English', 'en');
    b.loadText(SRT);
    expect(a.equals(b)).toBe(true);
  });

  it('detects ASS content as needing the jassub path', () => {
    const t = new SubtitleTrack('Styled', 'en');
    const ass = `[Script Info]
Title: test

[V4+ Styles]
Format: Name

[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,Hello
`;
    t.loadText(ass);
    expect(t.isASS).toBe(true);
  });
});
