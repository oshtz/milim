//! Speech-to-text abstractions.
//!
//! The default workspace build stays free of native speech dependencies. A
//! concrete Whisper implementation can plug in behind this trait without
//! changing the HTTP contract or desktop client.

use async_trait::async_trait;
use milim_core::{Error, Result};

#[cfg(any(test, feature = "native-tts"))]
use serde::Deserialize;
use serde_json::Value;
#[cfg(any(test, feature = "native-tts"))]
use std::collections::HashMap;
#[cfg(any(test, feature = "native-tts"))]
use std::ffi::OsString;
#[cfg(any(test, feature = "native-tts"))]
use std::io::Cursor;
use std::path::Path;
#[cfg(any(test, feature = "native-tts", feature = "native-vad"))]
use std::path::PathBuf;
use std::process::Stdio;
#[cfg(feature = "native-tts-espeak")]
use std::sync::OnceLock;
use tokio::io::AsyncWriteExt;

#[cfg(feature = "whisper")]
use std::sync::Arc;
#[cfg(feature = "whisper")]
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Environment variable that points to a whisper.cpp GGML model file.
#[cfg(feature = "whisper")]
pub const MILIM_WHISPER_MODEL_ENV: &str = "MILIM_WHISPER_MODEL";

/// Audio payload passed to a speech-to-text backend.
#[derive(Debug, Clone)]
pub struct TranscriptionInput {
    pub audio: Vec<u8>,
    pub mime_type: Option<String>,
}

/// Normalized transcription result returned by `/audio/transcriptions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionOutput {
    pub text: String,
}

/// Text payload passed to a text-to-speech backend.
#[derive(Debug, Clone)]
pub struct SpeechInput {
    pub text: String,
    pub voice: Option<String>,
    pub speed: Option<f32>,
}

/// Normalized speech result returned by `/audio/speech`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechOutput {
    pub audio: Vec<u8>,
    pub mime_type: String,
}

/// Audio payload passed to a voice activity detector.
#[derive(Debug, Clone)]
pub struct VoiceActivityInput {
    pub audio: Vec<u8>,
    pub mime_type: Option<String>,
}

/// Normalized voice activity result returned by `/audio/vad`.
#[derive(Debug, Clone, PartialEq)]
pub struct VoiceActivityOutput {
    pub is_speech: bool,
    pub speech_probability: f32,
}

/// A backend that can transcribe one audio payload.
#[async_trait]
pub trait Transcriber: Send + Sync {
    async fn transcribe(&self, input: TranscriptionInput) -> Result<TranscriptionOutput>;
}

/// A backend that can synthesize one text payload.
#[async_trait]
pub trait Synthesizer: Send + Sync {
    async fn synthesize(&self, input: SpeechInput) -> Result<SpeechOutput>;
}

/// A backend that can classify whether an audio payload contains speech.
#[async_trait]
pub trait VoiceActivityDetector: Send + Sync {
    async fn detect(&self, input: VoiceActivityInput) -> Result<VoiceActivityOutput>;
}

/// Default NVIDIA Parakeet model id used by the command adapter.
pub const DEFAULT_PARAKEET_MODEL: &str = "nvidia/parakeet-tdt-0.6b-v2";

/// Default RMS threshold used by the lightweight energy VAD.
pub const DEFAULT_ENERGY_VAD_THRESHOLD: f32 = 0.015;

/// Sample rate expected by the official Silero VAD ONNX models.
pub const SILERO_VAD_SAMPLE_RATE: u32 = 16_000;

/// Frame size used by Silero VAD for 16 kHz audio.
pub const SILERO_VAD_CHUNK_SAMPLES: usize = 512;

/// Context samples prepended by newer Silero VAD ONNX exports.
pub const SILERO_VAD_CONTEXT_SAMPLES: usize = 64;

/// Recurrent state shape is `[2, batch, 128]`; the app only processes batch 1.
pub const SILERO_VAD_STATE_SAMPLES: usize = 2 * 128;

/// Default speech probability threshold used by Silero VAD wrappers.
pub const DEFAULT_SILERO_VAD_THRESHOLD: f32 = 0.5;

fn validate_http_endpoint(endpoint: &str, label: &str) -> Result<String> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err(Error::InvalidRequest(format!(
            "{label} endpoint is required"
        )));
    }
    if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
        return Err(Error::InvalidRequest(format!(
            "{label} endpoint must be http:// or https://"
        )));
    }
    Ok(endpoint.to_string())
}

fn transcription_text_from_json(value: Value, label: &str) -> Result<TranscriptionOutput> {
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Inference(format!("{label} response is missing text")))?;
    Ok(TranscriptionOutput {
        text: text.to_string(),
    })
}

/// Validate that a local voice command exists either as an explicit path or on PATH.
pub fn validate_voice_command(command: impl AsRef<str>) -> Result<String> {
    let command = command.as_ref().trim();
    if command.is_empty() {
        return Err(Error::InvalidRequest(
            "voice command is required".to_string(),
        ));
    }

    let path = Path::new(command);
    if path.components().count() > 1 || path.is_absolute() {
        return if path.is_file() {
            Ok(path.to_string_lossy().to_string())
        } else {
            Err(Error::InvalidRequest(format!(
                "voice command was not found: {command}"
            )))
        };
    }

    for candidate in voice_command_candidates(command) {
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err(Error::InvalidRequest(format!(
        "voice command was not found on PATH: {command}"
    )))
}

fn voice_command_candidates(command: &str) -> Vec<std::path::PathBuf> {
    let Some(paths) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for dir in std::env::split_paths(&paths) {
        out.push(dir.join(command));
        #[cfg(windows)]
        {
            if Path::new(command).extension().is_none() {
                let pathext = std::env::var_os("PATHEXT")
                    .and_then(|v| v.into_string().ok())
                    .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
                for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
                    out.push(dir.join(format!("{command}{ext}")));
                }
            }
        }
    }
    out
}

/// Validate that a local voice model file exists.
pub fn validate_voice_model_file(path: impl AsRef<str>, label: &str) -> Result<String> {
    let path = path.as_ref().trim();
    if path.is_empty() {
        return Err(Error::InvalidRequest(format!("{label} is required")));
    }
    let path_ref = Path::new(path);
    if path_ref.is_file() {
        Ok(path_ref.to_string_lossy().to_string())
    } else {
        Err(Error::InvalidRequest(format!(
            "{label} was not found: {path}"
        )))
    }
}

/// Remote STT backend for milim-compatible raw-WAV endpoints.
///
/// The endpoint receives the WAV bytes as the request body and must respond
/// with JSON shaped like `{ "text": "..." }`.
#[derive(Clone, Debug)]
pub struct RemoteRawTranscriber {
    endpoint: String,
    client: reqwest::Client,
}

impl RemoteRawTranscriber {
    pub fn new(endpoint: impl AsRef<str>) -> Result<Self> {
        Ok(Self {
            endpoint: validate_http_endpoint(endpoint.as_ref(), "remote STT")?,
            client: reqwest::Client::new(),
        })
    }
}

#[async_trait]
impl Transcriber for RemoteRawTranscriber {
    async fn transcribe(&self, input: TranscriptionInput) -> Result<TranscriptionOutput> {
        let resp = self
            .client
            .post(&self.endpoint)
            .header(
                "content-type",
                input
                    .mime_type
                    .as_deref()
                    .unwrap_or("application/octet-stream"),
            )
            .body(input.audio)
            .send()
            .await
            .map_err(|e| Error::Inference(format!("remote STT request failed: {e}")))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| Error::Inference(format!("remote STT response failed: {e}")))?;
        if !status.is_success() {
            return Err(Error::Inference(format!(
                "remote STT returned HTTP {status}: {body}"
            )));
        }
        let value: Value = serde_json::from_str(&body)
            .map_err(|e| Error::Inference(format!("remote STT returned invalid JSON: {e}")))?;
        transcription_text_from_json(value, "remote STT")
    }
}

/// OpenAI-compatible `/audio/transcriptions` backend.
///
/// The endpoint receives multipart form data with `model` and `file`, and must
/// return OpenAI-style JSON containing `text`.
#[derive(Clone, Debug)]
pub struct OpenAiAudioTranscriptionTranscriber {
    endpoint: String,
    model: String,
    api_key: Option<String>,
    client: reqwest::Client,
}

impl OpenAiAudioTranscriptionTranscriber {
    pub fn new(
        endpoint: impl AsRef<str>,
        model: impl AsRef<str>,
        api_key: Option<String>,
    ) -> Result<Self> {
        let model = model.as_ref().trim();
        if model.is_empty() {
            return Err(Error::InvalidRequest(
                "OpenAI-compatible STT model is required".to_string(),
            ));
        }
        Ok(Self {
            endpoint: validate_http_endpoint(endpoint.as_ref(), "OpenAI-compatible STT")?,
            model: model.to_string(),
            api_key: api_key.filter(|key| !key.trim().is_empty()),
            client: reqwest::Client::new(),
        })
    }
}

#[async_trait]
impl Transcriber for OpenAiAudioTranscriptionTranscriber {
    async fn transcribe(&self, input: TranscriptionInput) -> Result<TranscriptionOutput> {
        let mime_type = input.mime_type.as_deref().unwrap_or("audio/wav");
        let file = reqwest::multipart::Part::bytes(input.audio)
            .file_name("audio.wav")
            .mime_str(mime_type)
            .map_err(|e| Error::InvalidRequest(format!("invalid audio MIME type: {e}")))?;
        let form = reqwest::multipart::Form::new()
            .text("model", self.model.clone())
            .part("file", file);
        let mut request = self.client.post(&self.endpoint).multipart(form);
        if let Some(api_key) = &self.api_key {
            request = request.bearer_auth(api_key);
        }
        let resp = request
            .send()
            .await
            .map_err(|e| Error::Inference(format!("OpenAI-compatible STT request failed: {e}")))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| Error::Inference(format!("OpenAI-compatible STT response failed: {e}")))?;
        if !status.is_success() {
            return Err(Error::Inference(format!(
                "OpenAI-compatible STT returned HTTP {status}: {body}"
            )));
        }
        let value: Value = serde_json::from_str(&body).map_err(|e| {
            Error::Inference(format!("OpenAI-compatible STT returned invalid JSON: {e}"))
        })?;
        transcription_text_from_json(value, "OpenAI-compatible STT")
    }
}

