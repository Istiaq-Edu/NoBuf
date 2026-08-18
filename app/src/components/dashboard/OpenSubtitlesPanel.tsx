import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { parseFilename, matchLabel, SUB_LANGUAGES } from '../../lib/faststream/subtitles/openSubtitles';
import { formatResetIn } from '../../context/SettingsContext';

/** One row as returned by cmd_opensubtitles_search (see commands/opensubtitles.rs). */
export interface OsResult {
  file_id: number;
  file_name: string;
  release: string;
  language: string;
  download_count: number;
  moviehash_match: boolean;
  hearing_impaired: boolean;
  fps: number | null;
  /** Machine/AI generated text — worth flagging, not worth reordering on. */
  machine_translated: boolean;
  from_trusted: boolean;
}

interface OsSearchResponse {
  results: OsResult[];
  total_count: number;
  matched_by: string;
}

interface OsDownloadResponse {
  text: string;
  file_name: string;
  remaining: number;
  reset_time: string;
}

interface Props {
  /** Filename of the playing file, used to pre-fill the query. */
  filename: string;
  apiKey: string;
  /** Preferred language code, persisted in settings. */
  language: string;
  onLanguageChange: (code: string) => void;
  /**
   * Daily quota as last reported by the API, already expiry-checked by the caller.
   * null means "unknown" — no download has reported it yet this period.
   */
  quota: { remaining: number; resetAtMs: number } | null;
  /** Persists a freshly reported quota so it survives closing the panel. */
  onQuotaReported: (remaining: number, resetTime: string) => void;
  /** Resolves the file's moviehash (backend range fetch). Null when unavailable. */
  fetchMovieHash: () => Promise<{ hash: string; size: number } | null>;
  /** Called with the downloaded subtitle text; the caller creates the track. */
  onPicked: (text: string, label: string, language: string) => void;
  onClose: () => void;
  /** Opens the OpenSubtitles signup page in the user's browser. */
  onGetKey: () => void;
}

/**
 * OpenSubtitles search panel.
 *
 * A separate modal rather than a CC-menu section: it needs a query box, language
 * chips and a scrollable result list, none of which fit in a popover.
 *
 * Two behaviours worth knowing:
 *  - Search tries the byte-exact **moviehash** first and falls back to a filename
 *    query automatically (both inside one Rust call), so a file whose name carries
 *    no information — the Telegram norm — still finds subtitles.
 *  - The free API tier allows **5 downloads per day**. `remaining` is shown at all
 *    times and download buttons disable at 0, because discovering the limit via an
 *    error after clicking would be worse.
 */
