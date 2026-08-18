//! OpenSubtitles.com integration.
//!
//! Why this lives in Rust rather than the frontend: the app's CSP
//! (`tauri.conf.json` → `security.csp`) lists only localhost origins in
//! `connect-src`, so a `fetch` to `api.opensubtitles.com` dies in the renderer
//! before it reaches the network. WebView2 also has no way to set a custom
//! `User-Agent` per request (the Chrome-extension `declarativeNetRequest`
//! capability FastStream relies on does not exist here), and OpenSubtitles asks
//! API consumers to identify themselves. Both problems disappear on this side.
//!
//! The API key is supplied by the user (free signup) and passed in per call — it is
//! never bundled, never cached here, and never logged.
//!
//! Response shapes below were verified against the live API (2026-08-18), not
//! inferred: `/subtitles` returns `{total_count, data:[{attributes:{language,
//! download_count, release, moviehash_match, files:[{file_id, file_name}]}}]}`, and
//! `POST /download` returns `{link, file_name, requests, remaining, reset_time}`.
//! The free tier allows only **5 downloads per day** (searching is unmetered), so
//! `remaining` is surfaced to the UI rather than treated as an error-path detail.

use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://api.opensubtitles.com/api/v1";
/// Identifies this client to OpenSubtitles, as their API guidelines request.
const USER_AGENT: &str = concat!("NoBuf v", env!("CARGO_PKG_VERSION"));
const HTTP_TIMEOUT_SECS: u64 = 30;

/// Chunk size hashed from each end of the file, per the OpenSubtitles spec.
pub const MOVIE_HASH_CHUNK: usize = 64 * 1024;

/// OpenSubtitles "moviehash" of a video file.
///
/// Definition: `filesize` plus the sum of every little-endian u64 word in the first
/// 64 KiB and the last 64 KiB, all in **wrapping** u64 arithmetic, rendered as 16
/// lowercase hex digits. This identifies a specific release from its bytes, so it
/// works on files whose names carry no information — which is the normal case for
/// Telegram media (`video_2024-01-15_12-34-56.mp4`).
///
/// `head`/`tail` are the raw chunks. Both are read as `floor(len/8)` complete words;
/// a trailing partial word is ignored, matching every reference implementation.
///
/// Callers must not double-count: when `size < 2 * MOVIE_HASH_CHUNK` the head and
/// tail regions overlap in the file, and the canonical behaviour is to hash the
/// overlapping bytes twice anyway (the chunks are taken at fixed offsets 0 and
/// `size - 64KiB`), so this function simply sums whatever it is given.
pub fn movie_hash(size: u64, head: &[u8], tail: &[u8]) -> String {
    let mut hash = size;
    for chunk in [head, tail] {
        for word in chunk.chunks_exact(8) {
            // chunks_exact guarantees 8 bytes, so the conversion cannot fail.
            let value = u64::from_le_bytes(word.try_into().unwrap());
            hash = hash.wrapping_add(value);
        }
    }
    format!("{:016x}", hash)
}

/// Byte ranges to read for a file of `size` bytes: `(head_offset, tail_offset, len)`.
///
/// For a file smaller than one chunk there is nothing to read twice, so both ranges
/// collapse to the whole file. Returns `None` for an empty file — OpenSubtitles
/// cannot match one and the hash would be meaningless.
pub fn movie_hash_ranges(size: u64) -> Option<(u64, u64, usize)> {
    if size == 0 {
        return None;
    }
    let chunk = (MOVIE_HASH_CHUNK as u64).min(size) as usize;
    // saturating_sub is defence-in-depth, not load-bearing: the min() above already
    // guarantees chunk <= size, so this is an EQUIVALENT MUTANT — swapping it for a
    // plain `-` keeps every test green (verified). It is kept because removing BOTH
    // guards panics on any sub-64 KiB file, and the pair is cheaper than the crash.
    let tail_offset = size.saturating_sub(chunk as u64);
    Some((0, tail_offset, chunk))
}

/// One search result, flattened for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct OsResult {
    pub file_id: i64,
    pub file_name: String,
    /// Uploader's release name, e.g. `Inception.2010.1080p.BrRip.x264.YIFY`.
    pub release: String,
    pub language: String,
    pub download_count: i64,
    /// Reported BY THE API per result — not inferred from which query we sent.
    pub moviehash_match: bool,
    pub hearing_impaired: bool,
    pub fps: Option<f64>,
    /// Machine-generated subtitles, which are frequently poor. Surfaced as a badge
    /// rather than used for ranking: sampled live across en/bn/hi/ar, ZERO results
    /// carried these flags, so reordering on them would be speculative machinery.
    pub machine_translated: bool,
    /// Uploader is a trusted contributor. Deliberately NOT a sort key — verified
    /// live that trusted-first would promote an `Inception.2010.CAM.Xvid` release
    /// (subtitles timed to a camcorder rip) above the 543,911-download top result.
    pub from_trusted: bool,
}

/// Outcome of a search, including which strategy actually produced the rows.
#[derive(Debug, Clone, Serialize)]
pub struct OsSearchResponse {
    pub results: Vec<OsResult>,
    pub total_count: i64,
    /// `"moviehash"` when the byte-hash matched, `"query"` when the filename text
    /// search was used, `"none"` when neither returned anything.
    pub matched_by: String,
}

