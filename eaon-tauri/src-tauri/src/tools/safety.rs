// The guard rails every tool leans on — the cross-platform analogue of the
// Mac `isModifiablePath` model: lexical normalization plus symlink
// resolution, writes confined to the user's home folder and the OS temp dir,
// a protected-roots refusal list, and the shell privilege-escalation block.

use super::ToolOutcome;
use std::path::{Component, Path, PathBuf};

pub(crate) fn home_dir() -> PathBuf {
    // No external `dirs` crate — read the platform's own home variable.
    if cfg!(windows) {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Users\\Default"))
    } else {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
    }
}

/// Windows `canonicalize` returns `\\?\C:\…` (or `\\?\UNC\server\share`)
/// verbatim paths. Left alone they'd (a) slip past `is_protected`'s
/// lowercase `c:\windows` prefix checks — an existing system path would
/// never match — and (b) leak `\\?\` into every path echoed back to the
/// model, which reads as noise and trips `cmd.exe` when reused. Strip the
/// prefix back to the ordinary form (what the `dunce` crate does). Plain
/// string work, always compiled, so tests prove it from any host OS.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    p
}

/// Lexically normalize (resolve `.`/`..`, expand a leading `~`, make absolute
/// against home) WITHOUT touching the filesystem — so it works for a
/// not-yet-created file. When the path already exists we additionally
/// `canonicalize` to collapse symlinks, closing the "symlink under home
/// points outside" escape the Mac version guards with `resolvingSymlinksInPath`.
pub(crate) fn normalize(raw: &str) -> PathBuf {
    let raw = raw.trim();
    let expanded: PathBuf = if raw == "~" {
        home_dir()
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home_dir().join(rest)
    } else {
        PathBuf::from(raw)
    };

    let absolute = if expanded.is_absolute() { expanded } else { home_dir().join(expanded) };

    let mut out = PathBuf::new();
    for comp in absolute.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }

    // Resolve symlinks so the guard can't be fooled — and so a path matches
    // the canonicalized allow-roots. When the full path exists, canonicalize
    // it directly. When it doesn't (a not-yet-created file), canonicalize the
    // deepest EXISTING ancestor and re-append the remaining components — this
    // is what makes a new file under a symlinked temp dir (macOS `/var` →
    // `/private/var`) resolve to the same root as `allowed_write_bases`.
    if let Ok(canon) = std::fs::canonicalize(&out) {
        return strip_verbatim(canon);
    }
    let mut ancestor = out.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !ancestor.exists() {
        if let Some(name) = ancestor.file_name() {
            tail.push(name.to_os_string());
        }
        if !ancestor.pop() {
            break;
        }
    }
    let mut base = strip_verbatim(std::fs::canonicalize(&ancestor).unwrap_or(ancestor));
    for name in tail.iter().rev() {
        base.push(name);
    }
    base
}

/// System locations a write/move must never touch. Most would be refused by
/// the OS anyway, but a clear "that's a protected system path" beats a
/// confusing permission error — and it stops the model shuffling things
/// around inside them.
pub(crate) fn is_protected(path: &Path) -> bool {
    let p = path.to_string_lossy();
    if cfg!(windows) {
        windows_protected(&p)
    } else {
        unix_protected(&p)
    }
}

/// The Windows set — a plain string check, always compiled, so the test
/// suite proves this list from any host OS.
fn windows_protected(p: &str) -> bool {
    let lower = p.to_lowercase();
    // The "c:\program files" prefix also covers "c:\program files (x86)".
    lower.starts_with("c:\\windows")
        || lower.starts_with("c:\\program files")
        || lower.starts_with("c:\\programdata")
}

/// The Unix set — Linux system roots, plus the macOS ones from the reference
/// port (macOS is best-effort here, but the guard costs nothing to keep).
fn unix_protected(p: &str) -> bool {
    const ROOTS: &[&str] = &[
        "/etc", "/usr", "/bin", "/sbin", "/boot", "/lib", "/lib64", "/opt",
        "/root", "/var", "/srv", "/proc", "/sys", "/dev", "/run",
        "/System", "/Library", "/private/var", "/private/etc", "/cores",
    ];
    // Exact match or slash-prefix, so "/usrdata" never trips on "/usr".
    ROOTS.iter().any(|r| p == *r || p.starts_with(&format!("{r}/")))
}

pub(crate) fn is_within(base: &Path, path: &Path) -> bool {
    path == base || path.starts_with(base)
}

/// The safe write roots: the user's home folder and the OS temp dir(s). Both
/// are canonicalized so a symlinked temp (macOS `TMPDIR` resolves under
/// `/private/var/...`) still matches a canonicalized target path.
///
/// `std::env::temp_dir()` alone isn't enough on macOS: it honors `TMPDIR`,
/// which the OS sets to a per-user sandbox under `/private/var/folders/...`,
/// NOT the traditional `/tmp` every model (and person) reaches for first.
/// A real agent run hit exactly this — asked to use `/tmp`, refused, had to
/// self-correct — so `/tmp` is allow-listed explicitly here alongside
/// whatever `temp_dir()` reports, matching the Mac app's own explicit
/// `hasPrefix("/tmp/")` allowance.
pub(crate) fn allowed_write_bases() -> Vec<PathBuf> {
    let mut bases = vec![normalize(&home_dir().to_string_lossy())];
    let temp = std::env::temp_dir();
    bases.push(strip_verbatim(std::fs::canonicalize(&temp).unwrap_or(temp)));
    if cfg!(unix) {
        let tmp = PathBuf::from("/tmp");
        if let Ok(canon) = std::fs::canonicalize(&tmp) {
            bases.push(canon);
        } else {
            bases.push(tmp);
        }
    }
    bases
}

