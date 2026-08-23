//! ffmpeg/ffprobe capability probing.
//!
//! Answers "can this binary do what the manifest requires?" by parsing bulk
//! dumps, never by per-component `-h` queries.
//!
//! ## Why bulk dumps (verified against ffmpeg 9.0.1 essentials + 8.1.1 full)
//!
//! `ffmpeg -h encoder=X` prints `Codec 'X' is not recognized by FFmpeg.` and
//! then **exits 0** for a component that does not exist. A naive per-component
//! check would pass every missing component. Bulk dumps plus an exact column-2
//! match are both correct and ~3.3x faster (~74 ms for all six dumps vs ~241 ms
//! for 20 individual queries on this machine).
//!
//! ## Parser rules, each derived by execution
//!
//! - The component name is **column 2** in both dump formats:
//!   `-encoders` uses one flag column (`V....D a64multi`), `-filters` uses two
//!   (`.S zscale`, `TS aap`). A `$2 == name` match is correct for both.
//! - **Exact match only.** `contains("h264")` matches 8 rows on a build that
//!   has no `h264` encoder; `$2 == "h264"` matches 0.
//! - Comma-joined entries exist: the Matroska demuxer dumps as
//!   `matroska,webm`, so the matcher splits column 2 on `,` before comparing.
//! - Exit codes are only trustworthy for *runtime* failures. Real init
//!   failures return large unsigned values on Windows, so probes are judged
//!   with `status.success()` — exactly as `server.rs::h264_encoder_probe`
//!   already does — never by comparing a numeric code.

use crate::deps::manifest::{Feature, Kind, Tier, REQUIREMENTS};
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;

use crate::no_window::NoWindow;

// ============================================================================
// Dump parsing (pure functions — unit-tested without any ffmpeg binary)
// ============================================================================

/// Extract the set of component names from one bulk dump.
///
/// Handles both the one-flag-column format (`-encoders`: `V....D a64multi`)
/// and the two-flag-column format (`-filters`: `.S zscale`), skips header and
/// legend lines, and splits comma-joined names (`matroska,webm`).
pub fn parse_dump(output: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        // Skip legend/header lines: they contain '=' or start with a word
        // followed by ':' ("Filters:", "Encoders:") or are separators.
        if trimmed.contains('=') || trimmed.ends_with(':') || trimmed.starts_with("--") {
            continue;
        }
        let cols: Vec<&str> = trimmed.split_whitespace().collect();
        // A data row has at least: flags, name. Anything shorter is a header.
        if cols.len() < 2 {
            continue;
        }
        // The flags column is dots/capital letters (V, A, S, T, ., etc.).
        // Reject rows whose first column looks like prose.
        if !cols[0]
            .chars()
            .all(|c| c.is_ascii_uppercase() || c == '.' || c == '|')
        {
            continue;
        }
        for name in cols[1].split(',') {
            names.push(name.to_string());
        }
    }
    names
}

/// Exact membership check against a parsed dump.
///
/// Exactness is the whole point: `h264` must NOT match `h264_qsv`, and `hevc`
/// (a decoder) must NOT be found in an encoder dump.
pub fn dump_contains<'a>(names: impl IntoIterator<Item = &'a String>, name: &str) -> bool {
    names.into_iter().any(|n| n == name)
}

// ============================================================================
// Probe execution
// ============================================================================

/// Run one bulk dump and parse it. Returns an error message on failure so the
/// caller can distinguish "component missing" from "could not run ffmpeg".
fn run_dump(ffmpeg: &std::path::Path, flag: &str) -> Result<Vec<String>, String> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", flag])
        .no_window()
        .output()
        .map_err(|e| format!("failed to run ffmpeg {flag}: {e}"))?;

    // A dump that exits non-zero means the binary is broken/unreadable — that
    // is a health-check failure, not a "component missing" result.
    if !output.status.success() {
        return Err(format!(
            "ffmpeg {flag} exited with {:?}",
            output.status.code()
        ));
    }
    Ok(parse_dump(&String::from_utf8_lossy(&output.stdout)))
}