/// Local Parakeet adapter that delegates to a configured executable.
///
/// This keeps NVIDIA NeMo / Transformers / PyTorch outside the Rust binary. The
/// executable is called as:
///
/// `command --audio <temp-wav> --model <model-id>`
///
/// It can print either plain text or JSON shaped like `{ "text": "..." }`.
#[derive(Clone, Debug)]
pub struct ParakeetCommandTranscriber {
    command: String,
    model: String,
}

impl ParakeetCommandTranscriber {
    pub fn new(command: impl AsRef<str>, model: impl AsRef<str>) -> Self {
        let model = model.as_ref().trim();
        Self {
            command: command.as_ref().trim().to_string(),
            model: if model.is_empty() {
                DEFAULT_PARAKEET_MODEL.to_string()
            } else {
                model.to_string()
            },
        }
    }
}

#[async_trait]
impl Transcriber for ParakeetCommandTranscriber {
    async fn transcribe(&self, input: TranscriptionInput) -> Result<TranscriptionOutput> {
        if self.command.is_empty() {
            return Err(Error::InvalidRequest(
                "Parakeet command is required".to_string(),
            ));
        }
        let path =
            std::env::temp_dir().join(format!("milim-parakeet-{}.wav", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, &input.audio)
            .await
            .map_err(|e| Error::Other(format!("failed to write Parakeet audio temp file: {e}")))?;

        let mut cmd = tokio::process::Command::new(&self.command);
        cmd.arg("--audio")
            .arg(&path)
            .arg("--model")
            .arg(&self.model);
        #[cfg(windows)]
        cmd.creation_flags(milim_core::proc::CREATE_NO_WINDOW);
        let output = cmd
            .output()
            .await
            .map_err(|e| Error::Inference(format!("failed to run Parakeet command: {e}")))?;
        let _ = tokio::fs::remove_file(&path).await;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(Error::Inference(format!(
                "Parakeet command exited with {}: {}",
                output.status, stderr
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Err(Error::Inference(
                "Parakeet command produced no transcript".to_string(),
            ));
        }
        if let Ok(value) = serde_json::from_str::<Value>(&stdout) {
            return transcription_text_from_json(value, "Parakeet command");
        }
        Ok(TranscriptionOutput { text: stdout })
    }
}

/// OpenAI-compatible `/audio/speech` backend.
///
/// The endpoint receives JSON with `model`, `input`, `voice`, `speed`, and
/// `response_format: "wav"`, and must return audio bytes.
#[derive(Clone, Debug)]
pub struct OpenAiAudioSpeechSynthesizer {
    endpoint: String,
    model: String,
    api_key: Option<String>,
    voice: String,
    speed: f32,
    client: reqwest::Client,
}

impl OpenAiAudioSpeechSynthesizer {
    pub fn new(
        endpoint: impl AsRef<str>,
        model: impl AsRef<str>,
        api_key: Option<String>,
        voice: impl AsRef<str>,
        speed: f32,
    ) -> Result<Self> {
        let model = model.as_ref().trim();
        if model.is_empty() {
            return Err(Error::InvalidRequest(
                "OpenAI-compatible TTS model is required".to_string(),
            ));
        }
        let voice = voice.as_ref().trim();
        Ok(Self {
            endpoint: validate_http_endpoint(endpoint.as_ref(), "OpenAI-compatible TTS")?,
            model: model.to_string(),
            api_key: api_key
                .map(|key| key.trim().to_string())
                .filter(|key| !key.is_empty()),
            voice: if voice.is_empty() {
                "alloy".to_string()
            } else {
                voice.to_string()
            },
            speed: if speed.is_finite() && speed > 0.0 {
                speed
            } else {
                1.0
            },
            client: reqwest::Client::new(),
        })
    }
}

#[async_trait]
impl Synthesizer for OpenAiAudioSpeechSynthesizer {
    async fn synthesize(&self, input: SpeechInput) -> Result<SpeechOutput> {
        let text = input.text.trim();
        if text.is_empty() {
            return Err(Error::InvalidRequest("TTS input is required".to_string()));
        }
        let voice = input
            .voice
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(&self.voice);
        let speed = input.speed.unwrap_or(self.speed);
        if !speed.is_finite() || speed <= 0.0 {
            return Err(Error::InvalidRequest(
                "TTS speed must be greater than 0".to_string(),
            ));
        }

        let mut req = self.client.post(&self.endpoint).json(&serde_json::json!({
            "model": self.model.as_str(),
            "input": text,
            "voice": voice,
            "speed": speed,
            "response_format": "wav",
        }));
        if let Some(key) = self.api_key.as_deref() {
            req = req.bearer_auth(key);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| Error::Inference(format!("OpenAI-compatible TTS request failed: {e}")))?;
        let status = resp.status();
        let mime_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .unwrap_or_else(|| "audio/wav".to_string());
        let body = resp
            .bytes()
            .await
            .map_err(|e| Error::Inference(format!("OpenAI-compatible TTS response failed: {e}")))?;
        if !status.is_success() {
            let text = String::from_utf8_lossy(&body).trim().to_string();
            return Err(Error::Inference(format!(
                "OpenAI-compatible TTS returned HTTP {status}: {text}"
            )));
        }
        if body.is_empty() {
            return Err(Error::Inference(
                "OpenAI-compatible TTS produced no audio".to_string(),
            ));
        }
        Ok(SpeechOutput {
            audio: body.to_vec(),
            mime_type,
        })
    }
}

/// Local TTS adapter that delegates to a configured executable.
///
/// The executable is called as:
///
/// `command --text <text> --voice <voice> --speed <speed>`
///
/// It must write audio bytes to stdout. The current HTTP layer labels those
/// bytes as `audio/wav`, so wrappers should emit WAV unless they expose their
/// own endpoint later.
#[derive(Clone, Debug)]
pub struct CommandSpeechSynthesizer {
    command: String,
    voice: String,
    speed: f32,
}

impl CommandSpeechSynthesizer {
    pub fn new(command: impl AsRef<str>, voice: impl AsRef<str>, speed: f32) -> Self {
        let voice = voice.as_ref().trim();
        Self {
            command: command.as_ref().trim().to_string(),
            voice: if voice.is_empty() {
                "alloy".to_string()
            } else {
                voice.to_string()
            },
            speed: if speed.is_finite() && speed > 0.0 {
                speed
            } else {
                1.0
            },
        }
    }
}

#[async_trait]
impl Synthesizer for CommandSpeechSynthesizer {
    async fn synthesize(&self, input: SpeechInput) -> Result<SpeechOutput> {
        if self.command.is_empty() {
            return Err(Error::InvalidRequest("TTS command is required".to_string()));
        }
        let text = input.text.trim();
        if text.is_empty() {
            return Err(Error::InvalidRequest("TTS input is required".to_string()));
        }
        let voice = input
            .voice
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(&self.voice);
        let speed = input.speed.unwrap_or(self.speed);
        if !speed.is_finite() || speed <= 0.0 {
            return Err(Error::InvalidRequest(
                "TTS speed must be greater than 0".to_string(),
            ));
        }

        let mut cmd = tokio::process::Command::new(&self.command);
        cmd.arg("--text")
            .arg(text)
            .arg("--voice")
            .arg(voice)
            .arg("--speed")
            .arg(speed.to_string());
        #[cfg(windows)]
        cmd.creation_flags(milim_core::proc::CREATE_NO_WINDOW);
        let output = cmd
            .output()
            .await
            .map_err(|e| Error::Inference(format!("failed to run TTS command: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(Error::Inference(format!(
                "TTS command exited with {}: {}",
                output.status, stderr
            )));
        }
        if output.stdout.is_empty() {
            return Err(Error::Inference(
                "TTS command produced no audio".to_string(),
            ));
        }
        Ok(SpeechOutput {
            audio: output.stdout,
            mime_type: "audio/wav".to_string(),
        })
    }
}

/// Local Piper adapter that delegates to a configured Piper executable.
///
/// The executable is called as:
///
/// `piper --model <model-path> --output_file <temp-wav> --speaker <voice> --length_scale <scale>`
///
/// Text is written to stdin. Piper uses lower `length_scale` values for faster
/// speech, so milim converts `speed` to `1 / speed`.
#[derive(Clone, Debug)]
pub struct PiperSpeechSynthesizer {
    command: String,
    model_path: String,
    voice: String,
    speed: f32,
}

impl PiperSpeechSynthesizer {
    pub fn new(
        command: impl AsRef<str>,
        model_path: impl AsRef<str>,
        voice: impl AsRef<str>,
        speed: f32,
    ) -> Self {
        let voice = voice.as_ref().trim();
        Self {
            command: command.as_ref().trim().to_string(),
            model_path: model_path.as_ref().trim().to_string(),
            voice: if voice.is_empty() {
                "0".to_string()
            } else {
                voice.to_string()
            },
            speed: if speed.is_finite() && speed > 0.0 {
                speed
            } else {
                1.0
            },
        }
    }
}

#[async_trait]
impl Synthesizer for PiperSpeechSynthesizer {
    async fn synthesize(&self, input: SpeechInput) -> Result<SpeechOutput> {
        if self.command.is_empty() {
            return Err(Error::InvalidRequest(
                "Piper command is required".to_string(),
            ));
        }
        if self.model_path.is_empty() {
            return Err(Error::InvalidRequest(
                "Piper model path is required".to_string(),
            ));
        }
        let text = input.text.trim();
        if text.is_empty() {
            return Err(Error::InvalidRequest("TTS input is required".to_string()));
        }
        let voice = input
            .voice
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(&self.voice);
        let speed = input.speed.unwrap_or(self.speed);
        if !speed.is_finite() || speed <= 0.0 {
            return Err(Error::InvalidRequest(
                "TTS speed must be greater than 0".to_string(),
            ));
        }
        let length_scale = (1.0 / speed).clamp(0.25, 4.0);
        let path = std::env::temp_dir().join(format!("milim-piper-{}.wav", uuid::Uuid::new_v4()));

        let mut cmd = tokio::process::Command::new(&self.command);
        cmd.arg("--model")
            .arg(&self.model_path)
            .arg("--output_file")
            .arg(&path)
            .arg("--speaker")
            .arg(voice)
            .arg("--length_scale")
            .arg(length_scale.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(milim_core::proc::CREATE_NO_WINDOW);
        let mut child = cmd
            .spawn()
            .map_err(|e| Error::Inference(format!("failed to run Piper command: {e}")))?;

        let Some(mut stdin) = child.stdin.take() else {
            return Err(Error::Inference(
                "failed to open Piper command stdin".to_string(),
            ));
        };
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| Error::Inference(format!("failed to write Piper stdin: {e}")))?;
        drop(stdin);

        let output = child
            .wait_with_output()
            .await
            .map_err(|e| Error::Inference(format!("failed to wait for Piper command: {e}")))?;

        if !output.status.success() {
            let _ = tokio::fs::remove_file(&path).await;
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(Error::Inference(format!(
                "Piper command exited with {}: {}",
                output.status, stderr
            )));
        }

        let audio = tokio::fs::read(&path)
            .await
            .map_err(|e| Error::Inference(format!("failed to read Piper output audio: {e}")))?;
        let _ = tokio::fs::remove_file(&path).await;
        if audio.is_empty() {
            return Err(Error::Inference(
                "Piper command produced no audio".to_string(),
            ));
        }
        Ok(SpeechOutput {
            audio,
            mime_type: "audio/wav".to_string(),
        })
    }
}

#[cfg(any(test, feature = "native-tts"))]
#[derive(Debug, Deserialize)]
struct NativePiperRawAudioConfig {
    #[serde(default)]
    sample_rate: Option<u32>,
}

#[cfg(any(test, feature = "native-tts"))]
#[derive(Debug, Deserialize)]
struct NativePiperRawInferenceConfig {
    #[serde(default)]
    noise_scale: Option<f32>,
    #[serde(default)]
    length_scale: Option<f32>,
    #[serde(default)]
    noise_w: Option<f32>,
}

#[cfg(any(test, feature = "native-tts"))]
#[derive(Debug, Deserialize)]
struct NativePiperRawEspeakConfig {
    #[serde(default)]
    voice: Option<String>,
}

#[cfg(any(test, feature = "native-tts"))]
#[derive(Debug, Deserialize)]
struct NativePiperRawVoiceConfig {
    #[serde(default)]
    audio: Option<NativePiperRawAudioConfig>,
    #[serde(default)]
    inference: Option<NativePiperRawInferenceConfig>,
    #[serde(default)]
    espeak: Option<NativePiperRawEspeakConfig>,
    #[serde(default)]
    num_speakers: Option<u32>,
    #[serde(default)]
    phoneme_type: Option<String>,
    phoneme_id_map: HashMap<String, Vec<i64>>,
    #[serde(default)]
    speaker_id_map: HashMap<String, i64>,
}

#[cfg(any(test, feature = "native-tts"))]
#[cfg_attr(not(feature = "native-tts"), allow(dead_code))]
#[derive(Clone, Debug)]
struct NativePiperVoiceConfig {
    sample_rate: u32,
    noise_scale: f32,
    length_scale: f32,
    noise_w: f32,
    num_speakers: u32,
    phoneme_type: String,
    #[cfg_attr(not(feature = "native-tts-espeak"), allow(dead_code))]
    espeak_voice: Option<String>,
    phoneme_id_map: HashMap<char, Vec<i64>>,
    speaker_id_map: HashMap<String, i64>,
}

#[cfg(any(test, feature = "native-tts"))]
#[cfg_attr(not(feature = "native-tts"), allow(dead_code))]
impl NativePiperVoiceConfig {
    fn from_json_str(config: &str) -> Result<Self> {
        let raw: NativePiperRawVoiceConfig = serde_json::from_str(config)
            .map_err(|e| Error::InvalidRequest(format!("invalid native Piper config JSON: {e}")))?;
        if raw.phoneme_id_map.is_empty() {
            return Err(Error::InvalidRequest(
                "native Piper config is missing phoneme_id_map".to_string(),
            ));
        }

        let mut phoneme_id_map = HashMap::new();
        for (key, value) in raw.phoneme_id_map {
            let mut chars = key.chars();
            let Some(ch) = chars.next() else {
                return Err(Error::InvalidRequest(
                    "native Piper config contains an empty phoneme key".to_string(),
                ));
            };
            if chars.next().is_some() {
                return Err(Error::InvalidRequest(format!(
                    "native Piper phoneme key must be one codepoint: {key}"
                )));
            }
            if value.is_empty() {
                return Err(Error::InvalidRequest(format!(
                    "native Piper phoneme key has no ids: {key}"
                )));
            }
            phoneme_id_map.insert(ch, value);
        }

        let inference = raw.inference.unwrap_or(NativePiperRawInferenceConfig {
            noise_scale: None,
            length_scale: None,
            noise_w: None,
        });
        Ok(Self {
            sample_rate: raw
                .audio
                .and_then(|audio| audio.sample_rate)
                .unwrap_or(22_050),
            noise_scale: inference.noise_scale.unwrap_or(0.667),
            length_scale: inference.length_scale.unwrap_or(1.0),
            noise_w: inference.noise_w.unwrap_or(0.8),
            num_speakers: raw.num_speakers.unwrap_or(1),
            phoneme_type: raw.phoneme_type.unwrap_or_else(|| "espeak".to_string()),
            espeak_voice: raw
                .espeak
                .and_then(|espeak| espeak.voice)
                .map(|voice| voice.trim().to_string())
                .filter(|voice| !voice.is_empty()),
            phoneme_id_map,
            speaker_id_map: raw.speaker_id_map,
        })
    }

    fn scales(&self, speed: f32) -> [f32; 3] {
        let speed = if speed.is_finite() && speed > 0.0 {
            speed
        } else {
            1.0
        };
        [
            self.noise_scale,
            (self.length_scale / speed).clamp(0.25, 4.0),
            self.noise_w,
        ]
    }

    fn phoneme_ids_for_text(&self, text: &str) -> Result<Vec<i64>> {
        let phonemes = match self.phoneme_type.trim() {
            "text" => self.text_phonemes(text)?,
            "espeak" => self.espeak_phonemes(text)?,
            other => {
                return Err(Error::InvalidRequest(format!(
                    "unsupported native Piper phoneme_type: {other}"
                )));
            }
        };
        self.phoneme_ids_for_phonemes(&phonemes)
    }

    fn text_phonemes(&self, text: &str) -> Result<Vec<char>> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::InvalidRequest("TTS input is required".to_string()));
        }
        Ok(text.chars().collect())
    }

    fn espeak_phonemes(&self, text: &str) -> Result<Vec<char>> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::InvalidRequest("TTS input is required".to_string()));
        }
        #[cfg(feature = "native-tts-espeak")]
        {
            let voice = self.espeak_voice.as_deref().unwrap_or("en");
            let data_dir = native_piper_espeak_data_dir()?;
            let engine = espeak_ng::EspeakNg::builder()
                .voice(voice)
                .data_dir(&data_dir)
                .build()
                .map_err(|e| {
                    Error::Inference(format!("native Piper eSpeak initialization failed: {e}"))
                })?;
            let ipa = engine.text_to_phonemes(text).map_err(|e| {
                Error::Inference(format!("native Piper eSpeak phonemization failed: {e}"))
            })?;
            return Ok(ipa.chars().collect());
        }
        #[cfg(not(feature = "native-tts-espeak"))]
        {
            Err(Error::InvalidRequest(
                "native Piper eSpeak voices require the native-tts-espeak feature".to_string(),
            ))
        }
    }

    fn phoneme_ids_for_phonemes(&self, phonemes: &[char]) -> Result<Vec<i64>> {
        let pad = self.required_ids('_')?;
        let bos = self.required_ids('^')?;
        let eos = self.required_ids('$')?;
        let mut ids = Vec::with_capacity(phonemes.len() * 2 + bos.len() + eos.len() + 1);
        ids.extend_from_slice(bos);
        for ch in phonemes {
            let Some(phoneme_ids) = self.phoneme_id_map.get(ch) else {
                continue;
            };
            ids.extend_from_slice(pad);
            ids.extend_from_slice(phoneme_ids);
        }
        ids.extend_from_slice(pad);
        ids.extend_from_slice(eos);
        Ok(ids)
    }

    fn speaker_id(&self, voice: &str) -> Option<i64> {
        if self.num_speakers <= 1 {
            return None;
        }
        if let Ok(id) = voice.trim().parse::<i64>() {
            return Some(id);
        }
        self.speaker_id_map.get(voice.trim()).copied().or(Some(0))
    }

    fn required_ids(&self, ch: char) -> Result<&[i64]> {
        self.phoneme_id_map
            .get(&ch)
            .map(Vec::as_slice)
            .ok_or_else(|| {
                Error::InvalidRequest(format!(
                    "native Piper config is missing required phoneme {ch:?}"
                ))
            })
    }
}

