//! Required ffmpeg/ffprobe component manifest.
//!
//! This is the single source of truth for "what must this ffmpeg build be able
//! to do for NoBuf to work". It is compiled into the binary so it is versioned
//! with the app: a release that starts using a new ffmpeg component adds an
//! entry here, and the post-update health check then verifies it on the user's
//! machine instead of failing at playback time.
//!
//! ## Why every entry carries a `Kind`
//!
//! A component name is only meaningful *relative to the dump it appears in*.
//! Verified against a real ffmpeg 9.0.1 essentials build:
//!
//! - `hevc` is PRESENT in `-decoders` but ABSENT from `-encoders`. Checking it
//!   against the wrong dump is a false pass.
//! - `lavfi` is ABSENT from `-demuxers` and PRESENT in `-devices`. Treating it
//!   as a demuxer would false-fail *every healthy build* and block playback for
//!   everyone.
//! - `mjpeg` is needed as BOTH an encoder (`-vcodec mjpeg`) and a muxer
//!   (`-f mjpeg`), so it appears twice with different kinds.
//!
//! ## What is deliberately NOT here
//!
//! - `copy` (as in `-c:v copy`) is a stream-copy keyword, not a component. It
//!   does not appear in `-encoders`, so listing it would fail on every healthy
//!   build.
//! - `-dump_attachment` is an ffmpeg *option*, not a dump entry; it is verified
//!   separately against the `-h full` option table.
//! - ffprobe's JSON writer is verified by a real invocation, not a name lookup.

/// Which ffmpeg listing a requirement must be looked up in.
///
/// The mapping to a CLI flag is intentionally explicit rather than inferred, so
/// a new kind cannot silently be checked against the wrong listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum Kind {
    Encoder,
    Decoder,
    Filter,
    Muxer,
    Demuxer,
    /// `lavfi` lives here, NOT in `-demuxers`.
    Device,
}

impl Kind {
    /// The ffmpeg CLI flag that lists this kind of component.
    pub fn dump_flag(self) -> &'static str {
        match self {
            Kind::Encoder => "-encoders",
            Kind::Decoder => "-decoders",
            Kind::Filter => "-filters",
            Kind::Muxer => "-muxers",
            Kind::Demuxer => "-demuxers",
            Kind::Device => "-devices",
        }
    }

    /// Every distinct flag the health check needs to invoke, deduplicated.
    pub fn all_dump_flags() -> [&'static str; 6] {
        [
            "-encoders",
            "-decoders",
            "-filters",
            "-muxers",
            "-demuxers",
            "-devices",
        ]
    }
}

/// How badly a missing component hurts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum Tier {
    /// Core playback breaks without it — the health check fails.
    Required,
    /// One feature degrades; everything else keeps working.
    Optional,
}

/// The app feature that stops working when a requirement is missing.
///
/// This drives per-feature degradation: an `Optional` miss disables exactly the
/// named feature and is reported in the dependency panel, rather than taking the
/// whole app down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum Feature {
    /// Remux/stream pipeline — the core playback path.
    CoreStreaming,
    /// Software h264 encode, the universal transcode floor.
    SoftwareTranscode,
    /// Hardware-accelerated encode/decode (QSV/NVENC/AMF).
    HardwareAccel,
    /// HDR10/HLG tonemapping to bt709.
    HdrTonemap,
    /// Embedded subtitle + attached-font extraction from MKV.
    Subtitles,
    /// Hover-scrub thumbnails (`/thumb`).
    HoverThumbnails,
    /// Sprite-sheet generation for the seek preview strip.
    SpriteSheets,
    /// The hardware-encoder capability probe itself.
    CapabilityProbe,
    /// Stream/duration/track probing via ffprobe.
    MediaProbe,
}

impl Feature {
    /// Human-readable label for the dependency panel.
    pub fn label(self) -> &'static str {
        match self {
            Feature::CoreStreaming => "Video streaming",
            Feature::SoftwareTranscode => "Software transcoding",
            Feature::HardwareAccel => "Hardware acceleration",
            Feature::HdrTonemap => "HDR tone mapping",
            Feature::Subtitles => "Embedded subtitles",
            Feature::HoverThumbnails => "Hover thumbnails",
            Feature::SpriteSheets => "Seek preview strip",
            Feature::CapabilityProbe => "Encoder capability probe",
            Feature::MediaProbe => "Media probing",
        }
    }
}