/// True for a path safe to modify — under the user's home folder or the OS
/// temp dir. The cross-platform analogue of the Mac `isModifiablePath` (home
/// / /Volumes / /tmp). Default-deny: anything outside those two roots (which
/// includes every protected system location) is refused.
pub(crate) fn is_modifiable(path: &Path) -> bool {
    allowed_write_bases().iter().any(|b| is_within(b, path))
}

pub(crate) fn guard_modifiable(path: &Path, action: &str) -> Option<ToolOutcome> {
    if is_modifiable(path) {
        None
    } else {
        Some(ToolOutcome::err(format!(
            "Refused: {action} is only allowed on paths under your home folder or the temp folder — not \"{}\", which is a system or out-of-scope location.",
            path.display()
        )))
    }
}

/// A search/find root must exist, be a directory, and not be a drive root or
/// system location — a recursive walk from the top of a drive would be
/// catastrophic even though it only reads.
pub(crate) fn resolve_search_root(raw: &str) -> Result<PathBuf, ToolOutcome> {
    let path = normalize(raw);
    if !path.exists() {
        return Err(ToolOutcome::err(format!("No such directory: {}", path.display())));
    }
    if !path.is_dir() {
        return Err(ToolOutcome::err(format!(
            "That's a file, not a folder: {} — give the directory to search under.",
            path.display()
        )));
    }
    // Home and temp are always searchable — checked BEFORE the protected
    // check, since the OS temp dir lives under a protected root on macOS.
    if allowed_write_bases().iter().any(|b| is_within(b, &path)) {
        return Ok(path);
    }
    // Refuse a filesystem/drive root (e.g. "/" or "C:\").
    if path.parent().is_none() {
        return Err(ToolOutcome::err(
            "Refused: searching from a drive root would scan the whole disk. Point at a project folder.".to_string(),
        ));
    }
    if is_protected(&path) {
        return Err(ToolOutcome::err(format!(
            "Refused: {} is a system location. Search within a project under your home folder instead.",
            path.display()
        )));
    }
    // Any other readable user directory is fine for a read-only search.
    Ok(path)
}

/// Privilege escalation is refused outright — the agent runs as the user,
/// never as an administrator. Token-wise check (split on non-alphanumerics)
/// so `sudo` and friends are caught anywhere in the command line — piped,
/// chained, or first word — not just space-padded.
pub(crate) fn mentions_escalation(command: &str) -> bool {
    command
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|tok| matches!(tok, "sudo" | "doas" | "runas" | "gsudo"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // New with the split port: the refusal list must cover BOTH platform
    // sets. The per-platform helpers are always compiled, so a Linux/mac
    // test run still proves the Windows roots (and vice versa) — no #[cfg]
    // gate needed for the lists themselves.
    #[test]
    fn protected_roots_cover_both_platform_sets() {
        // Windows-style roots.
        assert!(windows_protected("C:\\Windows\\System32\\drivers\\etc\\hosts"));
        assert!(windows_protected("c:\\program files\\App\\app.exe"));
        assert!(windows_protected("C:\\Program Files (x86)\\App\\app.exe"));
        assert!(windows_protected("C:\\ProgramData\\keys.dat"));
        assert!(!windows_protected("C:\\Users\\me\\project\\main.rs"));

        // Linux-style roots.
        assert!(unix_protected("/etc/passwd"));
        assert!(unix_protected("/usr/bin/env"));
        assert!(unix_protected("/boot/vmlinuz"));
        assert!(unix_protected("/root/.ssh/id_rsa"));
        assert!(unix_protected("/var/log/syslog"));
        assert!(!unix_protected("/home/me/project/main.rs"));
        assert!(!unix_protected("/usrdata/fine")); // prefix must not overreach

        // And the dispatching wrapper refuses the running platform's set.
        let native =
            if cfg!(windows) { Path::new("C:\\Windows\\notepad.exe") } else { Path::new("/usr/bin/env") };
        assert!(is_protected(native));
    }

    // A live agent run hit this exact gap: std::env::temp_dir() alone
    // resolves to macOS's per-user TMPDIR sandbox, not /tmp, so a model
    // asked to use /tmp (the one temp path everyone reaches for first) was
    // refused and had to self-correct. /tmp must be allowed outright.
    #[test]
    #[cfg(unix)]
    fn tmp_is_an_allowed_write_base() {
        assert!(is_modifiable(&normalize("/tmp/some-eaon-test-path/file.txt")));
    }

    // Windows canonicalize yields \\?\-verbatim paths; unstripped they'd
    // bypass the lowercase c:\windows prefix guard AND leak \\?\ into every
    // path the model sees. Pure string logic, so this proves the Windows
    // behavior from any host.
    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\Windows\System32")),
            PathBuf::from(r"C:\Windows\System32")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\file.txt")),
            PathBuf::from(r"\\server\share\file.txt")
        );
        // Non-verbatim paths pass through untouched (the Unix case).
        assert_eq!(strip_verbatim(PathBuf::from("/tmp/x")), PathBuf::from("/tmp/x"));
        assert_eq!(strip_verbatim(PathBuf::from(r"C:\plain")), PathBuf::from(r"C:\plain"));

        // The guard the stripping exists to protect: a stripped system path
        // is caught; the verbatim form would NOT have been.
        assert!(windows_protected(r"c:\windows\system32"));
        assert!(!windows_protected(r"\\?\c:\windows\system32"));
    }
}