export function OpenSubtitlesPanel({
  filename,
  apiKey,
  language,
  onLanguageChange,
  quota,
  onQuotaReported,
  fetchMovieHash,
  onPicked,
  onClose,
  onGetKey,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Memoized on filename: parseFilename allocates, and `parsed` is a dependency of
  // the search callback — a fresh object each render would defeat its memoization.
  const parsed = useMemo(() => parseFilename(filename), [filename]);
  const [query, setQuery] = useState(parsed.query);
  const [state, setState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [results, setResults] = useState<OsResult[]>([]);
  const [matchedBy, setMatchedBy] = useState('none');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const hasKey = apiKey.trim().length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const runSearch = useCallback(async () => {
    if (!hasKey) return;
    setState('searching');
    setError('');
    setResults([]);
    try {
      // The hash is an enhancement, never a prerequisite: if it fails we still
      // search by name rather than showing nothing.
      const mh = await fetchMovieHash().catch(() => null);
      const resp = await invoke<OsSearchResponse>('cmd_opensubtitles_search', {
        apiKey,
        languages: language,
        query: query.trim() || null,
        moviehash: mh?.hash ?? null,
        // Episode coordinates come from the FILENAME, not the edited query box, so a
        // user retyping the title cannot accidentally widen the search back to the
        // whole series. Verified live: without these, "breaking bad" returns 2834
        // rows led by the El Camino movie; with them, 19 rows that are all S5E14.
        season: parsed.season,
        episode: parsed.episode,
      });
      setResults(resp.results);
      setMatchedBy(resp.matched_by);
      setState('done');
    } catch (e) {
      setError(String(e));
      setState('error');
    }
  }, [hasKey, apiKey, language, query, parsed, fetchMovieHash]);

  const download = useCallback(async (r: OsResult) => {
    setBusyId(r.file_id);
    setError('');
    try {
      const resp = await invoke<OsDownloadResponse>('cmd_opensubtitles_download', {
        apiKey,
        fileId: r.file_id,
      });
      // Persist BEFORE handing the text over: onPicked triggers onClose, which
      // unmounts this component, so a setState here would be lost.
      onQuotaReported(resp.remaining, resp.reset_time);
      onPicked(resp.text, r.release || r.file_name, r.language);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }, [apiKey, onPicked, onClose, onQuotaReported]);

  const quotaSpent = quota !== null && quota.remaining <= 0;
  // Computed at render, not stored: the countdown is only shown while the panel is
  // open, so a live ticker would be churn for no benefit.
  const resetIn = quota ? formatResetIn(quota.resetAtMs, Date.now()) : '';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-md"
      onClick={(e) => { if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose(); }}
    >
      <div
        ref={panelRef}
        className="relative bg-[#161616]/98 backdrop-blur-xl border border-white/[0.06] rounded-2xl p-5 w-[560px] max-w-[94vw] shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-white text-base font-semibold leading-none">Search subtitles online</h3>
            <p className="text-white/40 text-xs mt-1.5 leading-none">OpenSubtitles.com</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors p-1 -mt-1 -mr-1" title="Close">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {!hasKey ? (
          /* No key: the feature cannot work, so say what to do instead of an empty list. */
          <div className="py-6 text-center">
            <p className="text-white/70 text-sm leading-relaxed mb-1">
              OpenSubtitles needs a free API key.
            </p>
            <p className="text-white/40 text-xs leading-relaxed mb-4">
              Create one, then paste it into Settings → Subtitles.
            </p>
            <button
              onClick={onGetKey}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-nobuf-primary/15 text-nobuf-primary border border-nobuf-primary/40 hover:bg-nobuf-primary/25 transition-colors"
            >
              Get a free key
            </button>
          </div>
        ) : (
          <>
            {/* Query */}
            <div className="flex gap-2 mb-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
                placeholder={parsed.query ? 'Title' : 'Filename has no title — search by hash or type one'}
                className="flex-1 px-3 py-2 rounded-lg text-sm bg-white/[0.07] text-white placeholder-white/30 border border-white/10 focus:border-nobuf-primary focus:outline-none"
                autoFocus
              />
              <button
                onClick={() => void runSearch()}
                disabled={state === 'searching'}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-nobuf-primary/15 text-nobuf-primary border border-nobuf-primary/40 hover:bg-nobuf-primary/25 disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                {state === 'searching' ? 'Searching…' : 'Search'}
              </button>
            </div>

            {/* Language chips — never a native select (project rule). */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {SUB_LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  onClick={() => onLanguageChange(l.code)}
                  className={`px-2 py-0.5 rounded-md text-[11px] leading-none h-6 transition-colors border ${
                    language === l.code
                      ? 'bg-nobuf-primary border-nobuf-primary text-white font-medium'
                      : 'bg-transparent border-white/15 text-white/50 hover:text-white/80 hover:border-white/30'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>

            {/* Quota — persisted, so it stays visible across panel opens. */}
            {quota !== null && (
              <div className={`text-xs mb-2 leading-none ${quotaSpent ? 'text-amber-400' : 'text-white/40'}`}>
                {quotaSpent
                  ? `Daily download limit reached${resetIn ? ` — resets in ${resetIn}` : ''}`
                  : `${quota.remaining} download${quota.remaining === 1 ? '' : 's'} left today`}
              </div>
            )}

            {error && (
              <div className="text-xs text-red-400 mb-2 leading-relaxed">{error}</div>
            )}

            {/* Results */}
            <div className="max-h-[320px] overflow-y-auto -mx-1 px-1">
              {state === 'done' && results.length === 0 && (
                <p className="text-white/40 text-sm py-6 text-center">
                  No subtitles found{query.trim() ? ` for “${query.trim()}”` : ''}.
                </p>
              )}
              {state === 'idle' && (
                <p className="text-white/30 text-xs py-6 text-center leading-relaxed">
                  Searches this file's exact release first, then falls back to the title.
                </p>
              )}
              {results.length > 0 && (
                <>
                  <div className="text-[11px] text-white/35 mb-2 leading-none">
                    {matchLabel(matchedBy)}
                    {/* Show the episode we narrowed to, so a wrong parse is visible
                        rather than silently returning another episode's subtitles. */}
                    {matchedBy === 'query' && parsed.season !== null && parsed.episode !== null && (
                      <span className="text-white/50">
                        {` · S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`}
                      </span>
                    )}
                  </div>
                  {results.map((r) => (
                    <div
                      key={r.file_id}
                      className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/[0.04] transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white/90 truncate">{r.release || r.file_name}</div>
                        <div className="text-[11px] text-white/40 mt-0.5 flex items-center gap-2 leading-none">
                          <span className="uppercase">{r.language}</span>
                          <span>{r.download_count.toLocaleString()} downloads</span>
                          {r.moviehash_match && <span className="text-nobuf-primary">exact release</span>}
                          {r.from_trusted && <span className="text-white/55">trusted</span>}
                          {/* Amber, not grey: machine translations are often poor
                              enough to be worth avoiding when a human one exists. */}
                          {r.machine_translated && <span className="text-amber-400/80">auto-translated</span>}
                          {r.hearing_impaired && <span>SDH</span>}
                          {r.fps ? <span>{r.fps.toFixed(3)} fps</span> : null}
                        </div>
                      </div>
                      <button
                        onClick={() => void download(r)}
                        disabled={busyId !== null || quotaSpent}
                        className="px-3 py-1.5 rounded-md text-xs font-medium bg-white/[0.07] text-white/80 border border-white/10 hover:border-nobuf-primary/50 hover:text-white disabled:opacity-30 transition-colors whitespace-nowrap"
                      >
                        {busyId === r.file_id ? 'Loading…' : 'Use'}
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
