import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Round-27 — the seek abort proven by the 27-c diagnostic.
 *
 * 27-c:100  bisect: cluster for 956.6s at byte=161496300      <- SUCCEEDED
 * 27-c:101  Seek canceled/disposed: superseded=false (gen 4->4)
 *           aborted=false disposed=false expectedErr=true
 *           err=[TauriStreamSource] read aborted (superseded by seek)
 *
 * Nothing about that seek was stale: same generation, no abort, no dispose.
 * The seek was killed by the condemnation IT SET ON ITSELF at the re-arm, which
 * then condemned the `getKeyPacket` keyframe walk. The bisect is immune (raw
 * global fetch); the walk is not — it reads cluster bytes through
 * TauriStreamSource. Result: every seek rerouted the whole file to /remux.
 *
 * Structural, because the ordering IS the bug: a behavioural test that stubs
 * mediabunny would pass against either ordering. What must hold is that no
 * getKeyPacket call site can be reached while the source is condemned.
 */

const SRC = readFileSync(
  join(__dirname, '../lib/faststream/players/MediabunnyTransmuxer.ts'),
  'utf8',
);

/** Body of `async seekTo(...)`, where the condemnation lifecycle lives. */
function seekToBody(): string {
  const start = SRC.indexOf('async seekTo(');
  expect(start).toBeGreaterThan(-1);
  // The forward iteration helper that follows seekTo bounds the region.
  const end = SRC.indexOf('private async iterateVideoPackets', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/**
 * Walk the condemnation state machine over seekTo in source order and return
 * every getKeyPacket call reached while condemned.
 */
function condemnedReads(): { offset: number; line: number }[] {
  const body = seekToBody();
  const bodyStart = SRC.indexOf('async seekTo(');
  const events: { at: number; kind: 'arm' | 'release' | 'read' }[] = [];

  const push = (re: RegExp, kind: 'arm' | 'release' | 'read') => {
    for (const m of body.matchAll(re)) events.push({ at: m.index!, kind });
  };
  push(/abortInFlight\?\.\(\)/g, 'arm');
  push(/resetSupersession\?\.\(\)/g, 'release');
  push(/await videoSink\.getKeyPacket\(/g, 'read');
  events.sort((a, b) => a.at - b.at);

  const bad: { offset: number; line: number }[] = [];
  let condemned = false;
  for (const e of events) {
    if (e.kind === 'arm') condemned = true;
    else if (e.kind === 'release') condemned = false;
    else if (condemned) {
      const abs = bodyStart + e.at;
      bad.push({ offset: abs, line: SRC.slice(0, abs).split('\n').length });
    }
  }
  return bad;
}

describe('round-27: the keyframe walk must never run condemned', () => {
  it('no getKeyPacket call in seekTo is reachable while the source is condemned', () => {
    const bad = condemnedReads();
    expect(
      bad,
      bad.length
        ? `getKeyPacket runs condemned at line(s) ${bad.map((b) => b.line).join(', ')} — `
          + `this is the 27-c abort: the walk throws '(superseded by seek)' and the `
          + `whole file reroutes to /remux`
        : '',
    ).toEqual([]);
  });

  it('still condemns the bisect — the round-24 win must not be given back', () => {
    const body = seekToBody();
    const bisect = body.indexOf('await this.bisectSeekTarget(');
    expect(bisect).toBeGreaterThan(-1);

    // Mutation-driven: an earlier version of this test used `lastIndexOf(arm)`
    // and passed even when the search-phase arm was deleted outright, because
    // it silently matched the ENTRY arm ~200 lines earlier. Anchor on the arm
    // that sits between the metadata release and the bisect instead — that is
    // the one whose absence un-fences the search.
    const release = body.indexOf('resetSupersession?.()');
    expect(release).toBeGreaterThan(-1);
    const armAfterRelease = body.indexOf('abortInFlight?.()', release);
    expect(
      armAfterRelease,
      'no condemnation is armed between the metadata reads and the bisect — '
      + 'stale refill reads can now race the search (round-24 regression)',
    ).toBeGreaterThan(-1);
    expect(
      armAfterRelease,
      'the search-phase condemnation must be armed BEFORE the bisect',
    ).toBeLessThan(bisect);
  });

  it('releases between the bisect and the walk on the cue-less path', () => {
    const body = seekToBody();
    const bisect = body.indexOf('await this.bisectSeekTarget(');
    const walk = body.indexOf('await videoSink.getKeyPacket(seekTime, { verifyKeyPackets: true })', bisect);
    expect(walk).toBeGreaterThan(bisect);
    const release = body.lastIndexOf('resetSupersession?.()', walk);
    expect(
      release,
      'the cue-less walk (the 27-c failure site) must be preceded by a release',
    ).toBeGreaterThan(bisect);
  });

  it('the indexed path releases before its own walk too', () => {
    const body = seekToBody();
    const walk = body.indexOf('await videoSink.getKeyPacket(seekTargetTs,');
    expect(walk).toBeGreaterThan(-1);
    const release = body.lastIndexOf('resetSupersession?.()', walk);
    const arm = body.lastIndexOf('abortInFlight?.()', walk);
    expect(
      release,
      'the indexed walk must not inherit the search-phase condemnation',
    ).toBeGreaterThan(arm);
  });

  it('the diagnostic still names every branch that can swallow a seek', () => {
    // Without these the next failure is another round of guessing: 26-c printed
    // "(expected during seek)" and nothing else, hiding a live-generation abort.
    const cancelLog = SRC.slice(SRC.indexOf('Seek canceled/disposed'));
    for (const field of ['superseded=', 'aborted=', 'disposed=', 'expectedErr=', 'err=']) {
      expect(cancelLog.slice(0, 600)).toContain(field);
    }
  });
});