/// One manifest requirement's verdict.
#[derive(Debug, Clone, Serialize)]
pub struct RequirementStatus {
    pub name: &'static str,
    pub kind: Kind,
    pub feature: Feature,
    pub tier: Tier,
    pub used_by: &'static str,
    pub present: bool,
}

/// Aggregate result of a full component check.
#[derive(Debug, Clone, Serialize)]
pub struct HealthReport {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub ffmpeg_version: Option<String>,
    pub ffprobe_version: Option<String>,
    /// Version mismatch between the two binaries (released as a matched pair).
    pub version_mismatch: Option<String>,
    pub requirements: Vec<RequirementStatus>,
    /// True iff every Required requirement is present.
    pub healthy: bool,
}

impl HealthReport {
    /// Distinct features that have at least one missing requirement.
    pub fn degraded_features(&self) -> Vec<Feature> {
        let mut out: Vec<Feature> = Vec::new();
        for r in &self.requirements {
            if !r.present && !out.contains(&r.feature) {
                out.push(r.feature);
            }
        }
        out
    }

    /// Required requirements that are missing (empty iff `healthy`).
    pub fn missing_required(&self) -> Vec<&RequirementStatus> {
        self.requirements
            .iter()
            .filter(|r| !r.present && r.tier == Tier::Required)
            .collect()
    }
}

/// The health contract: healthy iff every **Required** requirement is present.
///
/// Extracted as a pure function so the contract itself is unit-testable on
/// synthetic inputs — a real binary cannot be made to lack a required component
/// on demand, so an inline computation in `check()` had no failing-path test
/// (proven: the "always healthy" mutant survived).
pub fn compute_healthy(requirements: &[RequirementStatus]) -> bool {
    requirements
        .iter()
        .all(|r| r.present || r.tier == Tier::Optional)
}

/// Cached first line of `<bin> -version` per binary path.
fn version_of(bin: &std::path::Path) -> Option<String> {
    let output = Command::new(bin)
        .arg("-version")
        .no_window()
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&output.stdout);
    first.lines().next().map(|l| l.trim().to_string())
}

/// Parsed bulk dumps, keyed by dump flag, tagged with the binary they came
/// from. The tag makes staleness self-healing: if resolution switches to a
/// different binary (first-run download lands, repair installs a new version),
/// the next `check()` detects the mismatch and rebuilds instead of reporting
/// the old binary's components.
struct DumpCache {
    ffmpeg: std::path::PathBuf,
    dumps: HashMap<&'static str, Vec<String>>,
}

static DUMP_CACHE: Mutex<Option<DumpCache>> = Mutex::new(None);

/// Drop the parsed-dump cache. Called alongside
/// `ffmpeg_util::reset_resolved()` after an install/repair so the next health
/// check probes the freshly installed binary. (The path-tag on `DumpCache`
/// already makes this self-healing; this exists so repair flows can be
/// explicit rather than relying on the fallback.)
pub fn reset_dump_cache() {
    if let Ok(mut g) = DUMP_CACHE.lock() {
        *g = None;
    }
}

/// Run the full component check against the resolved binaries.
///
/// Dumps are executed once each and reused for every requirement bound to that
/// flag, so the whole check costs six subprocesses (~74 ms measured) regardless
/// of manifest size.
pub fn check(
    ffmpeg: &std::path::Path,
    ffprobe: &std::path::Path,
) -> Result<HealthReport, String> {
    let mut cache_guard = DUMP_CACHE.lock().map_err(|e| e.to_string())?;
    // Reuse the previous dumps only when they came from THIS binary.
    let mut cache: HashMap<&'static str, Vec<String>> = match cache_guard.take() {
        Some(cached) if cached.ffmpeg == ffmpeg => cached.dumps,
        _ => HashMap::new(),
    };

    let mut requirements = Vec::with_capacity(REQUIREMENTS.len());
    for r in REQUIREMENTS {
        let flag = r.kind.dump_flag();
        if !cache.contains_key(flag) {
            cache.insert(flag, run_dump(ffmpeg, flag)?);
        }
        let names = &cache[flag];
        // `matroska` must match the comma-joined `matroska,webm` entry, which
        // parse_dump already split — so this is a plain exact match.
        let present = dump_contains(names.iter(), r.name);
        requirements.push(RequirementStatus {
            name: r.name,
            kind: r.kind,
            feature: r.feature,
            tier: r.tier,
            used_by: r.used_by,
            present,
        });
    }
    *cache_guard = Some(DumpCache {
        ffmpeg: ffmpeg.to_path_buf(),
        dumps: cache,
    });

    let ffmpeg_version = version_of(ffmpeg);
    let ffprobe_version = version_of(ffprobe);
    let version_mismatch = match (&ffmpeg_version, &ffprobe_version) {
        (Some(f), Some(p)) if extract_version(f) != extract_version(p) => {
            Some(format!("ffmpeg '{f}' vs ffprobe '{p}'"))
        }
        _ => None,
    };

    let healthy = compute_healthy(&requirements);

    Ok(HealthReport {
        ffmpeg_path: ffmpeg.to_string_lossy().to_string(),
        ffprobe_path: ffprobe.to_string_lossy().to_string(),
        ffmpeg_version,
        ffprobe_version,
        version_mismatch,
        requirements,
        healthy,
    })
}