#[cfg(feature = "native-tts-espeak")]
fn native_piper_espeak_data_dir() -> Result<PathBuf> {
    static DATA_DIR: OnceLock<std::result::Result<PathBuf, String>> = OnceLock::new();
    let installed = DATA_DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join("milim-espeak-ng-en");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create eSpeak data dir {}: {e}", dir.display()))?;
        espeak_ng::install_bundled_language(&dir, "en").map_err(|e| {
            format!(
                "failed to install bundled English eSpeak data into {}: {e}",
                dir.display()
            )
        })?;
        Ok(dir)
    });
    installed.clone().map_err(Error::Inference)
}

#[cfg(any(test, feature = "native-tts"))]
const KOKORO_SAMPLE_RATE: u32 = 24_000;
#[cfg(any(test, feature = "native-tts"))]
const KOKORO_STYLE_DIM: usize = 256;
#[cfg(any(test, feature = "native-tts"))]
#[cfg_attr(not(feature = "native-tts-espeak"), allow(dead_code))]
const KOKORO_MAX_TEXT_TOKENS: usize = 510;

#[cfg(any(test, feature = "native-tts"))]
#[derive(Debug, Deserialize)]
struct NativeKokoroRawConfig {
    vocab: HashMap<String, i64>,
    #[serde(default)]
    sample_rate: Option<u32>,
}

#[cfg(any(test, feature = "native-tts"))]
#[cfg_attr(not(feature = "native-tts"), allow(dead_code))]
#[derive(Clone, Debug)]
struct NativeKokoroConfig {
    sample_rate: u32,
    #[cfg_attr(not(feature = "native-tts-espeak"), allow(dead_code))]
    vocab: HashMap<char, i64>,
}

