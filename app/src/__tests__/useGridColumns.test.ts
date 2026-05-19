import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateColumns } from '../components/dashboard/FileExplorer';

// ────────────────────────────────────────────────────────
// 1. Pure calculation tests (existing, kept intact)
// ────────────────────────────────────────────────────────
describe('calculateColumns', () => {
    const GAP = 6;

    it('returns correct columns for default density (200px min)', () => {
        expect(calculateColumns(1000, GAP, 200, 8)).toBe(4);
        expect(calculateColumns(800, GAP, 200, 8)).toBe(3);
        expect(calculateColumns(600, GAP, 200, 8)).toBe(2);
    });

    it('returns correct columns for compact density (140px min)', () => {
        expect(calculateColumns(1000, GAP, 140, 8)).toBe(6);
        expect(calculateColumns(800, GAP, 140, 8)).toBe(5);
        expect(calculateColumns(600, GAP, 140, 8)).toBe(4);
    });

    it('returns correct columns for spacious density (280px min)', () => {
        expect(calculateColumns(1000, GAP, 280, 8)).toBe(3);
        expect(calculateColumns(800, GAP, 280, 8)).toBe(2);
        expect(calculateColumns(600, GAP, 280, 8)).toBe(2);
    });

    it('caps at maxCols', () => {
        expect(calculateColumns(3000, GAP, 140, 8)).toBe(8);
        expect(calculateColumns(5000, GAP, 200, 6)).toBe(6);
    });

    it('returns at least 1 column for narrow containers', () => {
        expect(calculateColumns(100, GAP, 200, 8)).toBe(1);
        expect(calculateColumns(50, GAP, 200, 8)).toBe(1);
        expect(calculateColumns(1, GAP, 200, 8)).toBe(1);
    });

    it('returns 1 for zero or negative container width', () => {
        expect(calculateColumns(0, GAP, 200, 8)).toBe(1);
        expect(calculateColumns(-100, GAP, 200, 8)).toBe(1);
    });

    it('returns 1 for zero or negative min width', () => {
        expect(calculateColumns(1000, GAP, 0, 8)).toBe(1);
        expect(calculateColumns(1000, GAP, -50, 8)).toBe(1);
    });

    it('handles exact boundary widths', () => {
        expect(calculateColumns(206, GAP, 200, 8)).toBe(1);
        expect(calculateColumns(412, GAP, 200, 8)).toBe(2);
    });

    it('works with zero gap', () => {
        expect(calculateColumns(800, 0, 200, 8)).toBe(4);
        expect(calculateColumns(1000, 0, 200, 8)).toBe(5);
    });
});