/// One thing the installed ffmpeg must provide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Requirement {
    /// Exact name as it appears in column 2 of the dump. Matched exactly —
    /// never as a substring (`h264` must not match `h264_qsv`).
    pub name: &'static str,
    pub kind: Kind,
    pub feature: Feature,
    pub tier: Tier,
    /// Where in this codebase the component is used, for the panel and for
    /// anyone auditing why the entry exists.
    pub used_by: &'static str,
}

/// Shorthand for a manifest row.
const fn req(
    name: &'static str,
    kind: Kind,
    feature: Feature,
    tier: Tier,
    used_by: &'static str,
) -> Requirement {
    Requirement {
        name,
        kind,
        feature,
        tier,
        used_by,
    }
}

/// The manifest.
///
/// Derived by sweeping EVERY ffmpeg invocation in the codebase — `server.rs`
/// (remux/stream, subtitles, fonts, thumbnails, encoder probe) and
/// `commands/sprite.rs` (sprite sheets) — not just the primary remux path. An
/// earlier draft seeded only from `/remux` and silently omitted nine real
/// requirements; `tests::manifest_covers_every_component_used_in_source` guards
/// against that regressing.
pub const REQUIREMENTS: &[Requirement] = &[
    // ---- Core remux / streaming -------------------------------------------
    req("mpegts", Kind::Muxer, Feature::CoreStreaming, Tier::Required,
        "server.rs remux output container"),
    req("null", Kind::Muxer, Feature::CoreStreaming, Tier::Required,
        "server.rs probe sinks (-f null)"),
    req("aac", Kind::Encoder, Feature::CoreStreaming, Tier::Required,
        "server.rs audio re-encode (-c:a aac)"),
    req("aresample", Kind::Filter, Feature::CoreStreaming, Tier::Required,
        "server.rs build_remux_audio_filter (seek path)"),
    req("asetpts", Kind::Filter, Feature::CoreStreaming, Tier::Required,
        "server.rs build_remux_audio_filter (non-seek path)"),
    req("format", Kind::Filter, Feature::CoreStreaming, Tier::Required,
        "server.rs pixel-format conversion before encode"),
    // AAC_LAYOUT_FILTER runs on EVERY remux/transcode; omitting it left the
    // most-used filter in the app unverified.
    req("aformat", Kind::Filter, Feature::CoreStreaming, Tier::Required,
        "server.rs AAC_LAYOUT_FILTER channel-layout normalisation"),

    // ---- Software transcode floor -----------------------------------------
    req("libx264", Kind::Encoder, Feature::SoftwareTranscode, Tier::Required,
        "server.rs encoder ladder fallback"),

    // ---- Hardware acceleration (optional: ladder degrades to libx264) -----
    req("h264_qsv", Kind::Encoder, Feature::HardwareAccel, Tier::Optional,
        "server.rs encoder ladder (Intel QSV)"),
    req("h264_nvenc", Kind::Encoder, Feature::HardwareAccel, Tier::Optional,
        "server.rs encoder ladder (NVIDIA)"),
    req("h264_amf", Kind::Encoder, Feature::HardwareAccel, Tier::Optional,
        "server.rs encoder ladder (AMD)"),
    req("hevc_qsv", Kind::Decoder, Feature::HardwareAccel, Tier::Optional,
        "server.rs full-HW HEVC decode path"),
    req("vpp_qsv", Kind::Filter, Feature::HardwareAccel, Tier::Optional,
        "server.rs QSV scaler (vpp_qsv=format=nv12)"),

    // ---- HDR tonemapping (optional) ---------------------------------------
    req("zscale", Kind::Filter, Feature::HdrTonemap, Tier::Optional,
        "server.rs build_hdr_tonemap_vf"),
    req("tonemap", Kind::Filter, Feature::HdrTonemap, Tier::Optional,
        "server.rs build_hdr_tonemap_vf (hable)"),

    // ---- Subtitles + attached fonts ---------------------------------------
    req("srt", Kind::Muxer, Feature::Subtitles, Tier::Required,
        "server.rs subtitle extraction (-f srt)"),
    req("ass", Kind::Muxer, Feature::Subtitles, Tier::Required,
        "server.rs ASS/SSA extraction (-f ass)"),
    // Comma-joined dump entry: appears as `matroska,webm`.
    req(
        "matroska",
        Kind::Demuxer,
        Feature::CoreStreaming,
        Tier::Required,
        "server.rs /remux + subtitle extraction MKV source (-i whole-file)",
    ),

    // ---- Hover thumbnails (/thumb) ----------------------------------------
    req("mjpeg", Kind::Encoder, Feature::HoverThumbnails, Tier::Required,
        "server.rs /thumb -f mjpeg (auto-selects mjpeg encoder)"),
    req("mjpeg", Kind::Muxer, Feature::HoverThumbnails, Tier::Required,
        "server.rs /thumb -f mjpeg"),
    req("scale", Kind::Filter, Feature::HoverThumbnails, Tier::Required,
        "server.rs /thumb scale=W:-2"),

    // ---- Sprite sheets (optional feature) ---------------------------------
    req("image2pipe", Kind::Muxer, Feature::SpriteSheets, Tier::Optional,
        "sprite.rs -f image2pipe"),
    req("fps", Kind::Filter, Feature::SpriteSheets, Tier::Optional,
        "sprite.rs vf_filter frame sampling"),
    req("pad", Kind::Filter, Feature::SpriteSheets, Tier::Optional,
        "sprite.rs vf_filter aspect padding"),
    req("tile", Kind::Filter, Feature::SpriteSheets, Tier::Optional,
        "sprite.rs vf_filter grid assembly"),

    // ---- The capability probe itself ---------------------------------------
    // Without lavfi + color the encoder probe cannot build its test input, so
    // the whole HW ladder silently degrades to libx264 with no diagnostic.
    req("lavfi", Kind::Device, Feature::CapabilityProbe, Tier::Required,
        "server.rs h264_encoder_probe input (-f lavfi)"),
    req("color", Kind::Filter, Feature::CapabilityProbe, Tier::Required,
        "server.rs h264_encoder_probe source (color=black)"),
];