#[cfg(any(test, feature = "native-tts"))]
#[cfg_attr(not(feature = "native-tts"), allow(dead_code))]
impl NativeKokoroConfig {
    fn from_json_str(config: &str) -> Result<Self> {
        let raw: NativeKokoroRawConfig = serde_json::from_str(config).map_err(|e| {
            Error::InvalidRequest(format!("invalid native Kokoro config JSON: {e}"))
        })?;
        if raw.vocab.is_empty() {
            return Err(Error::InvalidRequest(
                "native Kokoro config is missing vocab".to_string(),
            ));
        }

        let mut vocab = HashMap::new();
        for (key, id) in raw.vocab {
            let mut chars = key.chars();
            let Some(ch) = chars.next() else {
                return Err(Error::InvalidRequest(
                    "native Kokoro vocab contains an empty token".to_string(),
                ));
            };
            if chars.next().is_some() {
                return Err(Error::InvalidRequest(format!(
                    "native Kokoro vocab token must be one codepoint: {key}"
                )));
            }
            vocab.insert(ch, id);
        }

        Ok(Self {
            sample_rate: raw.sample_rate.unwrap_or(KOKORO_SAMPLE_RATE),
            vocab,
        })
    }

    fn canonical_voice_id(voice: &str) -> String {
        let voice = voice.trim();
        if voice.is_empty() {
            return "af_heart".to_string();
        }
        match voice {
            "alloy" | "aoede" | "bella" | "heart" | "jessica" | "kore" | "nicole" | "nova"
            | "river" | "sarah" | "sky" => format!("af_{voice}"),
            "adam" | "echo" | "eric" | "fenrir" | "liam" | "michael" | "onyx" | "puck"
            | "santa" => format!("am_{voice}"),
            _ => voice.to_string(),
        }
    }

    fn token_ids_for_text(&self, text: &str) -> Result<Vec<i64>> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::InvalidRequest("TTS input is required".to_string()));
        }
        #[cfg(feature = "native-tts-espeak")]
        {
            let data_dir = native_piper_espeak_data_dir()?;
            let engine = espeak_ng::EspeakNg::builder()
                .voice("en-us")
                .data_dir(&data_dir)
                .build()
                .map_err(|e| {
                    Error::Inference(format!("native Kokoro eSpeak initialization failed: {e}"))
                })?;
            let ipa = engine.text_to_phonemes(text).map_err(|e| {
                Error::Inference(format!("native Kokoro eSpeak phonemization failed: {e}"))
            })?;
            return self.token_ids_for_phonemes(&ipa.chars().collect::<Vec<_>>());
        }
        #[cfg(not(feature = "native-tts-espeak"))]
        {
            Err(Error::InvalidRequest(
                "native Kokoro text tokenization requires the native-tts-espeak feature"
                    .to_string(),
            ))
        }
    }

    #[cfg_attr(not(feature = "native-tts-espeak"), allow(dead_code))]
    fn token_ids_for_phonemes(&self, phonemes: &[char]) -> Result<Vec<i64>> {
        let mut ids = Vec::with_capacity(phonemes.len());
        for ch in phonemes {
            if let Some(id) = self.vocab.get(ch) {
                ids.push(*id);
            }
        }
        if ids.is_empty() {
            return Err(Error::InvalidRequest(
                "native Kokoro phonemization produced no mapped tokens".to_string(),
            ));
        }
        if ids.len() > KOKORO_MAX_TEXT_TOKENS {
            return Err(Error::InvalidRequest(format!(
                "native Kokoro input is too long: {} tokens, max {KOKORO_MAX_TEXT_TOKENS}",
                ids.len()
            )));
        }
        Ok(ids)
    }
}

#[cfg(any(test, feature = "native-tts"))]
fn native_kokoro_config_path(model_path: &Path, config_path: Option<&str>) -> Result<PathBuf> {
    if let Some(config_path) = config_path.map(str::trim).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(config_path));
    }
    if model_path.as_os_str().is_empty() {
        return Err(Error::InvalidRequest(
            "Native TTS model path is required".to_string(),
        ));
    }
    let Some(parent) = model_path.parent() else {
        return Ok(PathBuf::from("config.json"));
    };
    if parent
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("onnx"))
    {
        if let Some(root) = parent.parent() {
            return Ok(root.join("config.json"));
        }
    }
    Ok(parent.join("config.json"))
}

#[cfg(any(test, feature = "native-tts"))]
fn native_kokoro_voice_path(config_path: &Path, voice: &str) -> Result<PathBuf> {
    let trimmed = voice.trim();
    let direct = PathBuf::from(trimmed);
    if !trimmed.is_empty()
        && (direct.components().count() > 1
            || direct.extension().and_then(|ext| ext.to_str()) == Some("bin"))
    {
        if direct.is_file() {
            return Ok(direct);
        }
        return Err(Error::InvalidRequest(format!(
            "native Kokoro voice style file was not found: {}",
            direct.display()
        )));
    }

    let voice_id = NativeKokoroConfig::canonical_voice_id(trimmed);
    let base = config_path.parent().unwrap_or_else(|| Path::new(""));
    let path = base.join("voices").join(format!("{voice_id}.bin"));
    if !path.is_file() {
        return Err(Error::InvalidRequest(format!(
            "native Kokoro voice style file was not found: {}",
            path.display()
        )));
    }
    Ok(path)
}

#[cfg(any(test, feature = "native-tts"))]
fn native_kokoro_style_for_token_len(style_path: &Path, token_len: usize) -> Result<Vec<f32>> {
    let bytes = std::fs::read(style_path).map_err(|e| {
        Error::InvalidRequest(format!(
            "native Kokoro voice style file could not be read: {} ({e})",
            style_path.display()
        ))
    })?;
    let row_bytes = KOKORO_STYLE_DIM * std::mem::size_of::<f32>();
    if bytes.len() < row_bytes || bytes.len() % row_bytes != 0 {
        return Err(Error::InvalidRequest(format!(
            "native Kokoro voice style file has invalid size: {}",
            style_path.display()
        )));
    }
    let rows = bytes.len() / row_bytes;
    if token_len >= rows {
        return Err(Error::InvalidRequest(format!(
            "native Kokoro voice style file has {rows} style rows but needs row {token_len}: {}",
            style_path.display()
        )));
    }
    let start = token_len * row_bytes;
    let row = &bytes[start..start + row_bytes];
    Ok(row
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

#[cfg(feature = "native-tts")]
fn load_native_kokoro_config(
    model_path: &Path,
    config_path: Option<&str>,
) -> Result<(PathBuf, NativeKokoroConfig)> {
    let config_path = native_kokoro_config_path(model_path, config_path)?;
    let config = std::fs::read_to_string(&config_path).map_err(|e| {
        Error::InvalidRequest(format!(
            "native Kokoro config was not found or could not be read: {} ({e})",
            config_path.display()
        ))
    })?;
    Ok((config_path, NativeKokoroConfig::from_json_str(&config)?))
}

/// Native Kokoro ONNX adapter backed by ONNX Runtime.
///
/// The official ONNX export uses `input_ids`, a length-indexed style vector
/// from `voices/<voice>.bin`, and a one-value `speed` tensor.
#[cfg(feature = "native-tts")]
#[derive(Clone, Debug)]
pub struct NativeKokoroSpeechSynthesizer {
    model_path: PathBuf,
    config_path: PathBuf,
    config: NativeKokoroConfig,
    voice: String,
    speed: f32,
}

#[cfg(feature = "native-tts")]
impl NativeKokoroSpeechSynthesizer {
    pub fn new(
        model_path: impl AsRef<Path>,
        config_path: Option<&str>,
        voice: impl AsRef<str>,
        speed: f32,
    ) -> Result<Self> {
        let model_path = model_path.as_ref();
        if !model_path.is_file() {
            return Err(Error::InvalidRequest(format!(
                "Native TTS model path was not found: {}",
                model_path.display()
            )));
        }
        let (resolved_config_path, config) = load_native_kokoro_config(model_path, config_path)?;
        let voice = NativeKokoroConfig::canonical_voice_id(voice.as_ref());
        let _ = native_kokoro_voice_path(&resolved_config_path, &voice)?;
        Ok(Self {
            model_path: model_path.to_path_buf(),
            config_path: resolved_config_path,
            config,
            voice,
            speed: if speed.is_finite() && speed > 0.0 {
                speed
            } else {
                1.0
            },
        })
    }
}

#[cfg(feature = "native-tts")]
#[async_trait]
impl Synthesizer for NativeKokoroSpeechSynthesizer {
    async fn synthesize(&self, input: SpeechInput) -> Result<SpeechOutput> {
        let text = input.text.trim().to_string();
        if text.is_empty() {
            return Err(Error::InvalidRequest("TTS input is required".to_string()));
        }
        let voice = input
            .voice
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(NativeKokoroConfig::canonical_voice_id)
            .unwrap_or_else(|| self.voice.clone());
        let speed = input.speed.unwrap_or(self.speed);
        let model_path = self.model_path.clone();
        let config_path = self.config_path.clone();
        let config = self.config.clone();

        tokio::task::spawn_blocking(move || {
            let voice_path = native_kokoro_voice_path(&config_path, &voice)?;
            synthesize_native_kokoro_blocking(
                &model_path,
                &config_path,
                &voice_path,
                config,
                &text,
                speed,
            )
        })
        .await
        .map_err(|e| Error::Other(format!("native Kokoro synthesis task failed: {e}")))?
    }
}

#[cfg(feature = "native-tts")]
fn synthesize_native_kokoro_blocking(
    model_path: &Path,
    config_path: &Path,
    voice_path: &Path,
    config: NativeKokoroConfig,
    text: &str,
    speed: f32,
) -> Result<SpeechOutput> {
    use ort::{inputs, session::Session, value::Tensor};

    let token_ids = config.token_ids_for_text(text)?;
    let style = native_kokoro_style_for_token_len(voice_path, token_ids.len())?;
    let mut input_ids = Vec::with_capacity(token_ids.len() + 2);
    input_ids.push(0);
    input_ids.extend(token_ids);
    input_ids.push(0);
    let speed = if speed.is_finite() && speed > 0.0 {
        speed
    } else {
        1.0
    };

    let input_ids_len = input_ids.len();
    let input_ids = Tensor::from_array(([1usize, input_ids_len], input_ids)).map_err(|e| {
        Error::Inference(format!(
            "failed to create native Kokoro input_ids tensor: {e}"
        ))
    })?;
    let style = Tensor::from_array(([1usize, KOKORO_STYLE_DIM], style)).map_err(|e| {
        Error::Inference(format!("failed to create native Kokoro style tensor: {e}"))
    })?;
    let speed = Tensor::from_array(([1usize], vec![speed])).map_err(|e| {
        Error::Inference(format!("failed to create native Kokoro speed tensor: {e}"))
    })?;
    let mut session = Session::builder()
        .map_err(|e| Error::Inference(format!("failed to create native Kokoro ORT session: {e}")))?
        .commit_from_file(model_path)
        .map_err(|e| {
            Error::Inference(format!(
                "failed to load native Kokoro ONNX model {} with config {}: {e}",
                model_path.display(),
                config_path.display()
            ))
        })?;

    let outputs = session
        .run(inputs! {
            "input_ids" => input_ids,
            "style" => style,
            "speed" => speed,
        })
        .map_err(|e| Error::Inference(format!("native Kokoro inference failed: {e}")))?;
    if outputs.len() == 0 {
        return Err(Error::Inference(
            "native Kokoro produced no output tensor".to_string(),
        ));
    }
    let output = outputs
        .get("waveform")
        .or_else(|| outputs.get("output"))
        .unwrap_or(&outputs[0]);
    let (_shape, samples) = output
        .try_extract_tensor::<f32>()
        .map_err(|e| Error::Inference(format!("native Kokoro output was not float audio: {e}")))?;
    if samples.is_empty() {
        return Err(Error::Inference(
            "native Kokoro produced no audio".to_string(),
        ));
    }
    Ok(SpeechOutput {
        audio: native_piper_wav_from_samples(config.sample_rate, samples)?,
        mime_type: "audio/wav".to_string(),
    })
}

#[cfg(any(test, feature = "native-tts"))]
fn native_piper_config_path(model_path: &Path, config_path: Option<&str>) -> Result<PathBuf> {
    if let Some(config_path) = config_path.map(str::trim).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(config_path));
    }
    if model_path.as_os_str().is_empty() {
        return Err(Error::InvalidRequest(
            "Native TTS model path is required".to_string(),
        ));
    }
    let mut sidecar = OsString::from(model_path.as_os_str());
    sidecar.push(".json");
    Ok(PathBuf::from(sidecar))
}