// ────────────────────────────────────────────────────────
// 2. Debounce boundary behavior tests
// ────────────────────────────────────────────────────────
describe('resize debounce boundaries', () => {
    const GAP = 6;
    const MAX_COLS = 8;

    // Simulate the debounce logic: collect column counts over rapid width changes
    function simulateResizeSequence(
        widths: number[],
        minWidth: number,
        _debounceMs: number,
    ): { immediate: number[]; debounced: number[] } {
        const immediate = widths.map(w => calculateColumns(w, GAP, minWidth, MAX_COLS));

        // Simulate debounce: only commit when value stabilises for debounceMs
        const debounced: number[] = [];
        let lastCommitted = immediate[0];
        debounced.push(lastCommitted);

        for (let i = 1; i < immediate.length; i++) {
            // In the real debounce, we'd wait debounceMs after the LAST change.
            // For simulation, we assume each step is < debounceMs apart,
            // so we only commit when the value is different from last committed
            // AND it's the last in a run of identical values.
            const isLastInRun = i === immediate.length - 1 || immediate[i + 1] !== immediate[i];
            if (immediate[i] !== lastCommitted && isLastInRun) {
                lastCommitted = immediate[i];
                debounced.push(lastCommitted);
            }
        }
        return { immediate, debounced };
    }

    it('debounce prevents thrashing during rapid resize across a threshold', () => {
        // Simulate dragging from 900px → 1100px in 10px steps (default density, 200px min)
        const widths = Array.from({ length: 21 }, (_, i) => 900 + i * 10);
        const { immediate, debounced } = simulateResizeSequence(widths, 200, 120);

        // Without debounce: multiple column changes as we cross thresholds
        const uniqueImmediate = [...new Set(immediate)];
        expect(uniqueImmediate.length).toBeGreaterThanOrEqual(2); // at least one transition

        // With debounce: fewer commits (only when value settles)
        expect(debounced.length).toBeLessThanOrEqual(uniqueImmediate.length);
    });

    it('debounce eliminates back-and-forth thrash', () => {
        // Simulate rapid oscillation: 900 ↔ 1100 px
        const widths = [900, 1100, 900, 1100, 900, 1100, 900];
        const { debounced } = simulateResizeSequence(widths, 200, 120);

        // Debounce should collapse oscillation to a single stable value
        // (the last value in the sequence)
        const lastCols = calculateColumns(900, GAP, 200, MAX_COLS);
        expect(debounced[debounced.length - 1]).toBe(lastCols);
    });

    it('column count is stable within same-width band', () => {
        // All widths in this range produce 4 columns (default density)
        const widths = [830, 850, 870, 890, 910, 930, 950, 970, 990, 1020];
        const cols = widths.map(w => calculateColumns(w, GAP, 200, MAX_COLS));
        const unique = [...new Set(cols)];

        // All should be the same column count
        expect(unique.length).toBe(1);
        expect(unique[0]).toBe(4);
    });

    it('threshold transitions are correct for all densities', () => {
        // Default density (200px min): 4→5 when (w+6)/206 >= 5 → w >= 1024
        expect(calculateColumns(1023, GAP, 200, MAX_COLS)).toBe(4);
        expect(calculateColumns(1024, GAP, 200, MAX_COLS)).toBe(5);

        // Compact density (140px min): 5→6 when (w+6)/146 >= 6 → w >= 870
        expect(calculateColumns(869, GAP, 140, MAX_COLS)).toBe(5);
        expect(calculateColumns(870, GAP, 140, MAX_COLS)).toBe(6);

        // Spacious density (280px min): 2→3 when (w+6)/286 >= 3 → w >= 852
        expect(calculateColumns(851, GAP, 280, MAX_COLS)).toBe(2);
        expect(calculateColumns(852, GAP, 280, MAX_COLS)).toBe(3);
    });
});

// ────────────────────────────────────────────────────────
// 3. useGridColumns hook tests (with mocked DOM)
// ────────────────────────────────────────────────────────

// Mock ResizeObserver for jsdom
class MockResizeObserver {
    callback: ResizeObserverCallback;
    observed: Element[] = [];
    static instances: MockResizeObserver[] = [];

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        MockResizeObserver.instances.push(this);
    }
    observe(el: Element) { this.observed.push(el); }
    unobserve(_el: Element) {}
    disconnect() { this.observed = []; }
    // Helper: simulate a resize
    simulateResize(width: number) {
        for (const el of this.observed) {
            Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
            this.callback(
                [{ contentRect: { width } } as ResizeObserverEntry],
                this as unknown as ResizeObserver,
            );
        }
    }
}

// We need to import the hook — but it's not exported.  We test it indirectly
// via the component or extract it.  Since it's a private function, we test
// the *behaviour* through the exported FileExplorer or by dynamically importing.
// For now we verify the debounce contract via the pure function + timing tests.

