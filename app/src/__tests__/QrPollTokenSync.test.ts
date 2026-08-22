// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression guard for the "stuck on Waiting for scan" QR-login bug.
//
// Root cause (source-verified): Telegram's QR login token expires in ~30
// seconds (core.telegram.org/api/qr-login), and cmd_auth_qr_poll rotates it —
// every probe stores the refreshed token in state.qr_token. But the rotated
// URL never reached the UI: QrLoginPanel kept rendering the ORIGINAL
// tg://login URL, so a scan more than ~30s after the panel opened hit an
// expired token that could never complete. The backend then stayed on
// waiting forever (is_authorized() is false until finalization succeeds),
// and the panel showed "Waiting for scan…" indefinitely.
//
// Fix: the poll handler now fetches the backend's current token URL via
// cmd_auth_qr_current and re-renders the QR whenever it rotated. These
// structural asserts bind to the shipped AuthWizard source so a future edit
// that drops the sync fails CI.
const authWizardSrc = readFileSync(
  path.resolve(process.cwd(), 'src/components/AuthWizard.tsx'),
  'utf8',
  // Normalize EOL like AuthCredentialPersistence.test.ts — this file checks
  // out CRLF on Windows runners and LF elsewhere.
).replace(/\r\n/g, '\n');

describe('QR poll keeps the rendered code in sync with the rotating token', () => {
  it('poll handler applies the current QR URL while still waiting', () => {
    const start = authWizardSrc.indexOf('res.next_step === "waiting"');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = authWizardSrc.slice(start, start + 600);
    expect(body).toContain('cmd_auth_qr_current');
    // Functional setState: only re-renders when the token actually rotated.
    expect(body).toContain('setQrUrl((prev) =>');
  });

  it('the sync lives inside the qrPolling effect, not a one-shot path', () => {
    const effectStart = authWizardSrc.indexOf('qrPollRef.current = setInterval');
    expect(effectStart).toBeGreaterThanOrEqual(0);
    const effectEnd = authWizardSrc.indexOf('}, [qrPolling', effectStart);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const effectBody = authWizardSrc.slice(effectStart, effectEnd);
    expect(effectBody).toContain('cmd_auth_qr_current');
  });

  it('listens for qr-scan-detected and flips to scanned feedback', () => {
    // Instant feedback fix: backend watcher emits within ~5s of acceptance;
    // the poll loop alone can leave "Waiting for scan..." showing ~20s.
    expect(authWizardSrc).toContain('listen<boolean>("qr-scan-detected"');
    const panelStart = authWizardSrc.indexOf('function QrLoginPanel');
    const panelBody = authWizardSrc.slice(panelStart);
    expect(panelBody).toContain('qrScanned ?');
    expect(panelBody).toContain('QR code scanned \u2014 signing you in…'.replace('\\u2014', '\u2014'));
  });

  it('poll catch never swallows handler errors silently', () => {
    // The 2026-08-21 stuck run: handle_2fa failed backend-side, the poll catch
    // swallowed it, and the UI sat on "Waiting for scan..." with zero signal.
    const catchStart = authWizardSrc.indexOf('} catch (pollErr) {');
    expect(catchStart).toBeGreaterThan(-1);
    const body = authWizardSrc.slice(catchStart, catchStart + 700);
    expect(body).toContain('console.error');
    expect(body).toContain('setQrPollError(');
  });

  it('success/expired paths are checked before the waiting-sync branch', () => {
    // Order matters: success and expired must short-circuit before we touch
    // the QR URL, or a completing login could clobber its own state.
    const successIdx = authWizardSrc.indexOf('if (res.success)');
    const expiredIdx = authWizardSrc.indexOf('res.next_step === "expired"');
    const waitingIdx = authWizardSrc.indexOf('res.next_step === "waiting"');
    expect(successIdx).toBeGreaterThan(-1);
    expect(expiredIdx).toBeGreaterThan(successIdx);
    expect(waitingIdx).toBeGreaterThan(expiredIdx);
  });
});