#[cfg(any(test, feature = "native-tts"))]
fn native_piper_wav_from_samples(sample_rate: u32, samples: &[f32]) -> Result<Vec<u8>> {
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(
            &mut bytes,
            hound::WavSpec {
                channels: 1,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .map_err(|e| Error::Other(format!("failed to create native Piper WAV: {e}")))?;
        for sample in samples {
            let sample = if sample.is_finite() { *sample } else { 0.0 };
            let pcm = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            writer.write_sample(pcm).map_err(|e| {
                Error::Other(format!("failed to write native Piper WAV sample: {e}"))
            })?;
        }
        writer
            .finalize()
            .map_err(|e| Error::Other(format!("failed to finalize native Piper WAV: {e}")))?;
    }
    Ok(bytes.into_inner())
}

#[cfg(feature = "native-tts")]
fn load_native_piper_config(
    model_path: &Path,
    config_path: Option<&str>,
) -> Result<(PathBuf, NativePiperVoiceConfig)> {
    let config_path = native_piper_config_path(model_path, config_path)?;
    let config = std::fs::read_to_string(&config_path).map_err(|e| {
        Error::InvalidRequest(format!(
            "native Piper config was not found or could not be read: {} ({e})",
            config_path.display()
        ))
    })?;
    Ok((config_path, NativePiperVoiceConfig::from_json_str(&config)?))
}

/// Native Piper ONNX adapter backed by ONNX Runtime.
///
/// Supports Piper configs with `phoneme_type: "text"` behind `native-tts`.
/// English eSpeak-based Piper voices additionally require the separate
/// `native-tts-espeak` feature.
#[cfg(feature = "native-tts")]
#[derive(Clone, Debug)]
pub struct NativePiperSpeechSynthesizer {
    model_path: PathBuf,
    config_path: PathBuf,
    config: NativePiperVoiceConfig,
    voice: String,
    speed: f32,
}

#[cfg(feature = "native-tts")]
impl NativePiperSpeechSynthesizer {
    pub fn new(
        model_path: impl AsRef<Path>,
        config_path: Option<&str>,
        voice: impl AsRef<str>,
        speed: f32,
    ) -> Result<Self> {
        let model_path = model_path.as_ref();
        if !model_path.is_file() {
            return Err(Error::InvalidRequest(format!(
                "Native TTS model path was not found: {}",
                model_path.display()
            )));
        }
        let (resolved_config_path, config) = load_native_piper_config(model_path, config_path)?;
        let voice = voice.as_ref().trim();
        Ok(Self {
            model_path: model_path.to_path_buf(),
            config_path: resolved_config_path,
            config,
            voice: if voice.is_empty() {
                "0".to_string()
            } else {
                voice.to_string()
            },
            speed: if speed.is_finite() && speed > 0.0 {
                speed
            } else {
                1.0
            },
        })
    }
}

#[cfg(feature = "native-tts")]
#[async_trait]
impl Synthesizer for NativePiperSpeechSynthesizer {
    async fn synthesize(&self, input: SpeechInput) -> Result<SpeechOutput> {
        let text = input.text.trim().to_string();
        if text.is_empty() {
            return Err(Error::InvalidRequest("TTS input is required".to_string()));
        }
        let voice = input
            .voice
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(&self.voice)
            .to_string();
        let speed = input.speed.unwrap_or(self.speed);
        let model_path = self.model_path.clone();
        let config_path = self.config_path.clone();
        let config = self.config.clone();

        tokio::task::spawn_blocking(move || {
            synthesize_native_piper_blocking(
                &model_path,
                &config_path,
                config,
                &text,
                &voice,
                speed,
            )
        })
        .await
        .map_err(|e| Error::Other(format!("native Piper synthesis task failed: {e}")))?
    }
}

#[cfg(feature = "native-tts")]
fn synthesize_native_piper_blocking(
    model_path: &Path,
    config_path: &Path,
    config: NativePiperVoiceConfig,
    text: &str,
    voice: &str,
    speed: f32,
) -> Result<SpeechOutput> {
    use ort::{inputs, session::Session, value::Tensor};

    let phoneme_ids = config.phoneme_ids_for_text(text)?;
    let input_lengths = vec![phoneme_ids.len() as i64];
    let scales = config.scales(speed).to_vec();

    let input = Tensor::from_array(([1usize, phoneme_ids.len()], phoneme_ids)).map_err(|e| {
        Error::Inference(format!("failed to create native Piper input tensor: {e}"))
    })?;
    let input_lengths = Tensor::from_array(([1usize], input_lengths)).map_err(|e| {
        Error::Inference(format!(
            "failed to create native Piper input_lengths tensor: {e}"
        ))
    })?;
    let scales = Tensor::from_array(([3usize], scales)).map_err(|e| {
        Error::Inference(format!("failed to create native Piper scales tensor: {e}"))
    })?;
    let mut session = Session::builder()
        .map_err(|e| Error::Inference(format!("failed to create native Piper ORT session: {e}")))?
        .commit_from_file(model_path)
        .map_err(|e| {
            Error::Inference(format!(
                "failed to load native Piper ONNX model {} with config {}: {e}",
                model_path.display(),
                config_path.display()
            ))
        })?;

    let outputs = if let Some(speaker_id) = config.speaker_id(voice) {
        let sid = Tensor::from_array(([1usize], vec![speaker_id])).map_err(|e| {
            Error::Inference(format!("failed to create native Piper sid tensor: {e}"))
        })?;
        session.run(inputs! {
            "input" => input,
            "input_lengths" => input_lengths,
            "scales" => scales,
            "sid" => sid,
        })
    } else {
        session.run(inputs! {
            "input" => input,
            "input_lengths" => input_lengths,
            "scales" => scales,
        })
    }
    .map_err(|e| Error::Inference(format!("native Piper inference failed: {e}")))?;

    let output = outputs
        .get("output")
        .ok_or_else(|| Error::Inference("native Piper produced no output tensor".to_string()))?;
    let (_shape, samples) = output
        .try_extract_tensor::<f32>()
        .map_err(|e| Error::Inference(format!("native Piper output was not float audio: {e}")))?;
    if samples.is_empty() {
        return Err(Error::Inference(
            "native Piper produced no audio".to_string(),
        ));
    }
    Ok(SpeechOutput {
        audio: native_piper_wav_from_samples(config.sample_rate, samples)?,
        mime_type: "audio/wav".to_string(),
    })
}

/// Decode the desktop recorder's WAV format into Whisper-ready f32 samples.
///
/// The current desktop recorder emits 16 kHz mono signed 16-bit PCM WAV. Keep
/// this strict so malformed or unsupported audio fails at the boundary
/// instead of reaching the native model code.
pub fn decode_wav_16khz_mono_pcm(audio: &[u8]) -> Result<Vec<f32>> {
    let reader = hound::WavReader::new(std::io::Cursor::new(audio))
        .map_err(|e| Error::InvalidRequest(format!("invalid WAV audio: {e}")))?;
    let spec = reader.spec();
    if spec.sample_rate != 16_000 {
        return Err(Error::InvalidRequest(format!(
            "voice transcription requires 16 kHz WAV audio, got {} Hz",
            spec.sample_rate
        )));
    }
    if spec.channels != 1 {
        return Err(Error::InvalidRequest(format!(
            "voice transcription requires mono WAV audio, got {} channels",
            spec.channels
        )));
    }
    if spec.bits_per_sample != 16 || spec.sample_format != hound::SampleFormat::Int {
        return Err(Error::InvalidRequest(format!(
            "voice transcription requires 16-bit PCM WAV audio, got {}-bit {:?}",
            spec.bits_per_sample, spec.sample_format
        )));
    }

    reader
        .into_samples::<i16>()
        .map(|sample| {
            sample
                .map(|s| f32::from(s) / 32768.0)
                .map_err(|e| Error::InvalidRequest(format!("invalid WAV sample: {e}")))
        })
        .collect()
}

/// Lightweight local VAD based on whole-clip RMS energy.
///
/// This is intentionally small and dependency-free. It is useful for local
/// preflight checks and gives the server a stable VAD contract before heavier
/// Silero/ORT streaming models are plugged in.
#[derive(Clone, Debug)]
pub struct EnergyVoiceActivityDetector {
    threshold: f32,
}

impl Default for EnergyVoiceActivityDetector {
    fn default() -> Self {
        Self {
            threshold: DEFAULT_ENERGY_VAD_THRESHOLD,
        }
    }
}

impl EnergyVoiceActivityDetector {
    pub fn new(threshold: f32) -> Result<Self> {
        if !threshold.is_finite() || threshold <= 0.0 {
            return Err(Error::InvalidRequest(
                "VAD threshold must be a positive finite number".to_string(),
            ));
        }
        Ok(Self { threshold })
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }
}

#[async_trait]
impl VoiceActivityDetector for EnergyVoiceActivityDetector {
    async fn detect(&self, input: VoiceActivityInput) -> Result<VoiceActivityOutput> {
        let samples = decode_wav_16khz_mono_pcm(&input.audio)?;
        if samples.is_empty() {
            return Ok(VoiceActivityOutput {
                is_speech: false,
                speech_probability: 0.0,
            });
        }

        let sum_squares = samples.iter().fold(0.0f64, |acc, sample| {
            acc + f64::from(*sample) * f64::from(*sample)
        });
        let rms = (sum_squares / samples.len() as f64).sqrt() as f32;
        let speech_probability = (rms / self.threshold).clamp(0.0, 1.0);
        Ok(VoiceActivityOutput {
            is_speech: rms >= self.threshold,
            speech_probability,
        })
    }
}

/// Local voice activity detector backed by the Silero VAD ONNX model.
#[cfg(feature = "native-vad")]
#[derive(Clone, Debug)]
pub struct NativeSileroVoiceActivityDetector {
    model_path: PathBuf,
    threshold: f32,
}

#[cfg(feature = "native-vad")]
impl NativeSileroVoiceActivityDetector {
    pub fn new(path: impl AsRef<Path>) -> Result<Self> {
        Self::with_threshold(path, DEFAULT_SILERO_VAD_THRESHOLD)
    }

    pub fn with_threshold(path: impl AsRef<Path>, threshold: f32) -> Result<Self> {
        let path = path.as_ref();
        if path.as_os_str().is_empty() {
            return Err(Error::InvalidRequest(
                "Native VAD model path is required".to_string(),
            ));
        }
        if !path.is_file() {
            return Err(Error::InvalidRequest(format!(
                "Native VAD model path was not found: {}",
                path.display()
            )));
        }
        if !threshold.is_finite() || threshold <= 0.0 || threshold >= 1.0 {
            return Err(Error::InvalidRequest(
                "Native VAD threshold must be greater than 0 and less than 1".to_string(),
            ));
        }
        Ok(Self {
            model_path: path.to_path_buf(),
            threshold,
        })
    }

    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }
}