/// Result of a download request, carrying the daily quota back to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct OsDownloadResponse {
    /// Subtitle text, already fetched from the signed link.
    pub text: String,
    pub file_name: String,
    /// Downloads left today. The free tier allows 5, so this drives the UI counter.
    pub remaining: i64,
    pub reset_time: String,
}

// ---- Raw API shapes (private; only what we consume) ----------------------

#[derive(Deserialize)]
struct RawSearch {
    #[serde(default)]
    total_count: i64,
    #[serde(default)]
    data: Vec<RawItem>,
}

#[derive(Deserialize)]
struct RawItem {
    attributes: RawAttrs,
}

#[derive(Deserialize)]
struct RawAttrs {
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    download_count: i64,
    #[serde(default)]
    release: Option<String>,
    #[serde(default)]
    moviehash_match: bool,
    #[serde(default)]
    hearing_impaired: bool,
    #[serde(default)]
    fps: Option<f64>,
    #[serde(default)]
    ai_translated: bool,
    #[serde(default)]
    machine_translated: bool,
    #[serde(default)]
    from_trusted: bool,
    #[serde(default)]
    files: Vec<RawFile>,
}

#[derive(Deserialize)]
struct RawFile {
    #[serde(default)]
    file_id: i64,
    #[serde(default)]
    file_name: Option<String>,
}

#[derive(Deserialize)]
struct RawDownload {
    #[serde(default)]
    link: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    remaining: i64,
    #[serde(default)]
    reset_time: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// Map a transport/status failure to a message a user can act on.
///
/// Never includes the API key or raw headers. The 406 case is OpenSubtitles'
/// quota-exhausted status and is by far the most likely failure on the free tier
/// (5 downloads/day), so it gets its own wording rather than a generic HTTP error.
fn describe_error(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => {
            "OpenSubtitles rejected the API key. Check it in Settings.".to_string()
        }
        ureq::Error::Status(406, _) => {
            "Daily download limit reached (free accounts get 5 per day). Try again after the reset."
                .to_string()
        }
        ureq::Error::Status(429, _) => {
            "OpenSubtitles is rate-limiting requests. Wait a moment and retry.".to_string()
        }
        // Verified live: POST /download answers a BAD API KEY with 503 "Service
        // unavailable", not 401. Reporting that verbatim would send the user chasing
        // an outage, so the message names the likely cause and keeps the fallback.
        ureq::Error::Status(503, _) => {
            "OpenSubtitles refused the request — usually an invalid API key, occasionally a real outage. Verify the key in Settings."
                .to_string()
        }
        ureq::Error::Status(code, _) => format!("OpenSubtitles returned HTTP {}.", code),
        ureq::Error::Transport(t) => {
            format!("Could not reach OpenSubtitles: {}", t.kind())
        }
    }
}

fn flatten(raw: RawSearch) -> (Vec<OsResult>, i64) {
    let mut out = Vec::new();
    for item in raw.data {
        let a = item.attributes;
        // A result with no file has nothing to download; skip rather than render a
        // row whose button cannot work.
        let Some(file) = a.files.into_iter().find(|f| f.file_id != 0) else {
            continue;
        };
        let name = file
            .file_name
            .clone()
            .or_else(|| a.release.clone())
            .unwrap_or_else(|| format!("subtitle {}", file.file_id));
        out.push(OsResult {
            file_id: file.file_id,
            file_name: name.clone(),
            release: a.release.unwrap_or(name),
            language: a.language.unwrap_or_else(|| "?".to_string()),
            download_count: a.download_count,
            moviehash_match: a.moviehash_match,
            hearing_impaired: a.hearing_impaired,
            // Live data carries `fps: 0.0` for uploads with no frame rate recorded
            // (seen in an "inception" result set). Rendering "0.000 fps" is noise, so
            // a non-positive value is normalised to absent.
            fps: a.fps.filter(|f| f.is_finite() && *f > 0.0),
            // The API exposes BOTH flags for machine output; either one means the
            // text was not written by a human, so they collapse into one badge.
            machine_translated: a.ai_translated || a.machine_translated,
            from_trusted: a.from_trusted,
        });
    }
    // Sort HERE, not via the API. Verified live: `order_by=download_count` is
    // ignored — a query for "inception" returned counts
    // [7617, 70471, 543911, 247829, ...], i.e. the most-downloaded entry sat at
    // index 2. Download count is the best available proxy for "this subtitle is
    // actually correct", so the ordering has to be real rather than requested.
    // An exact moviehash match outranks raw popularity: it is the same release.
    out.sort_by(|a, b| {
        b.moviehash_match
            .cmp(&a.moviehash_match)
            .then(b.download_count.cmp(&a.download_count))
    });
    (out, raw.total_count)
}

/// Percent-encode a query-string value.
///
/// Written locally rather than pulling in a crate: the only values we encode are
/// hex hashes, ISO language codes, and filename-derived queries. Everything outside
/// the RFC 3986 unreserved set is escaped, and spaces become `+` because that is
/// what the OpenSubtitles query parser expects (FastStream sets
/// `usePlusForSpaces: true` for the same reason).
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