/// Pull the numeric version ("9.0.1") out of a `-version` banner line.
fn extract_version(banner: &str) -> String {
    banner
        .split_whitespace()
        .nth(2)
        .unwrap_or_default()
        .trim_end_matches('-')
        .to_string()
}

/// Verify `-dump_attachment` exists in the option table.
///
/// This is NOT a dump entry and a synthetic invocation is a usage error (the
/// option is input-only), so presence is read from `-h full`.
pub fn has_dump_attachment(ffmpeg: &std::path::Path) -> Result<bool, String> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-h", "full"])
        .no_window()
        .output()
        .map_err(|e| format!("failed to run ffmpeg -h full: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg -h full exited with {:?}",
            output.status.code()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().any(|l| l.trim_start().starts_with("-dump_attachment")))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    const ESSENTIALS_ENCODERS: &str = "\
Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D a64multi             Multicolor charset
 V....D a64multi5            Multicolor charset, extended
 V....D libx264              libx264 H.264
 V....D h264_qsv             Quick Sync Video H.264
 V....D h264_nvenc           NVIDIA NVENC H.264
 V....D h264_amf             AMD AMF H.264
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libmp3lame           libmp3lame MP3
";

    const ESSENTIALS_FILTERS: &str = "\
Filters:
  T.. = Timeline support
  .S. = Slice threading
  ------
 TS aap               AA->A      Apply Affine Projection
 .. abench            A->A       Benchmark part of a filtergraph
 .. acompressor       A->A       Audio compressor
 .. aresample         A->A       Resample audio data
 .. asetpts           A->A       Set PTS for the output audio frame
 .. format            V->V       Convert the input video formats
 .S tonemap           V->V       Conversion to/from different dynamic ranges
 .. vpp_qsv           V->V       Quick Sync Video
 .S zscale            V->V       Apply resizing, colorspace and bit depth
";

    const ESSENTIALS_DEMUXERS: &str = "\
File Formats:
 D..... = Demuxing supported
 ------
 D  matroska,webm     Matroska / WebM
 D  mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV
";

    #[test]
    fn parses_one_flag_column_format() {
        let names = parse_dump(ESSENTIALS_ENCODERS);
        for expected in ["libx264", "h264_qsv", "h264_nvenc", "h264_amf", "aac"] {
            assert!(
                dump_contains(names.iter(), expected),
                "{expected} must be found in -encoders dump"
            );
        }
        // Headers and legends must not leak in as component names.
        for junk in ["Encoders:", "Video", "------"] {
            assert!(!names.iter().any(|n| n == junk), "leaked header {junk:?}");
        }
    }

    #[test]
    fn parses_two_flag_column_format() {
        let names = parse_dump(ESSENTIALS_FILTERS);
        for expected in ["zscale", "tonemap", "format", "aresample", "asetpts", "vpp_qsv"] {
            assert!(
                dump_contains(names.iter(), expected),
                "{expected} must be found in -filters dump"
            );
        }
    }

    /// THE false-pass regression: `-h encoder=libsvtav1` exits 0 even though
    /// the component is absent from this build. Only dump parsing gets this
    /// right, and only with an exact match.
    #[test]
    fn absent_component_is_reported_absent() {
        let names = parse_dump(ESSENTIALS_ENCODERS);
        assert!(!dump_contains(names.iter(), "libsvtav1"));
        assert!(!dump_contains(names.iter(), "frei0r"));
        // And the decoder-only name must not appear in an encoder dump.
        assert!(!dump_contains(names.iter(), "hevc"));
    }

    /// `h264` must NOT match `h264_qsv`. Substring matching yields 8 hits on a
    /// build with zero `h264` encoders.
    #[test]
    fn exact_match_does_not_substring_match() {
        let names = parse_dump(ESSENTIALS_ENCODERS);
        assert!(!dump_contains(names.iter(), "h264"));
        assert!(!dump_contains(names.iter(), "lib"));
        assert!(dump_contains(names.iter(), "libx264"));
    }

    /// `matroska` must match the comma-joined `matroska,webm` dump entry.
    #[test]
    fn comma_joined_dump_entries_are_split() {
        let names = parse_dump(ESSENTIALS_DEMUXERS);
        assert!(
            dump_contains(names.iter(), "matroska"),
            "matroska must be found in 'matroska,webm'"
        );
        assert!(dump_contains(names.iter(), "webm"));
        assert!(dump_contains(names.iter(), "mov"));
    }

    #[test]
    fn missing_required_component_is_unhealthy() {
        use crate::deps::manifest::{Feature as F, Kind as K, Tier as T};
        let reqs = vec![
            RequirementStatus { name: "mpegts", kind: K::Muxer, feature: F::CoreStreaming,
                tier: T::Required, used_by: "", present: true },
            RequirementStatus { name: "aac", kind: K::Encoder, feature: F::CoreStreaming,
                tier: T::Required, used_by: "", present: false },
        ];
        assert!(!compute_healthy(&reqs), "a missing Required must fail the check");
    }

    #[test]
    fn missing_optional_component_stays_healthy() {
        use crate::deps::manifest::{Feature as F, Kind as K, Tier as T};
        let reqs = vec![
            RequirementStatus { name: "mpegts", kind: K::Muxer, feature: F::CoreStreaming,
                tier: T::Required, used_by: "", present: true },
            RequirementStatus { name: "h264_nvenc", kind: K::Encoder, feature: F::HardwareAccel,
                tier: T::Optional, used_by: "", present: false },
        ];
        assert!(compute_healthy(&reqs), "a missing Optional must NOT fail the check");
    }

    #[test]
    fn degraded_features_reports_each_broken_feature_once() {
        use crate::deps::manifest::{Feature as F, Kind as K, Tier as T};
        let reqs = vec![
            RequirementStatus { name: "h264_nvenc", kind: K::Encoder, feature: F::HardwareAccel,
                tier: T::Optional, used_by: "", present: false },
            RequirementStatus { name: "hevc_qsv", kind: K::Decoder, feature: F::HardwareAccel,
                tier: T::Optional, used_by: "", present: false },
            RequirementStatus { name: "zscale", kind: K::Filter, feature: F::HdrTonemap,
                tier: T::Optional, used_by: "", present: false },
            RequirementStatus { name: "mpegts", kind: K::Muxer, feature: F::CoreStreaming,
                tier: T::Required, used_by: "", present: true },
        ];
        let report = HealthReport {
            ffmpeg_path: String::new(), ffprobe_path: String::new(),
            ffmpeg_version: None, ffprobe_version: None, version_mismatch: None,
            requirements: reqs, healthy: true,
        };
        let degraded = report.degraded_features();
        assert_eq!(degraded, vec![F::HardwareAccel, F::HdrTonemap],
            "each degraded feature exactly once, first-seen order");
        assert_eq!(report.missing_required().len(), 0);
    }

    #[test]
    fn reset_dump_cache_clears_the_cache() {
        // Seed the global cache directly, then verify the reset drops it.
        // (Path-tagging in check() is the self-heal backstop; this asserts the
        // explicit reset that repair flows rely on.)
        {
            let mut g = DUMP_CACHE.lock().unwrap();
            let mut dumps = HashMap::new();
            dumps.insert("-encoders", vec!["libx264".to_string()]);
            *g = Some(DumpCache {
                ffmpeg: std::path::PathBuf::from("old/ffmpeg.exe"),
                dumps,
            });
        }
        reset_dump_cache();
        let g = DUMP_CACHE.lock().unwrap();
        assert!(g.is_none(), "reset must drop the cached dumps");
    }

    #[test]
    fn kind_binding_selects_the_right_dump() {
        // The manifest must send hevc_qsv to -decoders, never -encoders.
        let hevc_qsv = REQUIREMENTS.iter().find(|r| r.name == "hevc_qsv").unwrap();
        assert_eq!(hevc_qsv.kind, Kind::Decoder);

        // And lavfi to -devices, never -demuxers.
        let lavfi = REQUIREMENTS.iter().find(|r| r.name == "lavfi").unwrap();
        assert_eq!(lavfi.kind.dump_flag(), "-devices");
    }

    #[test]
    fn version_extraction_pulls_the_version_token() {
        // Real banners (verified by execution):
        //   "ffmpeg version 9.0.1-essentials_build-www.gyan.dev Copyright ..."
        //   "ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright ..."
        // nth(2) is the whole version token including the build suffix — which
        // is exactly what the mismatch check wants, since ffmpeg and ffprobe
        // from the SAME build carry identical suffixes and a mixed install
        // differs in the numeric part.
        assert_eq!(
            extract_version("ffmpeg version 9.0.1-essentials_build-www.gyan.dev Copyright"),
            "9.0.1-essentials_build-www.gyan.dev"
        );
        assert_eq!(
            extract_version("ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright"),
            "8.1.1-full_build-www.gyan.dev"
        );
        // Same build => same token => no mismatch.
        let a = extract_version("ffmpeg version 9.0.1-essentials_build-www.gyan.dev");
        let b = extract_version("ffprobe version 9.0.1-essentials_build-www.gyan.dev");
        assert_eq!(a, b, "matched-pair binaries must produce identical tokens");
        // Different builds => different tokens => mismatch detected.
        let c = extract_version("ffprobe version 7.1-full_build-www.gyan.dev");
        assert_ne!(a, c, "a mixed install must be detectable");
    }

    // ---- Integration against the real binaries on this machine ------------

    fn ffmpeg_exe() -> Option<std::path::PathBuf> {
        let p = std::path::PathBuf::from(
            "C:/Users/Mr-N0N4M3/AppData/Local/Temp/ffprobe-essentials/ffmpeg.exe",
        );
        p.exists().then_some(p)
    }

    #[test]
    fn real_essentials_build_passes_every_required_component() {
        let Some(ffmpeg) = ffmpeg_exe() else {
            eprintln!("essentials build not present; skipping");
            return;
        };
        let ffprobe = ffmpeg.with_file_name("ffprobe.exe");
        let report = check(&ffmpeg, &ffprobe).expect("check must run");
        let missing: Vec<_> = report.missing_required();
        assert!(
            missing.is_empty(),
            "essentials build must pass every required component, missing: {:?}",
            missing.iter().map(|r| r.name).collect::<Vec<_>>()
        );
        assert!(report.healthy);
    }

    #[test]
    fn real_build_reports_hw_encoders_as_optional_not_required() {
        let Some(ffmpeg) = ffmpeg_exe() else {
            eprintln!("essentials build not present; skipping");
            return;
        };
        let ffprobe = ffmpeg.with_file_name("ffprobe.exe");
        let report = check(&ffmpeg, &ffprobe).expect("check must run");
        for r in report.requirements.iter().filter(|r| r.name == "h264_nvenc") {
            assert_eq!(r.tier, Tier::Optional);
            // Presence in the dump is fine either way; init probing is a
            // separate, hardware-dependent step (see server.rs h264_encoder_probe).
        }
    }

    #[test]
    fn dump_attachment_option_is_detectable() {
        let Some(ffmpeg) = ffmpeg_exe() else {
            eprintln!("essentials build not present; skipping");
            return;
        };
        assert!(
            has_dump_attachment(&ffmpeg).expect("probe must run"),
            "-dump_attachment must appear in the -h full option table"
        );
    }
}