#[cfg(feature = "native-vad")]
#[async_trait]
impl VoiceActivityDetector for NativeSileroVoiceActivityDetector {
    async fn detect(&self, input: VoiceActivityInput) -> Result<VoiceActivityOutput> {
        let model_path = self.model_path.clone();
        let threshold = self.threshold;
        tokio::task::spawn_blocking(move || {
            detect_native_silero_vad_blocking(&model_path, threshold, &input.audio)
        })
        .await
        .map_err(|e| Error::Other(format!("native Silero VAD task failed: {e}")))?
    }
}

#[cfg(any(test, feature = "native-vad"))]
fn silero_vad_padded_len(samples_len: usize) -> usize {
    if samples_len == 0 {
        return 0;
    }
    samples_len.div_ceil(SILERO_VAD_CHUNK_SAMPLES) * SILERO_VAD_CHUNK_SAMPLES
}

#[cfg(any(test, feature = "native-vad"))]
fn silero_vad_input_window(
    context: &[f32],
    chunk: &[f32],
    include_context: bool,
) -> Result<Vec<f32>> {
    if chunk.len() != SILERO_VAD_CHUNK_SAMPLES {
        return Err(Error::InvalidRequest(format!(
            "native Silero VAD chunk must contain {SILERO_VAD_CHUNK_SAMPLES} samples, got {}",
            chunk.len()
        )));
    }
    if !include_context {
        return Ok(chunk.to_vec());
    }
    if context.len() != SILERO_VAD_CONTEXT_SAMPLES {
        return Err(Error::InvalidRequest(format!(
            "native Silero VAD context must contain {SILERO_VAD_CONTEXT_SAMPLES} samples, got {}",
            context.len()
        )));
    }
    let mut input = Vec::with_capacity(SILERO_VAD_CONTEXT_SAMPLES + SILERO_VAD_CHUNK_SAMPLES);
    input.extend_from_slice(context);
    input.extend_from_slice(chunk);
    Ok(input)
}

#[cfg(feature = "native-vad")]
fn detect_native_silero_vad_blocking(
    model_path: &Path,
    threshold: f32,
    audio: &[u8],
) -> Result<VoiceActivityOutput> {
    use ort::{inputs, session::Session, value::Tensor};

    let mut samples = decode_wav_16khz_mono_pcm(audio)?;
    if samples.is_empty() {
        return Ok(VoiceActivityOutput {
            is_speech: false,
            speech_probability: 0.0,
        });
    }

    let padded_len = silero_vad_padded_len(samples.len());
    samples.resize(padded_len, 0.0);

    let mut session = Session::builder()
        .map_err(|e| Error::Inference(format!("failed to create native Silero VAD session: {e}")))?
        .commit_from_file(model_path)
        .map_err(|e| {
            Error::Inference(format!(
                "failed to load native Silero VAD ONNX model {}: {e}",
                model_path.display()
            ))
        })?;
    let include_context = silero_vad_session_uses_context(&session);

    let mut state = vec![0.0f32; SILERO_VAD_STATE_SAMPLES];
    let mut context = vec![0.0f32; SILERO_VAD_CONTEXT_SAMPLES];
    let mut max_probability = 0.0f32;

    for chunk in samples.chunks_exact(SILERO_VAD_CHUNK_SAMPLES) {
        let input_samples = silero_vad_input_window(&context, chunk, include_context)?;
        let input =
            Tensor::from_array(([1usize, input_samples.len()], input_samples)).map_err(|e| {
                Error::Inference(format!(
                    "failed to create native Silero VAD input tensor: {e}"
                ))
            })?;
        let state_tensor =
            Tensor::from_array(([2usize, 1usize, 128usize], state)).map_err(|e| {
                Error::Inference(format!(
                    "failed to create native Silero VAD state tensor: {e}"
                ))
            })?;
        let sr =
            Tensor::from_array(((), vec![i64::from(SILERO_VAD_SAMPLE_RATE)])).map_err(|e| {
                Error::Inference(format!(
                    "failed to create native Silero VAD sample-rate tensor: {e}"
                ))
            })?;

        let outputs = session
            .run(inputs! {
                "input" => input,
                "state" => state_tensor,
                "sr" => sr,
            })
            .map_err(|e| Error::Inference(format!("native Silero VAD inference failed: {e}")))?;
        if outputs.len() == 0 {
            return Err(Error::Inference(
                "native Silero VAD produced no outputs".to_string(),
            ));
        }

        let probability = silero_vad_probability_from_outputs(&outputs)?;
        max_probability = max_probability.max(probability);
        state = silero_vad_state_from_outputs(&outputs)?;
        context.copy_from_slice(&chunk[SILERO_VAD_CHUNK_SAMPLES - SILERO_VAD_CONTEXT_SAMPLES..]);
    }

    Ok(VoiceActivityOutput {
        is_speech: max_probability >= threshold,
        speech_probability: max_probability.clamp(0.0, 1.0),
    })
}

#[cfg(feature = "native-vad")]
fn silero_vad_session_uses_context(session: &ort::session::Session) -> bool {
    let input = session
        .inputs()
        .iter()
        .find(|input| input.name() == "input")
        .or_else(|| session.inputs().first());
    let Some(input) = input else {
        return true;
    };
    let Some(shape) = input.dtype().tensor_shape() else {
        return true;
    };
    match shape.last().copied() {
        Some(dim) if dim == SILERO_VAD_CHUNK_SAMPLES as i64 => false,
        Some(dim) if dim == (SILERO_VAD_CONTEXT_SAMPLES + SILERO_VAD_CHUNK_SAMPLES) as i64 => true,
        _ => true,
    }
}

#[cfg(feature = "native-vad")]
fn silero_vad_probability_from_outputs(outputs: &ort::session::SessionOutputs<'_>) -> Result<f32> {
    let output = outputs
        .get("output")
        .or_else(|| outputs.get("prob"))
        .or_else(|| outputs.get("speech_probs"))
        .unwrap_or(&outputs[0]);
    let (_shape, values) = output.try_extract_tensor::<f32>().map_err(|e| {
        Error::Inference(format!(
            "native Silero VAD probability output was not float: {e}"
        ))
    })?;
    values.first().copied().ok_or_else(|| {
        Error::Inference("native Silero VAD probability output was empty".to_string())
    })
}

#[cfg(feature = "native-vad")]
fn silero_vad_state_from_outputs(outputs: &ort::session::SessionOutputs<'_>) -> Result<Vec<f32>> {
    if outputs.len() < 2
        && outputs.get("stateN").is_none()
        && outputs.get("state").is_none()
        && outputs.get("hn").is_none()
    {
        return Err(Error::Inference(
            "native Silero VAD produced no recurrent state output".to_string(),
        ));
    }
    let output = outputs
        .get("stateN")
        .or_else(|| outputs.get("state"))
        .or_else(|| outputs.get("hn"))
        .unwrap_or(&outputs[1]);
    let (_shape, values) = output.try_extract_tensor::<f32>().map_err(|e| {
        Error::Inference(format!("native Silero VAD state output was not float: {e}"))
    })?;
    if values.len() != SILERO_VAD_STATE_SAMPLES {
        return Err(Error::Inference(format!(
            "native Silero VAD state output had {} samples, expected {SILERO_VAD_STATE_SAMPLES}",
            values.len()
        )));
    }
    Ok(values.to_vec())
}

