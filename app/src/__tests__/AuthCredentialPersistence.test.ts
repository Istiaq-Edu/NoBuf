// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression guard for the "asks for login on every startup" bug.
//
// Root cause (verified on-disk): the Telegram MTProto session (telegram.session)
// persists fine, but App.tsx gates startup on `api_id` being present in
// config.json:
//     const savedId = await store.get("api_id");
//     if (!savedId) { setAuthStatus("unauthenticated"); return; }
// `api_id` is only written by saveCredentials(), which historically was called
// ONLY from the manual setup form (handleSetupSubmit). The QR / auto-extract /
// phone-code / 2FA success paths called onLogin() directly and never persisted
// api_id, so a real login never survived restart.
//
// The fix routes EVERY login-success path through finishLogin(), which calls
// saveCredentials() (persists api_id to config.json) before onLogin(). These
// structural asserts bind to the shipped AuthWizard source so a future success
// path that skips persistence fails CI.
const authWizardSrc = readFileSync(
  path.resolve(process.cwd(), 'src/components/AuthWizard.tsx'),
  'utf8',
);

describe('auth credential persistence (login survives restart)', () => {
  it('finishLogin persists credentials before signalling success', () => {
    const start = authWizardSrc.indexOf('const finishLogin = async');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = authWizardSrc.slice(start, start + 200);
    // Must save BEFORE calling onLogin — order matters so api_id is on disk
    // by the time the parent flips to the dashboard.
    const saveIdx = body.indexOf('await saveCredentials()');
    const loginIdx = body.indexOf('onLogin()');
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(loginIdx).toBeGreaterThan(saveIdx);
  });

  it('saveCredentials writes api_id to config.json', () => {
    const start = authWizardSrc.indexOf('const saveCredentials = async');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = authWizardSrc.slice(start, start + 400);
    expect(body).toContain("load('config.json')");
    expect(body).toContain("store.set('api_id'");
    expect(body).toContain('await store.save()');
  });

  it('every real login-success path routes through finishLogin, not bare onLogin', () => {
    // The ONLY places a bare onLogin() is allowed:
    //   - the prop declaration / destructure
    //   - inside finishLogin itself
    //   - the useEffect deps array
    //   - the DEV-only "Dev Mode" button (import.meta.env.DEV)
    // Any other bare onLogin() means a success path skipped credential persistence.
    const lines = authWizardSrc.split('\n');
    const offending: string[] = [];
    lines.forEach((line) => {
      if (!/onLogin\s*\(/.test(line)) return;
      const t = line.trim();
      if (t.startsWith('export function AuthWizard')) return; // prop decl
      if (t.includes('await finishLogin()')) return; // the fix
      if (t.includes('const finishLogin')) return;
      if (t === 'onLogin();') return; // inside finishLogin body
      if (t.includes('[qrPolling')) return; // useEffect deps
      if (t.includes('onClick={() => onLogin()}')) return; // DEV-only button
      offending.push(t);
    });
    expect(offending).toEqual([]);
  });

  it('QR, phone-code and 2FA success handlers all call finishLogin', () => {
    // QR immediate-authorized path
    expect(authWizardSrc).toContain('await finishLogin();\r\n                return;');
    // phone code + 2FA success (both are: if (res.success) { await finishLogin(); })
    const successCalls = authWizardSrc.match(/if \(res\.success\) \{ await finishLogin\(\);/g) ?? [];
    expect(successCalls.length).toBeGreaterThanOrEqual(2);
  });
});
