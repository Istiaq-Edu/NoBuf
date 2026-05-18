---
name: react-performance
description: React 19 performance patterns — memo, refs, suspense, virtual lists, and avoiding common re-render traps
user-invocable: true
---

## React Performance Guide

Expert guidance for high-performance React 19 apps, especially streaming/media UIs.

### Rules of Hooks
- **useRef for sync checks in async loops** — State updates are async; refs are sync. Use `ref.current` for immediate reads inside `setInterval`, async callbacks
- **Don't abort async ops in useEffect cleanup** — Use refs to gate operations instead of AbortController for internal async
- **Memo expensive computations** — `useMemo` for derived data, `useCallback` for stable function references passed to children

### Re-render Prevention
```typescript
// BAD — new object every render
<Child style={{ color: 'red' }} />

// GOOD — stable reference
const style = useMemo(() => ({ color: 'red' }), []);
<Child style={style} />
```

### Virtual Lists (TanStack Virtual)
- Use `@tanstack/react-virtual` for large lists (100+ items)
- Estimate item sizes accurately — wrong estimates cause scroll jumps
- `overscan: 5-10` is usually enough

### React Query (TanStack)
- `staleTime` — how long data is considered fresh (default: 0)
- `gcTime` — how long unused data stays in cache (default: 5min)
- `refetchOnWindowFocus: false` for desktop apps (no tab switching)
- Use `queryKey` arrays with stable references

### Async Initialization Pattern
```typescript
const initialized = useRef(false);
useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    // Safe async work here
}, []);
```

### State vs Ref Decision
| Use Case | Choice |
|----------|--------|
| Triggers re-render | `useState` |
| Read in async callback | `useRef` |
| DOM element reference | `useRef` |
| Previous value | `useRef` |
| Form input | `useState` |

### Common Traps
- `Array.every()` / `Array.some()` return `true` for empty arrays — guard with `.length > 0`
- `useEffect` with object/array deps causes infinite loops — memoize or use primitives
- Don't put large data in state if it doesn't affect render — use refs
- `framer-motion` animations can cause layout thrashing — use `transform` and `opacity` only
