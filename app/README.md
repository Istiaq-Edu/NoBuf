# NoBuf — app

Application source. See the [root README](../README.md) for what NoBuf is and how to
install it.

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # production build
npm test               # unit tests
npx tsc --noEmit       # typecheck
```

`npm test` and `npx tsc --noEmit` are what CI runs on every push and PR.
