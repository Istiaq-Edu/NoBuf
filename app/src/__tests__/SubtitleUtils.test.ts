import { describe, it, expect } from 'vitest';
import {
  srt2webvtt,
  cuesToSrt,
  vttTimeFormat,
  srtTimeFormat,
  translateXMLEntities,
  convertSubtitleFormatting,
} from '../lib/faststream/subtitles/SubtitleUtils';

describe('SubtitleUtils.srt2webvtt', () => {
  it('adds a WEBVTT header and converts comma ms to dot ms', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,000',
      'Hello world',
      '',
      '2',
      '00:00:05,500 --> 00:00:08,250',
      'Second line',
    ].join('\n');

    const vtt = srt2webvtt(srt);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.000');
    expect(vtt).toContain('00:00:05.500 --> 00:00:08.250');
    expect(vtt).toContain('Hello world');
    expect(vtt).toContain('Second line');
  });

  it('handles CRLF line endings', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nCRLF cue';
    const vtt = srt2webvtt(srt);
    expect(vtt).toContain('00:00:01.000 --> 00:00:02.000');
    expect(vtt).toContain('CRLF cue');
  });
});

describe('SubtitleUtils time formatting', () => {
  it('formats VTT time with dot separator', () => {
    expect(vttTimeFormat(3661.5)).toBe('01:01:01.500');
    expect(vttTimeFormat(0)).toBe('00:00:00.000');
  });

  it('formats SRT time with comma separator', () => {
    expect(srtTimeFormat(3661.5)).toBe('01:01:01,500');
    expect(srtTimeFormat(0)).toBe('00:00:00,000');
  });
});

describe('SubtitleUtils.cuesToSrt', () => {
  it('serializes cues to numbered SRT blocks', () => {
    const srt = cuesToSrt([
      { startTime: 1, endTime: 4, text: 'One' },
      { startTime: 5, endTime: 8, text: 'Two' },
    ]);
    expect(srt).toContain('1\n00:00:01,000 --> 00:00:04,000\nOne');
    expect(srt).toContain('2\n00:00:05,000 --> 00:00:08,000\nTwo');
  });
});

describe('SubtitleUtils.translateXMLEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(translateXMLEntities('a &amp; b')).toBe('a & b');
    expect(translateXMLEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(translateXMLEntities('&#65;&#x42;')).toBe('AB');
  });

  it('returns input unchanged when no entities present', () => {
    expect(translateXMLEntities('plain text')).toBe('plain text');
  });
});

describe('SubtitleUtils.convertSubtitleFormatting', () => {
  it('converts bold/italic/underline tags to HTML', () => {
    expect(convertSubtitleFormatting('{\\b1}bold{\\b}')).toBe('<b>bold</b>');
    expect(convertSubtitleFormatting('{\\i1}it{\\i}')).toBe('<i>it</i>');
  });

  it('converts hard spaces to regular spaces', () => {
    expect(convertSubtitleFormatting('a\\hb')).toBe('a b');
  });

  it('strips leftover alignment tags', () => {
    expect(convertSubtitleFormatting('{\\an8}text')).toBe('text');
  });
});