fn get_json<T: for<'de> Deserialize<'de>>(url: &str, api_key: &str) -> Result<T, String> {
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .set("Api-Key", api_key)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/json")
        .call()
        .map_err(describe_error)?;
    // `into_string` + serde_json rather than ureq's `into_json`: the crate is
    // declared here without its optional `json` feature, and adding a feature to a
    // dependency the whole app shares is not worth one convenience method.
    let body = resp
        .into_string()
        .map_err(|e| format!("Could not read OpenSubtitles response: {}", e))?;
    serde_json::from_str(&body)
        .map_err(|e| format!("Unexpected response from OpenSubtitles: {}", e))
}

/// Validate an API key.
///
/// **Verified against the live API (2026-08-18), and the result is counter-intuitive:**
/// `/infos/formats` and even `/subtitles` return HTTP 200 with a byte-identical
/// payload for a garbage key — search is effectively unauthenticated. Only
/// `/download` enforces the key, and it reports a bad one as **503 "Service
/// unavailable"** rather than 401. `/infos/user` returns 401 for *every* key
/// (including a good one), because an API key alone is not a logged-in user.
///
/// So a truthful "is this key usable?" check is impossible without spending one of
/// the 5 daily downloads, which would be a hostile thing to do while someone is
/// pasting a key. Instead this performs a REACHABILITY check and says so: it proves
/// the key is well-formed and that OpenSubtitles is up, and the first real download
/// surfaces an auth problem with a clear message.
#[tauri::command]
pub async fn cmd_opensubtitles_validate_key(api_key: String) -> Result<bool, String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("Enter an API key first.".to_string());
    }
    // Keys are 32-char alphanumeric; catching a truncated paste locally is worth
    // more than a round trip that cannot distinguish good keys from bad ones.
    if key.len() < 20 || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(
            "That does not look like an OpenSubtitles API key (expected ~32 letters and digits)."
                .to_string(),
        );
    }
    let url = format!("{}/infos/formats", API_BASE);
    let _: serde_json::Value = get_json(&url, &key)?;
    Ok(true)
}

/// Search subtitles, preferring the byte-exact moviehash and falling back to text.
///
/// The fallback is automatic and inside one call so the UI can never dead-end: a
/// hash that nobody has uploaded against yields 0 rows, and the filename query runs
/// immediately after. `matched_by` tells the UI which one produced the rows so the
/// "exact release" badge is honest.
///
/// Query-string fragment pinning a TV episode, or empty for a film.
///
/// Verified live (2026-08-18): `?query=breaking bad` alone returns **2834** rows led
/// by the *El Camino* MOVIE and feature releases carrying no episode data, while
/// `?query=breaking bad&season_number=5&episode_number=14` returns **19** rows that
/// are all S5E14. Omitting these for a TV file hands the user subtitles for the
/// wrong episode, so they are sent whenever the filename yielded both.
///
/// Zero/negative values are dropped rather than sent: `season_number=0` is not a
/// real coordinate and only narrows the search to nothing.
pub fn episode_query_fragment(season: Option<i64>, episode: Option<i64>) -> String {
    match (season, episode) {
        (Some(s), Some(e)) if s > 0 && e > 0 => {
            format!("&season_number={}&episode_number={}", s, e)
        }
        _ => String::new(),
    }
}

/// The `/subtitles` URL for a filename text search.
///
/// Built here rather than inline so the parameter assembly is unit-testable: this is
/// the piece where a stray `&`, a missing encode, or a dropped episode coordinate
/// silently returns the wrong subtitles.
pub fn build_query_search_url(
    query: &str,
    languages: &str,
    season: Option<i64>,
    episode: Option<i64>,
) -> String {
    format!(
        "{}/subtitles?query={}&languages={}{}&order_by=download_count&order_direction=desc",
        API_BASE,
        encode_query(query.trim()),
        encode_query(languages),
        episode_query_fragment(season, episode),
    )
}

#[tauri::command]
pub async fn cmd_opensubtitles_search(
    api_key: String,
    languages: String,
    query: Option<String>,
    moviehash: Option<String>,
    season: Option<i64>,
    episode: Option<i64>,
) -> Result<OsSearchResponse, String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("Add an OpenSubtitles API key in Settings to search.".to_string());
    }
    let langs = if languages.trim().is_empty() {
        "en".to_string()
    } else {
        languages.trim().to_string()
    };

    tauri::async_runtime::spawn_blocking(move || {
        // 1. moviehash — identifies the exact release from its bytes, so it works
        //    even when the filename carries no information (the Telegram norm).
        //    No episode params here: the hash already pins one specific file.
        if let Some(hash) = moviehash.as_deref().filter(|h| !h.trim().is_empty()) {
            let url = format!(
                "{}/subtitles?moviehash={}&languages={}&order_by=download_count&order_direction=desc",
                API_BASE,
                encode_query(hash.trim()),
                encode_query(&langs),
            );
            let raw: RawSearch = get_json(&url, &key)?;
            let (results, total) = flatten(raw);
            if !results.is_empty() {
                return Ok(OsSearchResponse {
                    results,
                    total_count: total,
                    matched_by: "moviehash".to_string(),
                });
            }
        }

        // 2. Filename text search, narrowed to the episode when we know it.
        if let Some(q) = query.as_deref().filter(|q| !q.trim().is_empty()) {
            let url = build_query_search_url(q, &langs, season, episode);
            let raw: RawSearch = get_json(&url, &key)?;
            let (results, total) = flatten(raw);
            let matched_by = if results.is_empty() { "none" } else { "query" };
            return Ok(OsSearchResponse {
                results,
                total_count: total,
                matched_by: matched_by.to_string(),
            });
        }

        Ok(OsSearchResponse {
            results: Vec::new(),
            total_count: 0,
            matched_by: "none".to_string(),
        })
    })
    .await
    .map_err(|e| format!("Search task failed: {}", e))?
}

