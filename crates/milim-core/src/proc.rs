//! Helpers for spawning child processes without flashing a console window.
//!
//! On Windows, a GUI-subsystem app (the Tauri desktop shell and its embedded
//! server) that spawns a console executable — `git`, `node`, `cmd`,
//! `docker`, MCP servers, voice tools, and other helpers — briefly pops a console
//! window for each spawn unless `CREATE_NO_WINDOW` is set. These helpers apply
//! that flag and are no-ops on other platforms.

/// Windows [`CREATE_NO_WINDOW`] process-creation flag.
///
/// [`CREATE_NO_WINDOW`]: https://learn.microsoft.com/windows/win32/procthread/process-creation-flags
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply [`CREATE_NO_WINDOW`] to a [`std::process::Command`] on Windows so the
/// spawned console program does not flash a window. No-op elsewhere.
pub fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
