//! `CREATE_NO_WINDOW` suppression for spawned child processes.
//!
//! Release builds are GUI-subsystem (`main.rs:2` sets
//! `windows_subsystem = "windows"`), so they have no console attached. When such
//! a process spawns a CONSOLE-subsystem child — `ffmpeg.exe`, `ffprobe.exe`,
//! `ipconfig.exe` are all console apps — Windows allocates a brand new console
//! window for the child unless the parent passes `CREATE_NO_WINDOW`.
//!
//! That is the cause of the black windows flashing during playback, seeking,
//! subtitle loading and hover-scrub: every spawn site pops one. `/thumb` is the
//! worst offender because it fires once per hover-scrub tick.
//!
//! The `ffmpeg-sidecar` crate already does this (`command.rs:776` calls
//! `creation_flags(self, 0x08000000)`), but this app spawns via raw
//! `std::process::Command` / `tokio::process::Command`, so it never benefits.
//!
//! `std` exposes `creation_flags` as a **trait** method
//! (`std::os::windows::process::CommandExt`) while tokio exposes it as an
//! **inherent** method gated on `cfg_windows!`. No single generic covers both,
//! so this module defines one local trait with two impls.
//!
//! On non-Windows targets both impls compile to a no-op that returns `self`
//! unchanged, so call sites need no `cfg` gating of their own.

/// <https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags>
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window for a spawned child process on Windows.
///
/// No-op on Linux and macOS.
pub trait NoWindow {
    /// Apply `CREATE_NO_WINDOW` (Windows only) and return `self` for chaining.
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            // Trait method — the import is scoped here so non-Windows builds
            // don't carry an unused-import warning.
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            // Inherent method on Windows (tokio `process/mod.rs`, inside
            // `cfg_windows!`), so no trait import is required here.
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_window_is_chainable_on_std_command() {
        // Must return &mut Self so it composes with the existing builder chains.
        let mut cmd = std::process::Command::new("cmd_that_is_never_spawned");
        let same: &mut std::process::Command = cmd.no_window();
        // arg() after no_window() proves the builder chain still works.
        same.arg("-version");
    }

    #[test]
    fn no_window_is_chainable_on_tokio_command() {
        let mut cmd = tokio::process::Command::new("cmd_that_is_never_spawned");
        let same: &mut tokio::process::Command = cmd.no_window();
        same.arg("-version");
    }

    /// The whole point of the trait: it must compile and be callable on every
    /// platform, so call sites never need their own `#[cfg]`.
    #[test]
    fn no_window_compiles_on_all_platforms() {
        let mut std_cmd = std::process::Command::new("x");
        std_cmd.no_window();
        let mut tokio_cmd = tokio::process::Command::new("x");
        tokio_cmd.no_window();
    }

    /// A spawned child must still actually run after the flag is applied —
    /// guards against a flag value that makes CreateProcess reject the call.
    #[test]
    fn flagged_command_still_executes() {
        let prog = if cfg!(windows) { "cmd" } else { "sh" };
        let args: &[&str] = if cfg!(windows) {
            &["/C", "exit 0"]
        } else {
            &["-c", "exit 0"]
        };
        let status = std::process::Command::new(prog)
            .args(args)
            .no_window()
            .status();
        assert!(
            matches!(&status, Ok(s) if s.success()),
            "flagged command should still run and exit 0, got {:?}",
            status
        );
    }

    #[cfg(windows)]
    #[test]
    fn create_no_window_constant_is_the_documented_value() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
        // Same value ffmpeg-sidecar uses.
        assert_eq!(CREATE_NO_WINDOW, 134_217_728);
    }
}