/// Request a download link and fetch the subtitle text behind it.
///
/// Two hops by design: `POST /download` returns a short-lived signed link plus the
/// quota counters, and the text lives behind that link. Both happen here so the
/// frontend never needs a network origin outside the CSP allowlist.
#[tauri::command]
pub async fn cmd_opensubtitles_download(
    api_key: String,
    file_id: i64,
) -> Result<OsDownloadResponse, String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("Add an OpenSubtitles API key in Settings first.".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("{}/download", API_BASE);
        let body = serde_json::json!({ "file_id": file_id, "sub_format": "webvtt" });
        let resp = ureq::post(&url)
            .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
            .set("Api-Key", &key)
            .set("User-Agent", USER_AGENT)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json")
            // send_string + serde_json::to_string rather than send_json: ureq is
            // declared without its optional `json` feature (see get_json).
            .send_string(&serde_json::to_string(&body).map_err(|e| e.to_string())?)
            .map_err(describe_error)?;

        let raw_body = resp
            .into_string()
            .map_err(|e| format!("Could not read download response: {}", e))?;
        let meta: RawDownload = serde_json::from_str(&raw_body)
            .map_err(|e| format!("Unexpected download response: {}", e))?;

        let link = match meta.link {
            Some(ref l) if !l.is_empty() => l.clone(),
            _ => {
                // The API reports quota exhaustion in the body as well as via 406.
                return Err(meta.message.unwrap_or_else(|| {
                    "OpenSubtitles did not return a download link (daily quota may be spent)."
                        .to_string()
                }));
            }
        };

        let text = ureq::get(&link)
            .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
            .set("User-Agent", USER_AGENT)
            .call()
            .map_err(describe_error)?
            .into_string()
            .map_err(|e| format!("Could not read subtitle file: {}", e))?;

        if text.trim().is_empty() {
            return Err("OpenSubtitles returned an empty subtitle file.".to_string());
        }

        Ok(OsDownloadResponse {
            text,
            file_name: meta.file_name.unwrap_or_else(|| "subtitle.vtt".to_string()),
            remaining: meta.remaining,
            reset_time: meta.reset_time.unwrap_or_default(),
        })
    })
    .await
    .map_err(|e| format!("Download task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A chunk of `len` bytes where every u64 word equals `word`.
    fn words(word: u64, count: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(count * 8);
        for _ in 0..count {
            out.extend_from_slice(&word.to_le_bytes());
        }
        out
    }

    #[test]
    fn size_alone_when_chunks_are_empty() {
        assert_eq!(movie_hash(0, &[], &[]), "0000000000000000");
        assert_eq!(movie_hash(1, &[], &[]), "0000000000000001");
        assert_eq!(
            movie_hash(0x1234_5678_9abc_def0, &[], &[]),
            "123456789abcdef0"
        );
    }

    #[test]
    fn sums_little_endian_words_from_both_chunks() {
        // One word of 1 in each chunk, plus a size of 10 → 12.
        let head = 1u64.to_le_bytes();
        let tail = 1u64.to_le_bytes();
        assert_eq!(movie_hash(10, &head, &tail), format!("{:016x}", 12u64));
    }

    #[test]
    fn byte_order_is_little_endian_not_big() {
        // 0x0102030405060708 LE on the wire is 08 07 06 05 04 03 02 01.
        let head: [u8; 8] = [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01];
        let hash = movie_hash(0, &head, &[]);
        assert_eq!(hash, "0102030405060708");
        // Big-endian interpretation would have produced this instead:
        assert_ne!(hash, "0807060504030201");
    }

    #[test]
    fn full_64kib_chunks_sum_every_word() {
        // 8192 words per 64 KiB chunk.
        let head = words(1, MOVIE_HASH_CHUNK / 8);
        assert_eq!(head.len(), MOVIE_HASH_CHUNK);
        let expected = MOVIE_HASH_CHUNK as u64 / 8; // 8192
        assert_eq!(movie_hash(0, &head, &[]), format!("{:016x}", expected));
    }

    #[test]
    fn both_chunks_contribute_independently() {
        let head = words(3, 4);
        let tail = words(5, 4);
        let only_head = movie_hash(0, &head, &[]);
        let only_tail = movie_hash(0, &[], &tail);
        let both = movie_hash(0, &head, &tail);
        assert_eq!(only_head, format!("{:016x}", 12u64));
        assert_eq!(only_tail, format!("{:016x}", 20u64));
        assert_eq!(both, format!("{:016x}", 32u64));
        // Dropping the tail sum must change the result.
        assert_ne!(both, only_head);
    }

    #[test]
    fn arithmetic_wraps_and_never_panics() {
        // u64::MAX + 1 must wrap to 0, not panic (debug builds) or saturate.
        let head = u64::MAX.to_le_bytes();
        assert_eq!(movie_hash(1, &head, &[]), "0000000000000000");
        // Many wraps in a row stay well-defined.
        let big = words(u64::MAX, 1000);
        let hash = movie_hash(u64::MAX, &big, &big);
        assert_eq!(hash.len(), 16);
        assert!(u64::from_str_radix(&hash, 16).is_ok());
    }

    #[test]
    fn trailing_partial_word_is_ignored() {
        // 12 bytes = one complete word + 4 leftover bytes; the remainder is dropped.
        let mut head = 7u64.to_le_bytes().to_vec();
        head.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        assert_eq!(movie_hash(0, &head, &[]), format!("{:016x}", 7u64));
        // A chunk shorter than one word contributes nothing at all.
        assert_eq!(movie_hash(5, &[0xff; 7], &[]), format!("{:016x}", 5u64));
    }

    #[test]
    fn output_is_always_16_lowercase_hex_digits() {
        for size in [0u64, 1, 255, 4096, u64::MAX] {
            let hash = movie_hash(size, &[], &[]);
            assert_eq!(hash.len(), 16, "size {} produced {}", size, hash);
            assert!(hash
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        }
    }

    #[test]
    fn ranges_cover_head_and_tail_for_a_large_file() {
        let size = 700 * 1024 * 1024;
        let (head, tail, len) = movie_hash_ranges(size).unwrap();
        assert_eq!(head, 0);
        assert_eq!(len, MOVIE_HASH_CHUNK);
        assert_eq!(tail, size - MOVIE_HASH_CHUNK as u64);
        // The two reads must not overlap for a normal video.
        assert!(tail >= len as u64);
    }

    #[test]
    fn ranges_collapse_for_a_file_smaller_than_one_chunk() {
        let size = 1000u64;
        let (head, tail, len) = movie_hash_ranges(size).unwrap();
        assert_eq!((head, tail, len), (0, 0, 1000));
    }

    #[test]
    fn ranges_overlap_but_stay_in_bounds_below_two_chunks() {
        // 100 KiB: head is 0..64Ki, tail is 36Ki..100Ki — overlapping, both valid.
        let size = 100 * 1024;
        let (head, tail, len) = movie_hash_ranges(size).unwrap();
        assert_eq!(head, 0);
        assert_eq!(len, MOVIE_HASH_CHUNK);
        assert_eq!(tail, size - MOVIE_HASH_CHUNK as u64);
        assert!(tail + len as u64 <= size, "tail read must not exceed EOF");
        assert!(tail < len as u64, "this size is expected to overlap");
    }

    #[test]
    fn empty_file_has_no_ranges() {
        assert!(movie_hash_ranges(0).is_none());
    }

    #[test]
    fn ranges_are_defensively_underflow_safe_for_every_tiny_size() {
        // `chunk` is already min()'d against `size`, so `size - chunk` cannot go
        // negative today — but that makes the two guards mask each other: remove the
        // min() and a plain subtraction PANICS on any file below 64 KiB, while
        // saturating_sub degrades to 0. Sweeping every small size keeps both guards
        // independently pinned, so a later refactor of either one fails loudly here.
        for size in [1u64, 7, 8, 9, 255, 4095, 4096, 65_535, 65_536, 65_537] {
            let (head, tail, len) = movie_hash_ranges(size).unwrap();
            assert_eq!(head, 0, "size {}", size);
            assert!(len as u64 <= size, "chunk {} exceeds size {}", len, size);
            // Neither read may run past EOF.
            assert!(
                tail + len as u64 <= size,
                "tail read past EOF at size {}",
                size
            );
            // And the hash itself must be computable from those ranges.
            let data = vec![0xABu8; size as usize];
            let h = movie_hash(
                size,
                &data[head as usize..head as usize + len],
                &data[tail as usize..tail as usize + len],
            );
            assert_eq!(h.len(), 16, "size {}", size);
        }
    }

    #[test]
    fn encodes_query_values_for_the_url() {
        // Unreserved characters pass through untouched.
        assert_eq!(encode_query("Inception2010"), "Inception2010");
        assert_eq!(encode_query("a-b_c.d~e"), "a-b_c.d~e");
        // Spaces become '+', which is what the OpenSubtitles query parser expects.
        assert_eq!(encode_query("the matrix"), "the+matrix");
        // Reserved and unsafe characters are percent-escaped.
        assert_eq!(encode_query("a&b=c?d"), "a%26b%3Dc%3Fd");
        assert_eq!(encode_query("100%"), "100%25");
        assert_eq!(encode_query("a/b"), "a%2Fb");
        // Non-ASCII is escaped per UTF-8 byte, not mangled or dropped.
        assert_eq!(encode_query("é"), "%C3%A9");
        assert_eq!(encode_query("日本"), "%E6%97%A5%E6%9C%AC");
        // A hex moviehash and a language list survive verbatim.
        assert_eq!(encode_query("8e245d9679d31e12"), "8e245d9679d31e12");
        assert_eq!(encode_query("en"), "en");
        // Empty input is not an error.
        assert_eq!(encode_query(""), "");
    }

    #[test]
    fn encoded_queries_cannot_inject_extra_url_parameters() {
        // A filename containing '&' must not smuggle a second query parameter into
        // the request (e.g. overriding languages or order_by).
        let hostile = "movie&languages=zz&order_by=votes";
        let encoded = encode_query(hostile);
        assert!(!encoded.contains('&'), "raw & survived: {}", encoded);
        assert!(!encoded.contains('='), "raw = survived: {}", encoded);
    }

    #[test]
    fn flatten_maps_the_verified_live_response_shape() {
        // Trimmed from a real /subtitles response (verified 2026-08-18).
        let json = r#"{
          "total_count": 56,
          "data": [
            {"attributes": {
              "language": "en", "download_count": 543911,
              "release": "Inception.2010.DVDRip.XviD.AC3-ViSiON",
              "moviehash_match": true, "hearing_impaired": false, "fps": 23.976,
              "files": [{"file_id": 76256, "file_name": "Inception DVDRip"}]
            }},
            {"attributes": {
              "language": "bg", "download_count": 12,
              "release": "Two Swords", "hearing_impaired": true,
              "files": [{"file_id": 991, "file_name": null}]
            }}
          ]
        }"#;
        let raw: RawSearch = serde_json::from_str(json).expect("must parse");
        let (results, total) = flatten(raw);
        assert_eq!(total, 56);
        assert_eq!(results.len(), 2);

        assert_eq!(results[0].file_id, 76256);
        assert_eq!(results[0].language, "en");
        assert_eq!(results[0].download_count, 543_911);
        // moviehash_match comes FROM the API, so the "exact release" badge is a fact
        // rather than something inferred from which query we happened to send.
        assert!(results[0].moviehash_match);
        assert_eq!(results[0].fps, Some(23.976));

        // Missing fields fall back instead of failing the whole response.
        assert!(!results[1].moviehash_match);
        assert!(results[1].hearing_impaired);
        assert_eq!(results[1].fps, None);
        assert_eq!(results[1].file_name, "Two Swords"); // null file_name → release
    }

    #[test]
    fn flatten_skips_results_with_no_downloadable_file() {
        // A row whose button could not work must not be rendered at all.
        let json = r#"{"total_count": 3, "data": [
            {"attributes": {"language": "en", "files": []}},
            {"attributes": {"language": "en", "files": [{"file_id": 0}]}},
            {"attributes": {"language": "en", "files": [{"file_id": 42}]}}
        ]}"#;
        let raw: RawSearch = serde_json::from_str(json).unwrap();
        let (results, _) = flatten(raw);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_id, 42);
    }

    #[test]
    fn flatten_tolerates_an_empty_or_unknown_response() {
        let (results, total) = flatten(serde_json::from_str(r#"{}"#).unwrap());
        assert!(results.is_empty());
        assert_eq!(total, 0);
        let (results, total) =
            flatten(serde_json::from_str(r#"{"total_count":0,"data":[]}"#).unwrap());
        assert!(results.is_empty());
        assert_eq!(total, 0);
    }

    #[test]
    fn download_response_shape_parses_with_the_quota_fields() {
        // Verified live: the free tier reports 5 downloads/day via `remaining`.
        let json = r#"{
          "link": "https://example.com/x.vtt",
          "file_name": "Inception.2010.DVDRip.XviD.AC3-ViSiON.webvtt",
          "requests": 1, "remaining": 4,
          "reset_time": "9 hours and 52 minutes"
        }"#;
        let d: RawDownload = serde_json::from_str(json).expect("must parse");
        assert_eq!(d.remaining, 4);
        assert_eq!(d.reset_time.as_deref(), Some("9 hours and 52 minutes"));
        assert!(d.link.is_some());
    }

    #[test]
    fn download_response_without_a_link_carries_the_reason() {
        // Quota exhaustion arrives in the body, not only as a 406 status.
        let json = r#"{"message": "Your quota will be renewed in 3 hours", "remaining": 0}"#;
        let d: RawDownload = serde_json::from_str(json).expect("must parse");
        assert!(d.link.is_none());
        assert_eq!(d.remaining, 0);
        assert!(d.message.unwrap().contains("quota"));
    }

    #[test]
    fn error_messages_are_actionable_and_never_leak_the_key() {
        let key = "SECRETKEY123";
        for (status, expect) in [
            (401, "API key"),
            (403, "API key"),
            (406, "Daily download limit"),
            (429, "rate-limiting"),
            (500, "HTTP 500"),
        ] {
            let resp = ureq::Response::new(status, "x", "body").unwrap();
            let msg = describe_error(ureq::Error::Status(status, resp));
            assert!(
                msg.contains(expect),
                "status {} produced {:?}, expected it to mention {:?}",
                status,
                msg,
                expect
            );
            assert!(!msg.contains(key), "error text leaked the API key: {}", msg);
        }
    }

    #[test]
    fn flatten_sorts_by_hash_match_then_download_count() {
        // The API IGNORES order_by (verified live: a query for "inception" returned
        // counts [7617, 70471, 543911, ...] despite order_by=download_count), so the
        // ordering must be applied here or "most downloaded" would be a lie.
        let json = r#"{"total_count": 4, "data": [
            {"attributes": {"language":"en","download_count":100,"release":"low",
              "files":[{"file_id":1}]}},
            {"attributes": {"language":"en","download_count":9000,"release":"high",
              "files":[{"file_id":2}]}},
            {"attributes": {"language":"en","download_count":50,"release":"hash-hit",
              "moviehash_match":true,"files":[{"file_id":3}]}},
            {"attributes": {"language":"en","download_count":500,"release":"mid",
              "files":[{"file_id":4}]}}
        ]}"#;
        let raw: RawSearch = serde_json::from_str(json).unwrap();
        let (results, _) = flatten(raw);
        // An exact-release hash hit wins even with only 50 downloads.
        assert_eq!(results[0].release, "hash-hit");
        // Then plain popularity, descending.
        assert_eq!(
            results[1..]
                .iter()
                .map(|r| r.download_count)
                .collect::<Vec<_>>(),
            vec![9000, 500, 100]
        );
    }

    #[test]
    fn episode_fragment_pins_a_tv_episode() {
        // Verified live: "breaking bad" alone → 2834 rows led by the El Camino MOVIE;
        // with these params → 19 rows, all S5E14.
        assert_eq!(
            episode_query_fragment(Some(5), Some(14)),
            "&season_number=5&episode_number=14"
        );
        assert_eq!(
            episode_query_fragment(Some(1), Some(1)),
            "&season_number=1&episode_number=1"
        );
    }

    #[test]
    fn episode_fragment_is_empty_for_a_film() {
        // A movie has neither coordinate; sending season_number=0 would narrow the
        // search to nothing instead of searching the film.
        assert_eq!(episode_query_fragment(None, None), "");
        assert_eq!(episode_query_fragment(Some(5), None), "");
        assert_eq!(episode_query_fragment(None, Some(14)), "");
        assert_eq!(episode_query_fragment(Some(0), Some(0)), "");
        assert_eq!(episode_query_fragment(Some(0), Some(14)), "");
        assert_eq!(episode_query_fragment(Some(-1), Some(3)), "");
    }

    #[test]
    fn query_search_url_carries_every_required_parameter() {
        let url = build_query_search_url("breaking bad", "en", Some(5), Some(14));
        assert!(url.starts_with("https://api.opensubtitles.com/api/v1/subtitles?"));
        assert!(url.contains("query=breaking+bad"), "{}", url);
        assert!(url.contains("languages=en"), "{}", url);
        assert!(url.contains("season_number=5"), "{}", url);
        assert!(url.contains("episode_number=14"), "{}", url);
        // We sort client-side because the API ignores this, but keep asking.
        assert!(url.contains("order_by=download_count"), "{}", url);
    }

    #[test]
    fn query_search_url_omits_episode_params_for_a_film() {
        let url = build_query_search_url("inception", "en", None, None);
        assert!(!url.contains("season_number"), "{}", url);
        assert!(!url.contains("episode_number"), "{}", url);
        assert!(url.contains("query=inception"), "{}", url);
    }

    #[test]
    fn query_search_url_encodes_hostile_input() {
        // A filename-derived query must not smuggle extra parameters.
        let url = build_query_search_url("movie&languages=zz", "en", None, None);
        assert!(url.contains("query=movie%26languages%3Dzz"), "{}", url);
        // Exactly one languages parameter survives.
        assert_eq!(url.matches("languages=").count(), 1, "{}", url);
    }

    #[test]
    fn query_search_url_has_no_malformed_separators() {
        for (s, e) in [(Some(2i64), Some(9i64)), (None, None)] {
            let url = build_query_search_url("the wire", "fr", s, e);
            assert!(!url.contains("?&"), "{}", url);
            assert!(!url.contains("&&"), "{}", url);
            assert!(!url.ends_with('&'), "{}", url);
            assert_eq!(url.matches('?').count(), 1, "{}", url);
        }
    }

    #[test]
    fn flatten_maps_the_verbatim_live_attribute_set() {
        // Every key below was dumped from a REAL /subtitles response (2026-08-18) —
        // the full attribute set, not a hand-picked subset. A test written against
        // invented field names would pass while the badges silently never render.
        let json = r#"{
          "total_count": 56,
          "data": [{"attributes": {
            "ai_translated": false,
            "comments": "",
            "download_count": 7617,
            "files": [{"file_id": 4982777, "cd_number": 1, "file_name": "Inception"}],
            "foreign_parts_only": false,
            "fps": 23.976,
            "from_trusted": true,
            "hd": false,
            "hearing_impaired": false,
            "language": "en",
            "legacy_subtitle_id": 7803094,
            "legacy_uploader_id": 1514319,
            "machine_translated": false,
            "nb_cd": 1,
            "new_download_count": 3846,
            "ratings": 5.0,
            "related_links": [],
            "release": "Inception",
            "slug": "inception-en",
            "subtitle_id": "4859512",
            "upload_date": "2019-06-15T21:59:52Z",
            "uploader": {"uploader_id": 1, "name": "x", "rank": "y"},
            "url": "https://www.opensubtitles.com/en/subtitles/inception-en",
            "votes": 1
          }}]
        }"#;
        let raw: RawSearch = serde_json::from_str(json).expect("live shape must parse");
        let (results, total) = flatten(raw);
        assert_eq!(total, 56);
        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert_eq!(r.file_id, 4_982_777);
        assert_eq!(r.file_name, "Inception");
        assert_eq!(r.download_count, 7617);
        assert_eq!(r.fps, Some(23.976));
        assert!(r.from_trusted);
        assert!(!r.machine_translated);
        assert!(!r.hearing_impaired);
        // Unknown keys (comments, hd, ratings, slug, uploader…) must be ignored, not
        // fatal: the API adds fields over time and a strict struct would break.
    }

    #[test]
    fn machine_translated_collapses_both_api_flags() {
        // The API has TWO independent flags for non-human text; either must show the
        // badge, or an AI-translated subtitle passes as human-written.
        for (ai, mt, want) in [
            (false, false, false),
            (true, false, true),
            (false, true, true),
            (true, true, true),
        ] {
            let json = format!(
                r#"{{"total_count":1,"data":[{{"attributes":{{"language":"en",
                   "ai_translated":{},"machine_translated":{},
                   "files":[{{"file_id":9}}]}}}}]}}"#,
                ai, mt
            );
            let raw: RawSearch = serde_json::from_str(&json).unwrap();
            let (results, _) = flatten(raw);
            assert_eq!(
                results[0].machine_translated, want,
                "ai_translated={} machine_translated={}",
                ai, mt
            );
        }
    }

    #[test]
    fn trusted_and_machine_flags_never_reorder_results() {
        // DELIBERATE: verified live that trusted-first would promote an
        // `Inception.2010.CAM.Xvid` release (subs timed to a camcorder rip) above the
        // 543,911-download top result. Ranking stays hash-match then popularity.
        let json = r#"{"total_count":3,"data":[
            {"attributes":{"language":"en","download_count":543911,"release":"popular-untrusted",
              "from_trusted":false,"files":[{"file_id":1}]}},
            {"attributes":{"language":"en","download_count":201201,"release":"CAM-but-trusted",
              "from_trusted":true,"files":[{"file_id":2}]}},
            {"attributes":{"language":"en","download_count":9,"release":"machine",
              "ai_translated":true,"from_trusted":true,"files":[{"file_id":3}]}}
        ]}"#;
        let raw: RawSearch = serde_json::from_str(json).unwrap();
        let (results, _) = flatten(raw);
        assert_eq!(results[0].release, "popular-untrusted");
        assert_eq!(results[1].release, "CAM-but-trusted");
        assert_eq!(results[2].release, "machine");
    }

    #[test]
    fn zero_and_bogus_fps_are_normalised_to_absent() {
        // Live data really does carry fps: 0.0 (observed in an "inception" result
        // set); "0.000 fps" in the UI is noise, not information.
        let json = r#"{"total_count":4,"data":[
            {"attributes":{"language":"en","fps":23.976,"files":[{"file_id":1}]}},
            {"attributes":{"language":"en","fps":0.0,"files":[{"file_id":2}]}},
            {"attributes":{"language":"en","fps":-5.0,"files":[{"file_id":3}]}},
            {"attributes":{"language":"en","files":[{"file_id":4}]}}
        ]}"#;
        let raw: RawSearch = serde_json::from_str(json).unwrap();
        let (results, _) = flatten(raw);
        assert_eq!(results[0].fps, Some(23.976));
        assert_eq!(results[1].fps, None, "fps 0.0 must render as absent");
        assert_eq!(results[2].fps, None, "negative fps must render as absent");
        assert_eq!(results[3].fps, None);
    }

    /// Frozen vectors from a two-implementation cross-check.
    ///
    /// The canonical OpenSubtitles test vectors are not currently fetchable (the
    /// project's Trac wiki is down and the usual mirrors 404), so instead of copying
    /// a constant from memory these were established by writing a SECOND,
    /// independent implementation of the spec in Python — whole-chunk
    /// `struct.unpack` with explicit 64-bit masking, rather than this module's
    /// 8-byte `chunks_exact` + `wrapping_add` — and running both over the same real
    /// files on disk. All five agreed bit-for-bit, including a file smaller than one
    /// chunk and a file where the head and tail reads overlap.
    ///
    /// The inputs here are reconstructed synthetically (repeating `0..=255`) so the
    /// test carries no dependency on machine-local media.
    #[test]
    fn matches_the_cross_checked_reference_vectors() {
        // 10,240 bytes of repeating 0..=255 — smaller than one 64 KiB chunk, so the
        // head and tail chunks are both the entire file.
        let whole: Vec<u8> = (0..=255u8).cycle().take(10_240).collect();
        assert_eq!(movie_hash(10_240, &whole, &whole), "190f04faf0e70000");

        // 102,400 bytes of the same pattern: one chunk from offset 0 and one from
        // offset 36,864, which overlap. Both are hashed as-read.
        let data: Vec<u8> = (0..=255u8).cycle().take(102_400).collect();
        let (head_off, tail_off, len) = movie_hash_ranges(102_400).unwrap();
        let head = &data[head_off as usize..head_off as usize + len];
        let tail = &data[tail_off as usize..tail_off as usize + len];
        assert_eq!(movie_hash(102_400, head, tail), "a0601fdf9f609000");
    }
}
