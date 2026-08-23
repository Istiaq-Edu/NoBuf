//! External dependency health check.
//!
//! Verifies that the resolved ffmpeg/ffprobe binaries can actually do what the
//! app needs, rather than merely existing on disk.

pub mod manifest;
pub mod probe;