/// Local speech-to-text backend backed by whisper.cpp through `whisper-rs`.
#[cfg(feature = "whisper")]
#[derive(Clone)]
pub struct WhisperTranscriber {
    ctx: Arc<WhisperContext>,
    model_path: Arc<PathBuf>,
}

#[cfg(feature = "whisper")]
impl std::fmt::Debug for WhisperTranscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WhisperTranscriber")
            .field("model_path", &self.model_path)
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "whisper")]
impl WhisperTranscriber {
    /// Load a whisper.cpp GGML model file.
    pub fn from_model_file(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(Error::ModelNotFound(format!(
                "Whisper model {}",
                path.display()
            )));
        }
        let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
            .map_err(|e| Error::Inference(format!("failed to load Whisper model: {e}")))?;
        Ok(Self {
            ctx: Arc::new(ctx),
            model_path: Arc::new(path.to_path_buf()),
        })
    }

    /// Build a transcriber from an environment variable if it is set.
    pub fn from_env_var(name: &str) -> Result<Option<Self>> {
        let Some(path) = std::env::var_os(name).filter(|v| !v.is_empty()) else {
            return Ok(None);
        };
        Self::from_model_file(PathBuf::from(path)).map(Some)
    }

    /// Build a transcriber from [`MILIM_WHISPER_MODEL_ENV`] if it is set.
    pub fn from_default_env() -> Result<Option<Self>> {
        Self::from_env_var(MILIM_WHISPER_MODEL_ENV)
    }
}

#[cfg(feature = "whisper")]
#[async_trait]
impl Transcriber for WhisperTranscriber {
    async fn transcribe(&self, input: TranscriptionInput) -> Result<TranscriptionOutput> {
        let ctx = Arc::clone(&self.ctx);
        tokio::task::spawn_blocking(move || transcribe_with_whisper(ctx, input.audio))
            .await
            .map_err(|e| Error::Other(format!("whisper transcription task failed: {e}")))?
    }
}

