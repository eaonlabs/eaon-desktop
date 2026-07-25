// Hardware specs for the Models page's "will this fit?" estimates —
// quantized-weights size vs. installed memory, the same heuristic the Mac
// app derives from ProcessInfo.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSpecs {
    pub total_mem_bytes: u64,
    pub cpu_cores: u32,
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub fn system_specs() -> SystemSpecs {
    // Memory-only refresh on purpose: System::new_all() walks every
    // process and disk for data the fit estimate never looks at.
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    // Logical cores via the standard library — that's the parallelism
    // local inference actually gets, and it needs no extra sysinfo
    // features. Fall back to 1 so per-core math downstream can never
    // divide by zero.
    let cpu_cores = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
    SystemSpecs {
        total_mem_bytes: sys.total_memory(),
        cpu_cores,
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::system_specs;

    #[test]
    fn specs_report_real_hardware() {
        let specs = system_specs();
        // Any machine that can run the test suite has RAM and a core.
        assert!(specs.total_mem_bytes > 0, "total memory must be non-zero");
        assert!(specs.cpu_cores >= 1);
        assert_eq!(specs.os, std::env::consts::OS);
        assert_eq!(specs.arch, std::env::consts::ARCH);
    }
}