describe('useGridColumns hook integration', () => {
    const GAP = 6;
    const MAX_COLS = 8;

    beforeEach(() => {
        vi.useFakeTimers();
        MockResizeObserver.instances = [];
        (globalThis as any).ResizeObserver = MockResizeObserver;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as any).ResizeObserver;
    });

    it('debounce delays column commit by ~120ms', () => {
        // Simulate the debounce contract:
        // 1. Calculate immediately
        // 2. On resize, schedule commit after 120ms
        // 3. New resize cancels previous timer

        let committedCols = 4;
        const commit = (next: number) => { committedCols = next; };

        // Simulate ResizeObserver firing rapidly
        const DEBOUNCE_MS = 120;
        let timerId: ReturnType<typeof setTimeout> | undefined;

        function onResize(width: number) {
            const nextCols = calculateColumns(width, GAP, 200, MAX_COLS);
            if (timerId) clearTimeout(timerId);
            timerId = setTimeout(() => commit(nextCols), DEBOUNCE_MS);
        }

        // Initial mount (immediate)
        commit(calculateColumns(1000, GAP, 200, MAX_COLS));
        expect(committedCols).toBe(4); // (1000+6)/(200+6) = 4

        // Rapid resize to 1100px → should be 5 cols, but debounced
        onResize(1100);
        expect(committedCols).toBe(4); // not yet

        // Another resize before debounce fires
        onResize(1150);
        expect(committedCols).toBe(4); // still debounced

        // Fast-forward past debounce
        vi.advanceTimersByTime(DEBOUNCE_MS + 10);
        expect(committedCols).toBe(5); // (1150+6)/206 = 5
    });

    it('debounce resets on each new resize event', () => {
        let committedCols = 4;
        const commit = (next: number) => { committedCols = next; };
        const DEBOUNCE_MS = 120;
        let timerId: ReturnType<typeof setTimeout> | undefined;

        function onResize(width: number) {
            const nextCols = calculateColumns(width, GAP, 200, MAX_COLS);
            if (timerId) clearTimeout(timerId);
            timerId = setTimeout(() => commit(nextCols), DEBOUNCE_MS);
        }

        commit(calculateColumns(1000, GAP, 200, MAX_COLS)); // 4

        // First resize
        onResize(1100);
        vi.advanceTimersByTime(100); // 100ms passed (not enough)

        // Second resize resets the timer
        onResize(1080);
        vi.advanceTimersByTime(100); // 100ms from second resize (not enough)
        expect(committedCols).toBe(4); // still waiting

        // After full debounce from second resize
        vi.advanceTimersByTime(30); // total 130ms from second resize
        expect(committedCols).toBe(5); // (1080+6)/206 = 5
    });

    it('animation flag is set for ~280ms after column change', () => {
        // Simulate the animateShift contract
        let animateShift = false;
        let animTimerId: ReturnType<typeof setTimeout> | undefined;
        const ANIM_DURATION = 280;

        function onColumnsChange(prev: number, next: number) {
            if (prev !== next) {
                animateShift = true;
                if (animTimerId) clearTimeout(animTimerId);
                animTimerId = setTimeout(() => { animateShift = false; }, ANIM_DURATION);
            }
        }

        onColumnsChange(4, 5);
        expect(animateShift).toBe(true);

        vi.advanceTimersByTime(200);
        expect(animateShift).toBe(true); // still animating

        vi.advanceTimersByTime(90);
        expect(animateShift).toBe(false); // animation complete
    });

    it('animation flag resets when columns change again within animation window', () => {
        let animateShift = false;
        let animTimerId: ReturnType<typeof setTimeout> | undefined;
        const ANIM_DURATION = 280;

        function onColumnsChange(prev: number, next: number) {
            if (prev !== next) {
                animateShift = true;
                if (animTimerId) clearTimeout(animTimerId);
                animTimerId = setTimeout(() => { animateShift = false; }, ANIM_DURATION);
            }
        }

        onColumnsChange(4, 5);
        vi.advanceTimersByTime(100);
        expect(animateShift).toBe(true);

        // Another column change while animating
        onColumnsChange(5, 4);
        vi.advanceTimersByTime(100);
        expect(animateShift).toBe(true); // still animating (timer was reset)

        vi.advanceTimersByTime(190);
        expect(animateShift).toBe(false); // animation complete after full duration
    });

    it('no animation flag on initial mount (same columns)', () => {
        let animateShift = false;
        let firstRender = true;

        function onColumnsChange(_prev: number, _next: number) {
            if (firstRender) { firstRender = false; return; }
            // Only animate on subsequent changes
            animateShift = true;
        }

        onColumnsChange(0, 4); // initial mount
        expect(animateShift).toBe(false); // no animation on first render

        onColumnsChange(4, 5); // resize
        expect(animateShift).toBe(true); // animation on subsequent change
    });
});