#[cfg(feature = "whisper")]
fn transcribe_with_whisper(
    ctx: Arc<WhisperContext>,
    audio: Vec<u8>,
) -> Result<TranscriptionOutput> {
    let audio = decode_wav_16khz_mono_pcm(&audio)?;
    let mut state = ctx
        .create_state()
        .map_err(|e| Error::Inference(format!("failed to create Whisper state: {e}")))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_no_timestamps(true);
    state
        .full(params, &audio)
        .map_err(|e| Error::Inference(format!("Whisper transcription failed: {e}")))?;
    let text = state
        .as_iter()
        .map(|segment| segment.to_string())
        .collect::<String>()
        .trim()
        .to_string();
    Ok(TranscriptionOutput { text })
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::PathBuf;

    use super::*;

    fn wav(sample_rate: u32, samples: &[i16]) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(
                &mut bytes,
                hound::WavSpec {
                    channels: 1,
                    sample_rate,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            for sample in samples {
                writer.write_sample(*sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        bytes.into_inner()
    }

    #[test]
    fn decodes_desktop_wav_format_to_float_samples() {
        let audio = decode_wav_16khz_mono_pcm(&wav(16_000, &[-32768, 0, 32767])).unwrap();

        assert_eq!(audio.len(), 3);
        assert!((audio[0] + 1.0).abs() < 0.0001);
        assert_eq!(audio[1], 0.0);
        assert!((audio[2] - 0.9999695).abs() < 0.0001);
    }

    #[test]
    fn rejects_non_16khz_wav() {
        let err = decode_wav_16khz_mono_pcm(&wav(44_100, &[0]))
            .expect_err("44.1 kHz audio must be rejected");

        assert!(err.to_string().contains("16 kHz"));
    }

    #[tokio::test]
    async fn energy_vad_marks_silence_as_not_speech() {
        let detector = EnergyVoiceActivityDetector::default();

        let out = detector
            .detect(VoiceActivityInput {
                audio: wav(16_000, &[0; 1600]),
                mime_type: Some("audio/wav".to_string()),
            })
            .await
            .unwrap();

        assert!(!out.is_speech);
        assert_eq!(out.speech_probability, 0.0);
    }

    #[tokio::test]
    async fn energy_vad_marks_loud_audio_as_speech() {
        let detector = EnergyVoiceActivityDetector::new(0.01).unwrap();

        let out = detector
            .detect(VoiceActivityInput {
                audio: wav(16_000, &[12000; 1600]),
                mime_type: Some("audio/wav".to_string()),
            })
            .await
            .unwrap();

        assert!(out.is_speech);
        assert_eq!(out.speech_probability, 1.0);
    }

    #[test]
    fn energy_vad_rejects_invalid_thresholds() {
        let err =
            EnergyVoiceActivityDetector::new(0.0).expect_err("zero threshold must be rejected");

        assert!(err.to_string().contains("threshold"));
    }

    #[test]
    fn native_silero_vad_pads_to_512_sample_windows() {
        assert_eq!(silero_vad_padded_len(0), 0);
        assert_eq!(silero_vad_padded_len(1), SILERO_VAD_CHUNK_SAMPLES);
        assert_eq!(
            silero_vad_padded_len(SILERO_VAD_CHUNK_SAMPLES),
            SILERO_VAD_CHUNK_SAMPLES
        );
        assert_eq!(
            silero_vad_padded_len(SILERO_VAD_CHUNK_SAMPLES + 1),
            SILERO_VAD_CHUNK_SAMPLES * 2
        );
    }

    #[test]
    fn native_silero_vad_builds_context_input_window() {
        let context = vec![1.0; SILERO_VAD_CONTEXT_SAMPLES];
        let chunk = vec![2.0; SILERO_VAD_CHUNK_SAMPLES];

        let input = silero_vad_input_window(&context, &chunk, true).unwrap();

        assert_eq!(
            input.len(),
            SILERO_VAD_CONTEXT_SAMPLES + SILERO_VAD_CHUNK_SAMPLES
        );
        assert!(input[..SILERO_VAD_CONTEXT_SAMPLES]
            .iter()
            .all(|sample| *sample == 1.0));
        assert!(input[SILERO_VAD_CONTEXT_SAMPLES..]
            .iter()
            .all(|sample| *sample == 2.0));
    }

    #[test]
    fn native_silero_vad_builds_plain_input_window() {
        let context = vec![1.0; SILERO_VAD_CONTEXT_SAMPLES];
        let chunk = vec![2.0; SILERO_VAD_CHUNK_SAMPLES];

        let input = silero_vad_input_window(&context, &chunk, false).unwrap();

        assert_eq!(input.len(), SILERO_VAD_CHUNK_SAMPLES);
        assert!(input.iter().all(|sample| *sample == 2.0));
    }

    #[test]
    fn native_silero_vad_rejects_invalid_input_window_shapes() {
        let context = vec![0.0; SILERO_VAD_CONTEXT_SAMPLES - 1];
        let chunk = vec![0.0; SILERO_VAD_CHUNK_SAMPLES];

        let err = silero_vad_input_window(&context, &chunk, true)
            .expect_err("short context must be rejected");

        assert!(err.to_string().contains("context"));
    }

    #[cfg(feature = "native-vad")]
    #[test]
    fn native_silero_vad_rejects_missing_model_file() {
        let missing =
            std::env::temp_dir().join(format!("missing-silero-{}.onnx", uuid::Uuid::new_v4()));

        let err = NativeSileroVoiceActivityDetector::new(&missing)
            .expect_err("missing native VAD model must be rejected");

        assert!(err
            .to_string()
            .contains("Native VAD model path was not found"));
    }

    #[tokio::test]
    async fn parakeet_command_transcriber_uses_command_stdout() {
        let command = fake_transcriber_command("parakeet transcript");
        let transcriber = ParakeetCommandTranscriber::new(
            command.to_string_lossy(),
            "nvidia/parakeet-tdt-0.6b-v2",
        );

        let out = transcriber
            .transcribe(TranscriptionInput {
                audio: wav(16_000, &[0, 1, 2]),
                mime_type: Some("audio/wav".to_string()),
            })
            .await
            .unwrap();

        assert_eq!(out.text, "parakeet transcript");
    }

    #[tokio::test]
    async fn command_speech_synthesizer_uses_command_stdout() {
        let command = fake_transcriber_command("RIFF-tts-wav");
        let synthesizer = CommandSpeechSynthesizer::new(command.to_string_lossy(), "alloy", 1.0);

        let out = synthesizer
            .synthesize(SpeechInput {
                text: "hello tts".to_string(),
                voice: Some("alloy".to_string()),
                speed: Some(1.0),
            })
            .await
            .unwrap();

        assert!(out.audio.starts_with(b"RIFF-tts-wav"));
        assert_eq!(out.mime_type, "audio/wav");
    }

    #[tokio::test]
    async fn piper_speech_synthesizer_reads_output_file() {
        let command = fake_piper_command("RIFF-piper-wav");
        let synthesizer =
            PiperSpeechSynthesizer::new(command.to_string_lossy(), "voice.onnx", "speaker-1", 1.0);

        let out = synthesizer
            .synthesize(SpeechInput {
                text: "hello piper".to_string(),
                voice: Some("speaker-1".to_string()),
                speed: Some(1.0),
            })
            .await
            .unwrap();

        assert!(out.audio.starts_with(b"RIFF-piper-wav"));
        assert_eq!(out.mime_type, "audio/wav");
    }

    #[test]
    fn validates_existing_voice_command() {
        let command = fake_transcriber_command("ok");
        let resolved = validate_voice_command(command.to_string_lossy()).unwrap();

        assert!(resolved.contains("milim-fake-parakeet"));
    }

    #[test]
    fn rejects_missing_voice_model_file() {
        let missing =
            std::env::temp_dir().join(format!("milim-missing-{}.onnx", uuid::Uuid::new_v4()));
        let err = validate_voice_model_file(missing.to_string_lossy(), "Piper model path")
            .expect_err("missing model must fail");

        assert!(err.to_string().contains("Piper model path"));
    }

    #[test]
    fn native_piper_config_path_uses_model_sidecar_by_default() {
        let model_path = PathBuf::from("C:/voices/test-voice.onnx");
        let resolved = native_piper_config_path(&model_path, None).unwrap();

        assert_eq!(resolved, PathBuf::from("C:/voices/test-voice.onnx.json"));
    }

    #[test]
    fn native_piper_text_config_converts_codepoints_to_ids() {
        let config = NativePiperVoiceConfig::from_json_str(
            r#"{
                "audio": { "sample_rate": 22050 },
                "inference": { "noise_scale": 0.5, "length_scale": 1.25, "noise_w": 0.75 },
                "num_speakers": 1,
                "phoneme_type": "text",
                "phoneme_id_map": {
                    "_": [0],
                    "^": [1],
                    "$": [2],
                    "a": [10],
                    "b": [11]
                },
                "speaker_id_map": {}
            }"#,
        )
        .unwrap();

        assert_eq!(config.sample_rate, 22_050);
        assert_eq!(config.scales(2.0), [0.5, 0.625, 0.75]);
        assert_eq!(
            config.phoneme_ids_for_text("ab").unwrap(),
            vec![1, 0, 10, 0, 11, 0, 2]
        );
    }

    #[test]
    fn native_piper_rejects_espeak_config_until_phonemizer_exists() {
        let config = NativePiperVoiceConfig::from_json_str(
            r#"{
                "num_speakers": 1,
                "espeak": { "voice": "en-us" },
                "phoneme_type": "espeak",
                "phoneme_id_map": {
                    "_": [0],
                    "^": [1],
                    "$": [2]
                }
            }"#,
        )
        .unwrap();

        assert_eq!(config.espeak_voice.as_deref(), Some("en-us"));
        let err = config
            .phoneme_ids_for_text("hello")
            .expect_err("native Piper should reject eSpeak voices without feature");

        assert!(err.to_string().contains("native-tts-espeak"));
    }

    #[cfg(feature = "native-tts-espeak")]
    #[test]
    fn native_piper_espeak_config_converts_english_text_to_ids() {
        let config = NativePiperVoiceConfig::from_json_str(
            r#"{
                "num_speakers": 1,
                "espeak": { "voice": "en-us" },
                "phoneme_type": "espeak",
                "phoneme_id_map": {
                    "_": [0],
                    "^": [1],
                    "$": [2],
                    "h": [10],
                    "ɛ": [11],
                    "l": [12],
                    "ˈ": [13],
                    "o": [14],
                    "ʊ": [15]
                }
            }"#,
        )
        .unwrap();

        let ids = config.phoneme_ids_for_text("hello").unwrap();

        assert!(ids.starts_with(&[1]));
        assert!(ids.ends_with(&[0, 2]));
        assert!(ids.contains(&10), "expected h phoneme id from eSpeak IPA");
        assert!(ids.contains(&12), "expected l phoneme id from eSpeak IPA");
        assert!(
            ids.len() > 4,
            "expected eSpeak phonemization to add mapped phoneme ids"
        );
    }

    #[test]
    fn native_piper_wav_writer_converts_float_samples_to_pcm16() {
        let audio = native_piper_wav_from_samples(22_050, &[0.0, 1.0, -1.0]).unwrap();
        let mut reader = hound::WavReader::new(Cursor::new(audio)).unwrap();
        let spec = reader.spec();
        let samples: Vec<i16> = reader
            .samples::<i16>()
            .map(|sample| sample.unwrap())
            .collect();

        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, 22_050);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(samples[0], 0);
        assert!(samples[1] > 30_000);
        assert!(samples[2] < -30_000);
    }

    #[test]
    fn native_kokoro_config_path_uses_official_onnx_layout() {
        let model_path = PathBuf::from("C:/kokoro/onnx/model_q8f16.onnx");
        let resolved = native_kokoro_config_path(&model_path, None).unwrap();

        assert_eq!(resolved, PathBuf::from("C:/kokoro/config.json"));
    }

    #[test]
    fn native_kokoro_config_parses_vocab_and_maps_short_voice_names() {
        let config = NativeKokoroConfig::from_json_str(
            r#"{
                "vocab": {
                    " ": 16,
                    "h": 50,
                    "ə": 83,
                    "l": 54,
                    "o": 57
                }
            }"#,
        )
        .unwrap();

        assert_eq!(config.sample_rate, 24_000);
        assert_eq!(
            config.token_ids_for_phonemes(&['h', 'ə', 'l']).unwrap(),
            vec![50, 83, 54]
        );
        assert_eq!(NativeKokoroConfig::canonical_voice_id("alloy"), "af_alloy");
        assert_eq!(
            NativeKokoroConfig::canonical_voice_id("af_bella"),
            "af_bella"
        );
    }

    #[test]
    fn native_kokoro_resolves_voice_bin_from_config_sibling_directory() {
        let root = std::env::temp_dir().join(format!("milim-kokoro-{}", uuid::Uuid::new_v4()));
        let voices = root.join("voices");
        std::fs::create_dir_all(&voices).unwrap();
        let voice_path = voices.join("af_alloy.bin");
        std::fs::write(&voice_path, vec![0_u8; KOKORO_STYLE_DIM * 4 * 2]).unwrap();

        let resolved =
            native_kokoro_voice_path(&root.join("config.json"), "alloy").expect("voice path");
        let style = native_kokoro_style_for_token_len(&resolved, 1).expect("style vector");

        let _ = std::fs::remove_dir_all(root);
        assert_eq!(resolved, voice_path);
        assert_eq!(style.len(), KOKORO_STYLE_DIM);
    }

    #[test]
    fn native_kokoro_tokenization_requires_espeak_feature_without_phonemizer() {
        let config = NativeKokoroConfig::from_json_str(
            r#"{
                "vocab": {
                    " ": 16,
                    "h": 50
                }
            }"#,
        )
        .unwrap();

        let err = config
            .token_ids_for_text("hello")
            .expect_err("Kokoro text tokenization needs a phonemizer");

        assert!(err.to_string().contains("native-tts-espeak"));
    }

    #[cfg(feature = "native-tts")]
    #[tokio::test]
    async fn native_kokoro_synthesizer_reports_phonemizer_feature_before_ort() {
        let root = std::env::temp_dir().join(format!("milim-kokoro-{}", uuid::Uuid::new_v4()));
        let onnx = root.join("onnx");
        let voices = root.join("voices");
        std::fs::create_dir_all(&onnx).unwrap();
        std::fs::create_dir_all(&voices).unwrap();
        let model_path = onnx.join("model.onnx");
        let config_path = root.join("config.json");
        std::fs::write(&model_path, b"fake onnx").unwrap();
        std::fs::write(
            &config_path,
            r#"{
                "vocab": {
                    " ": 16,
                    "h": 50
                }
            }"#,
        )
        .unwrap();
        std::fs::write(
            voices.join("af_alloy.bin"),
            vec![0_u8; KOKORO_STYLE_DIM * 4 * 2],
        )
        .unwrap();

        let synthesizer =
            NativeKokoroSpeechSynthesizer::new(&model_path, None, "alloy", 1.0).unwrap();
        let err = synthesizer
            .synthesize(SpeechInput {
                text: "hello".to_string(),
                voice: Some("alloy".to_string()),
                speed: Some(1.0),
            })
            .await
            .expect_err("Kokoro should fail at phonemizer gate before ORT");

        let _ = std::fs::remove_dir_all(root);
        assert!(err.to_string().contains("native-tts-espeak"));
    }

    #[cfg(feature = "native-tts-espeak")]
    #[test]
    fn native_kokoro_espeak_tokenization_maps_english_text() {
        let config = NativeKokoroConfig::from_json_str(
            r#"{
                "vocab": {
                    " ": 16,
                    "h": 50,
                    "ə": 83,
                    "l": 54,
                    "o": 57,
                    "ʊ": 135,
                    "ˈ": 156
                }
            }"#,
        )
        .unwrap();

        let ids = config.token_ids_for_text("hello").unwrap();

        assert!(ids.contains(&50), "expected h token from eSpeak IPA");
        assert!(ids.contains(&54), "expected l token from eSpeak IPA");
    }

    fn fake_transcriber_command(output: &str) -> PathBuf {
        let dir = std::env::temp_dir();
        #[cfg(windows)]
        {
            let path = dir.join(format!("milim-fake-parakeet-{}.cmd", uuid::Uuid::new_v4()));
            std::fs::write(&path, format!("@echo {output}\r\n")).unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;

            let path = dir.join(format!("milim-fake-parakeet-{}", uuid::Uuid::new_v4()));
            std::fs::write(&path, format!("#!/bin/sh\necho {output}\n")).unwrap();
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).unwrap();
            path
        }
    }

    fn fake_piper_command(output: &str) -> PathBuf {
        let dir = std::env::temp_dir();
        #[cfg(windows)]
        {
            let path = dir.join(format!("milim-fake-piper-{}.cmd", uuid::Uuid::new_v4()));
            std::fs::write(
                &path,
                format!(
                    "@echo off\r\nset out=\r\n:loop\r\nif \"%1\"==\"\" goto done\r\nif \"%1\"==\"--output_file\" (\r\n  set out=%2\r\n  shift\r\n)\r\nshift\r\ngoto loop\r\n:done\r\nmore > nul\r\necho {output}> \"%out%\"\r\n"
                ),
            )
            .unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;

            let path = dir.join(format!("milim-fake-piper-{}", uuid::Uuid::new_v4()));
            std::fs::write(
                &path,
                format!(
                    "#!/bin/sh\nout=\"\"\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--output_file\" ]; then\n    out=\"$2\"\n    shift\n  fi\n  shift\ndone\ncat > /dev/null\nprintf '{output}' > \"$out\"\n"
                ),
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).unwrap();
            path
        }
    }

    #[cfg(feature = "whisper")]
    #[test]
    fn whisper_backend_reports_missing_model_file() {
        let err = WhisperTranscriber::from_model_file("missing-whisper-model.bin")
            .expect_err("missing model path must fail");

        assert!(err.to_string().contains("missing-whisper-model.bin"));
    }

    #[cfg(feature = "whisper")]
    #[test]
    fn whisper_backend_ignores_missing_env_var() {
        let name = "MILIM_TEST_MISSING_WHISPER_MODEL";
        std::env::remove_var(name);

        assert!(WhisperTranscriber::from_env_var(name).unwrap().is_none());
    }
}
