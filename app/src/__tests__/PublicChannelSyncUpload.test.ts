// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression guard for the "public channels never sync to other devices" bug.
//
// Root cause (verified in code + live DB): the [NB-PUB] sync upload
// (cmd_update_nb_pub_sync) was only wired into usePublicChannels mutations —
// but AddChannelModal invokes cmd_join_channel_by_link / cmd_add_joined_channel
// DIRECTLY. The hook mutations were dead code; every add committed locally and
// never uploaded, so other devices never saw the channel.
//
// These structural asserts bind to the shipped AddChannelModal source so a
// future add path that skips the sync upload fails CI.
const modalSrc = readFileSync(
  path.resolve(process.cwd(), 'src/components/dashboard/AddChannelModal.tsx'),
  'utf8',
  // Normalize EOL: the repo stores LF but Windows checkouts get CRLF
  // (core.autocrlf), and an EOL-sensitive needle would only be green on one OS.
).replace(/\r\n/g, '\n');

function invokeSites(command: string): number[] {
  const needle = `invoke<PublicChannel>('${command}'`;
  const indexes: number[] = [];
  let i = modalSrc.indexOf(needle);
  while (i !== -1) {
    indexes.push(i);
    i = modalSrc.indexOf(needle, i + 1);
  }
  return indexes;
}

describe('public channel add paths upload to [NB-PUB] sync', () => {
  it('defines a shared uploadSync helper that calls cmd_update_nb_pub_sync', () => {
    expect(modalSrc).toContain('const uploadSync = () => {');
    expect(modalSrc).toContain("invoke('cmd_update_nb_pub_sync')");
  });

  it('every cmd_join_channel_by_link site is followed by uploadSync()', () => {
    const sites = invokeSites('cmd_join_channel_by_link');
    expect(sites.length).toBeGreaterThanOrEqual(1);
    for (const site of sites) {
      // Look at the next 800 chars after the invoke: the upload must fire
      // somewhere between the invoke and the modal closing / error handling.
      const window = modalSrc.slice(site, site + 800);
      expect(
        window.includes('uploadSync()'),
        `cmd_join_channel_by_link site at offset ${site} has no uploadSync() in the following 800 chars — a local-only add`
      ).toBe(true);
    }
  });

  it('every cmd_add_joined_channel site is followed by uploadSync()', () => {
    const sites = invokeSites('cmd_add_joined_channel');
    expect(sites.length).toBeGreaterThanOrEqual(1);
    for (const site of sites) {
      const window = modalSrc.slice(site, site + 800);
      expect(
        window.includes('uploadSync()'),
        `cmd_add_joined_channel site at offset ${site} has no uploadSync() in the following 800 chars — a local-only add`
      ).toBe(true);
    }
  });
});