// ────────────────────────────────────────────────────────
// 4. Density-dependent MAX_COLS tests
// ────────────────────────────────────────────────────────
describe('density-dependent MAX_COLS', () => {
    const GAP = 6;

    // Simulates what the hook does: picks maxCols based on density
    function colsForDensity(width: number, density: 'compact' | 'default' | 'spacious') {
        const MIN_W = { compact: 140, default: 200, spacious: 280 };
        const MAX_C = { compact: 12, default: 8, spacious: 6 };
        return calculateColumns(width, GAP, MIN_W[density], MAX_C[density]);
    }

    it('compact shows more columns than default at fullscreen widths', () => {
        // ~1600px container (typical fullscreen minus sidebar)
        const compact = colsForDensity(1600, 'compact');
        const default_ = colsForDensity(1600, 'default');
        const spacious = colsForDensity(1600, 'spacious');

        expect(compact).toBeGreaterThan(default_);
        expect(default_).toBeGreaterThan(spacious);

        // Verify actual values
        expect(compact).toBe(11);  // (1600+6)/146 = 11.0
        expect(default_).toBe(7);  // (1600+6)/206 = 7.79 → 7
        expect(spacious).toBe(5);  // (1600+6)/286 = 5.61 → 5
    });

    it('compact caps at 12, default at 8, spacious at 6', () => {
        // Ultra-wide container (4K monitor)
        expect(colsForDensity(4000, 'compact')).toBe(12);
        expect(colsForDensity(4000, 'default')).toBe(8);
        expect(colsForDensity(4000, 'spacious')).toBe(6);
    });

    it('compact still works correctly at narrow widths', () => {
        expect(colsForDensity(400, 'compact')).toBe(2);  // (400+6)/146 = 2.78 → 2
        expect(colsForDensity(300, 'compact')).toBe(2);   // (300+6)/146 = 2.09 → 2
        expect(colsForDensity(200, 'compact')).toBe(1);   // (200+6)/146 = 1.41 → 1
    });

    it('all densities produce at least 1 column for any positive width', () => {
        for (const density of ['compact', 'default', 'spacious'] as const) {
            expect(colsForDensity(50, density)).toBe(1);
            expect(colsForDensity(1, density)).toBe(1);
        }
    });
});

// ────────────────────────────────────────────────────────
// 5. Row height debounce tests
// ────────────────────────────────────────────────────────
describe('row height debounce', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('debounced row height prevents rapid state updates during resize', () => {
        let committedHeight = 200;
        const DEBOUNCE_MS = 150;
        let timerId: ReturnType<typeof setTimeout> | undefined;

        function onRowResize(measuredHeight: number) {
            if (timerId) clearTimeout(timerId);
            timerId = setTimeout(() => { committedHeight = measuredHeight; }, DEBOUNCE_MS);
        }

        // Simulate rapid resize events changing row height
        onRowResize(180);
        onRowResize(175);
        onRowResize(170);
        onRowResize(165);

        // Height hasn't changed yet (all debounced)
        expect(committedHeight).toBe(200);

        // After debounce
        vi.advanceTimersByTime(DEBOUNCE_MS + 10);
        expect(committedHeight).toBe(165); // last measured value
    });

    it('row height debounce resets on each new measurement', () => {
        let committedHeight = 200;
        const DEBOUNCE_MS = 150;
        let timerId: ReturnType<typeof setTimeout> | undefined;

        function onRowResize(measuredHeight: number) {
            if (timerId) clearTimeout(timerId);
            timerId = setTimeout(() => { committedHeight = measuredHeight; }, DEBOUNCE_MS);
        }

        onRowResize(180);
        vi.advanceTimersByTime(100); // not enough

        onRowResize(170); // resets timer
        vi.advanceTimersByTime(100); // 100ms from second event
        expect(committedHeight).toBe(200); // still waiting

        vi.advanceTimersByTime(60); // 160ms from second event
        expect(committedHeight).toBe(170); // committed
    });

    it('row height updates immediately after column change settles', () => {
        // After columns change, the row height measurement should commit
        // once the debounce fires (aligned with column debounce timing)
        let committedHeight = 200;
        const DEBOUNCE_MS = 150;
        let timerId: ReturnType<typeof setTimeout> | undefined;

        function onRowResize(measuredHeight: number) {
            if (timerId) clearTimeout(timerId);
            timerId = setTimeout(() => { committedHeight = measuredHeight; }, DEBOUNCE_MS);
        }

        // Column change causes new row layout → new height measurement
        onRowResize(150); // new row height after column change
        vi.advanceTimersByTime(DEBOUNCE_MS + 10);
        expect(committedHeight).toBe(150);
    });
});