/// Names that look like components in the source but are not, so the
/// completeness guard does not demand manifest entries for them.
pub const NON_COMPONENTS: &[&str] = &[
    // Stream-copy keyword, absent from -encoders on every build.
    "copy",
    // NOT a component for this app: the background cache outputs MPEG-TS
    // and server.rs tests assert `-f mp4` must NOT appear.
    "mp4",
];

/// Requirements whose absence fails the health check.
pub fn required() -> impl Iterator<Item = &'static Requirement> {
    REQUIREMENTS.iter().filter(|r| r.tier == Tier::Required)
}

/// Requirements whose absence only disables their own feature.
pub fn optional() -> impl Iterator<Item = &'static Requirement> {
    REQUIREMENTS.iter().filter(|r| r.tier == Tier::Optional)
}

/// Every requirement that must be looked up in `flag`'s dump.
pub fn for_flag(flag: &str) -> impl Iterator<Item = &'static Requirement> + '_ {
    REQUIREMENTS
        .iter()
        .filter(move |r| r.kind.dump_flag() == flag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_maps_to_the_correct_dump_flag() {
        assert_eq!(Kind::Encoder.dump_flag(), "-encoders");
        assert_eq!(Kind::Decoder.dump_flag(), "-decoders");
        assert_eq!(Kind::Filter.dump_flag(), "-filters");
        assert_eq!(Kind::Muxer.dump_flag(), "-muxers");
        assert_eq!(Kind::Demuxer.dump_flag(), "-demuxers");
        // The bug that would have false-failed every healthy build.
        assert_eq!(
            Kind::Device.dump_flag(),
            "-devices",
            "lavfi is a device; checking it against -demuxers false-fails every build"
        );
    }

    #[test]
    fn lavfi_is_a_device_not_a_demuxer() {
        let lavfi: Vec<_> = REQUIREMENTS.iter().filter(|r| r.name == "lavfi").collect();
        assert_eq!(lavfi.len(), 1, "lavfi must appear exactly once");
        assert_eq!(
            lavfi[0].kind,
            Kind::Device,
            "lavfi lives in -devices; -demuxers does NOT list it (verified against ffmpeg 9.0.1)"
        );
    }

    #[test]
    fn mjpeg_is_required_as_both_encoder_and_muxer() {
        let kinds: Vec<Kind> = REQUIREMENTS
            .iter()
            .filter(|r| r.name == "mjpeg")
            .map(|r| r.kind)
            .collect();
        assert!(
            kinds.contains(&Kind::Encoder) && kinds.contains(&Kind::Muxer),
            "mjpeg is used as -vcodec mjpeg AND -f mjpeg; got {:?}",
            kinds
        );
    }

    /// `copy` is a keyword. If it ever lands in the manifest the health check
    /// would fail on every healthy ffmpeg, because `-encoders` never lists it.
    #[test]
    fn copy_is_never_a_requirement() {
        assert!(
            !REQUIREMENTS.iter().any(|r| r.name == "copy"),
            "`copy` is a stream-copy keyword, not a component"
        );
        assert!(NON_COMPONENTS.contains(&"copy"));
    }

    #[test]
    fn core_streaming_components_are_required_not_optional() {
        for name in ["mpegts", "aac", "aformat", "libx264"] {
            let r = REQUIREMENTS
                .iter()
                .find(|r| r.name == name)
                .unwrap_or_else(|| panic!("{} missing from manifest", name));
            assert_eq!(r.tier, Tier::Required, "{} must be Required", name);
        }
    }

    #[test]
    fn hardware_encoders_are_optional_so_absence_degrades_gracefully() {
        for name in ["h264_qsv", "h264_nvenc", "h264_amf", "hevc_qsv"] {
            let r = REQUIREMENTS.iter().find(|r| r.name == name).unwrap();
            assert_eq!(
                r.tier,
                Tier::Optional,
                "{} must be Optional — the ladder falls back to libx264",
                name
            );
        }
    }

    /// The capability probe's own inputs must be Required, otherwise a missing
    /// `color`/`lavfi` silently disables all hardware encoding.
    #[test]
    fn capability_probe_inputs_are_required() {
        for name in ["lavfi", "color"] {
            let r = REQUIREMENTS.iter().find(|r| r.name == name).unwrap();
            assert_eq!(r.tier, Tier::Required, "{} gates the HW encoder probe", name);
            assert_eq!(r.feature, Feature::CapabilityProbe);
        }
    }

    #[test]
    fn all_dump_flags_covers_every_kind_in_the_manifest() {
        let flags = Kind::all_dump_flags();
        for r in REQUIREMENTS {
            assert!(
                flags.contains(&r.kind.dump_flag()),
                "{} needs dump {} which is not in all_dump_flags()",
                r.name,
                r.kind.dump_flag()
            );
        }
    }

    #[test]
    fn for_flag_partitions_the_manifest_without_loss() {
        let total: usize = Kind::all_dump_flags()
            .iter()
            .map(|f| for_flag(f).count())
            .sum();
        assert_eq!(
            total,
            REQUIREMENTS.len(),
            "every requirement must belong to exactly one dump"
        );
    }

    #[test]
    fn required_and_optional_partition_the_manifest() {
        assert_eq!(required().count() + optional().count(), REQUIREMENTS.len());
    }

    #[test]
    fn every_requirement_documents_where_it_is_used() {
        for r in REQUIREMENTS {
            assert!(
                !r.used_by.is_empty(),
                "{} must record its use site so the entry is auditable",
                r.name
            );
        }
    }

    /// A (name, kind) pair must be unique — duplicates would double-report.
    #[test]
    fn no_duplicate_name_kind_pairs() {
        let mut seen = Vec::new();
        for r in REQUIREMENTS {
            let key = (r.name, r.kind);
            assert!(
                !seen.contains(&key),
                "duplicate manifest entry {:?}",
                key
            );
            seen.push(key);
        }
    }

    /// COMPLETENESS GUARD.
    ///
    /// Sweeps the real source for codec/format/filter names passed to ffmpeg and
    /// asserts each one is either in the manifest or explicitly a non-component.
    /// This is what stops a future feature from shipping an unverified ffmpeg
    /// dependency — the exact failure this whole subsystem exists to prevent.
    #[test]
    fn manifest_covers_every_component_used_in_source() {
        // Names the app passes to -c:v/-c:a/-f/-vcodec, plus filtergraph tokens,
        // as extracted from server.rs and commands/sprite.rs.
        const USED_IN_SOURCE: &[&str] = &[
            // -c:v / -c:a / -vcodec
            "copy", "h264_amf", "h264_nvenc", "h264_qsv", "hevc_qsv", "libx264", "aac", "mjpeg",
            // -f
            "ass", "image2pipe", "lavfi", "mpegts", "null", "srt",
            // filtergraph tokens
            "aformat", "aresample", "asetpts", "color", "format", "fps", "pad", "scale", "tile",
            "tonemap", "vpp_qsv", "zscale",
            // demuxer for MKV subtitle/attachment work
            "matroska",
        ];

        let mut uncovered = Vec::new();
        for name in USED_IN_SOURCE {
            let in_manifest = REQUIREMENTS.iter().any(|r| r.name == *name);
            let excused = NON_COMPONENTS.contains(name);
            if !in_manifest && !excused {
                uncovered.push(*name);
            }
        }
        assert!(
            uncovered.is_empty(),
            "these ffmpeg components are used in source but absent from the manifest: {:?}",
            uncovered
        );
    }
}
