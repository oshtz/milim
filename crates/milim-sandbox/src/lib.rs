//! `milim-sandbox` — run agent commands in an isolated container.
//!
//! Phase 4. milim isolates agent code in a Linux VM via Apple's
//! Containerization framework (macOS-only). The cross-platform replacement runs
//! each command through Docker in a `--rm --network none` container.

use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use milim_core::{Error, Result};

/// Options for a sandboxed run.
#[derive(Debug, Clone)]
pub struct RunOpts {
    /// Allow network access inside the container (off by default).
    pub network: bool,
    /// Wall-clock timeout.
    pub timeout: Duration,
    /// Optional working directory inside the container.
    pub workdir: Option<String>,
    /// Memory cap (e.g. `"512m"`); None uses the daemon default.
    pub memory: Option<String>,
}

impl Default for RunOpts {
    fn default() -> Self {
        Self {
            network: false,
            timeout: Duration::from_secs(60),
            workdir: None,
            memory: Some("512m".to_string()),
        }
    }
}

/// The captured result of a sandboxed run.
#[derive(Debug, Clone, Serialize)]
pub struct SandboxOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Runs commands via the `docker` CLI.
#[derive(Debug, Clone)]
pub struct DockerBackend {
    docker_bin: String,
}

impl Default for DockerBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl DockerBackend {
    pub fn new() -> Self {
        Self {
            docker_bin: non_empty_env("MILIM_DOCKER_BIN").unwrap_or_else(|| "docker".to_string()),
        }
    }

    /// Whether the Docker daemon is reachable.
    pub async fn available(&self) -> bool {
        let mut version_cmd = Command::new(&self.docker_bin);
        version_cmd.args(["version", "--format", "{{.Server.Version}}"]);
        #[cfg(windows)]
        version_cmd.creation_flags(milim_core::proc::CREATE_NO_WINDOW);
        let daemon_reachable = version_cmd
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !daemon_reachable {
            return false;
        }

        let mut probe_cmd = Command::new(&self.docker_bin);
        probe_cmd.args([
            "run",
            "--rm",
            "--network",
            "none",
            "--memory",
            "512m",
            "alpine",
            "true",
        ]);
        #[cfg(windows)]
        probe_cmd.creation_flags(milim_core::proc::CREATE_NO_WINDOW);
        probe_cmd
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

impl DockerBackend {
    /// Run `command` inside `image`, returning captured output.
    pub async fn run(
        &self,
        image: &str,
        command: &[String],
        opts: &RunOpts,
    ) -> Result<SandboxOutput> {
        let mut args: Vec<String> = vec!["run".into(), "--rm".into()];
        if !opts.network {
            args.push("--network".into());
            args.push("none".into());
        }
        if let Some(mem) = &opts.memory {
            args.push("--memory".into());
            args.push(mem.clone());
        }
        if let Some(dir) = &opts.workdir {
            args.push("--workdir".into());
            args.push(dir.clone());
        }
        args.push(image.to_string());
        args.extend(command.iter().cloned());

        let mut cmd = Command::new(&self.docker_bin);
        cmd.args(&args);
        #[cfg(windows)]
        cmd.creation_flags(milim_core::proc::CREATE_NO_WINDOW);
        let fut = cmd.output();
        let output = tokio::time::timeout(opts.timeout, fut)
            .await
            .map_err(|_| Error::Other(format!("sandbox run timed out after {:?}", opts.timeout)))?
            .map_err(|e| Error::Other(format!("docker run failed to start: {e}")))?;

        Ok(SandboxOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn builds_default_opts() {
        let o = RunOpts::default();
        assert!(!o.network);
        assert_eq!(o.memory.as_deref(), Some("512m"));
    }

    #[tokio::test]
    async fn available_requires_a_runnable_linux_container() {
        let fake_docker = fake_docker_that_cannot_run_containers();
        let docker = DockerBackend {
            docker_bin: fake_docker.to_string_lossy().into_owned(),
        };

        assert!(!docker.available().await);
    }

    // Gated on a reachable Docker daemon.
    #[tokio::test]
    async fn runs_echo_in_alpine() {
        let docker = DockerBackend::new();
        if !docker.available().await {
            eprintln!("docker not available; skipping sandbox test");
            return;
        }
        let out = docker
            .run(
                "alpine",
                &["echo".into(), "hello-sandbox".into()],
                &RunOpts::default(),
            )
            .await
            .unwrap();
        assert!(
            out.stdout.contains("hello-sandbox"),
            "stdout: {:?}",
            out.stdout
        );
        assert_eq!(out.exit_code, Some(0));
    }

    fn fake_docker_that_cannot_run_containers() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "milim-fake-docker-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        #[cfg(windows)]
        {
            let path = dir.join("docker.cmd");
            fs::write(
                &path,
                "@echo off\r\nif \"%1\"==\"version\" (echo 29.0.0& exit /b 0)\r\nif \"%1\"==\"run\" (echo cannot run linux image 1>&2& exit /b 125)\r\nexit /b 1\r\n",
            )
            .unwrap();
            path
        }

        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;

            let path = dir.join("docker");
            fs::write(
                &path,
                "#!/bin/sh\nif [ \"$1\" = \"version\" ]; then echo 29.0.0; exit 0; fi\nif [ \"$1\" = \"run\" ]; then echo cannot run linux image >&2; exit 125; fi\nexit 1\n",
            )
            .unwrap();
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).unwrap();
            path
        }
    }
}
