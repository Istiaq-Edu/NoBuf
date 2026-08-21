// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Structural guards for the external drag-drop overlay + wiring fixes.
//
// WebView2 fires NO event when an OS drag is cancelled mid-window (Esc) — dragleave
// carries in-window coords and dragend never reaches the page. The shipped overlay
// therefore stranded on screen until the next drop. These asserts pin the three
// dismissal mechanisms (edge-leave, Escape, activity watchdog) to the shipped
// Dashboard source, so a refactor that drops one fails CI.
//
// Same pattern as QrPollTokenSync.test.ts: bind to the SHIPPED file bytes.

function src(rel: string): string {
    return readFileSync(path.resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
}

describe('external drag overlay dismissal', () => {
    const dash = () => src('src/components/Dashboard.tsx');

    it('registers all three dismissal mechanisms', () => {
        const s = dash();
        expect(s).toContain("e.key === 'Escape'");                    // Esc cancels
        expect(s).toContain('lastExternalDragActivityRef.current > 700'); // dead-drag watchdog
        expect(s).toContain('clientX >= window.innerWidth');          // edge-leave (original)
        // heartbeat is fed by BOTH dragover and drop
        expect(s.match(/lastExternalDragActivityRef\.current = Date\.now\(\)/g)?.length).toBe(2);
    });

    it('watchdog only runs while the overlay is up', () => {
        const s = dash();
        const start = s.indexOf('if (!externalDragActive) return;');
        expect(start).toBeGreaterThan(-1);
        const body = s.slice(start, start + 700);
        expect(body).toContain('setInterval');
        expect(body).toContain("removeEventListener('keydown', onKey)");
    });

    it('overlay renders accept/reject variants from live upload permission', () => {
        const s = dash();
        expect(s).toContain("variant={canUploadHere ? 'accept' : 'reject'}");
    });
});

describe('sidebar highlight does not lie about external drops', () => {
    it('suppresses the folder highlight for Files drags (drop is captured away)', () => {
        const s = src('src/components/dashboard/SidebarItem.tsx');
        expect(s).toContain('isExternalFilesDrag');
        expect(s).toMatch(/!isReorderDrag\(e\) && !isExternalFilesDrag\(e\)/);
    });
});

describe('staged uploads keep their original name end-to-end', () => {
    it('frontend passes displayName through cmd_upload_file', () => {
        const s = src('src/hooks/useFileUpload.ts');
        expect(s).toContain('displayName: item.displayName ?? null');
    });

    it('backend prefers display_name and falls back to the path basename', () => {
        const rust = readFileSync(
            path.resolve(process.cwd(), 'src-tauri/src/commands/fs.rs'), 'utf8',
        ).replace(/\r\n/g, '\n');
        expect(rust).toContain('display_name: Option<String>');
        expect(rust).toContain('effective_document_name(&display_name, &path)');
    });

    it('queue UI shows the display name, not the temp path', () => {
        const s = src('src/components/dashboard/UploadQueue.tsx');
        expect(s).toContain('item.displayName || item.path.split(/[\\\\/]/).pop()');
    });

    it('double-drop dedupe reads the live queue mirror', () => {
        const s = src('src/hooks/useFileUpload.ts');
        const start = s.indexOf('const activeNames = new Set(');
        expect(start).toBeGreaterThan(-1);
        const body = s.slice(start, start + 300);
        expect(body).toContain('queueMirrorRef.current');
        expect(body).toContain("i.status === 'pending' || i.status === 'uploading'");
    });
});

describe('staged temp files are excluded from store persistence', () => {
    it('persistence filter is wired into the store effect', () => {
        const s = src('src/hooks/useFileUpload.ts');
        const start = s.indexOf("store.set('uploadQueue'");
        expect(start).toBeGreaterThan(-1);
        const before = s.slice(Math.max(0, start - 200), start);
        expect(before).toContain('persistableQueueItems(');
    });

    it('cleanup command is guarded to the staging dir backend-side', () => {
        const rust = readFileSync(
            path.resolve(process.cwd(), 'src-tauri/src/commands/fs.rs'), 'utf8',
        ).replace(/\r\n/g, '\n');
        expect(rust).toContain('Refusing to delete outside staging dir');
        expect(rust).toContain('ErrorKind::NotFound => Ok(())');
    });

    it('processItem wires cleanup into the retryable-lifecycle paths (success/pending-remove/cancelAll)', () => {
        // Exactly 4 occurrences: 1 definition + success + pending-item removal +
        // cancelAll's bulk-pending strip. Cleanup fires ONLY where the item can
        // never be retried again; cancelled/errored items KEEP their temp file so
        // Retry works (a cancelled drop whose temp was deleted would fail Retry
        // with "Invalid path").
        const s = src('src/hooks/useFileUpload.ts');
        expect(s.match(/cleanupStagedTemp\(/g)?.length).toBe(4);
        // The cancel branches must NOT clean up — pinned by absence inside processItem's catch
        const catchStart = s.indexOf("if (errMsg.includes('Transfer cancelled'))");
        const catchBody = s.slice(catchStart, catchStart + 400);
        expect(catchBody).not.toContain('cleanupStagedTemp');
    });
});
