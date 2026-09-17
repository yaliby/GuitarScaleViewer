use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    ProcessLoopback,
    EndpointLoopback,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct AudioChunk {
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub frame_count: usize,
    pub timestamp_ms: u64,
    pub samples_mono_f32: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowAnalysisResult {
    pub profile_type: String,
    pub key: String,
    pub scale: String,
    pub display_name: String,
    pub strength: f32,
    pub first_to_second_relative_strength: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<WindowKeyCandidate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tuning_cents: Option<f32>,
    pub window_start_ms: u64,
    pub window_end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowKeyCandidate {
    pub key: String,
    pub scale: String,
    pub score: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCandidate {
    pub key: String,
    pub scale: String,
    pub display_name: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedKeyPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_identity: Option<String>,
    pub primary_key: Option<String>,
    pub primary_scale: Option<String>,
    pub display_name: Option<String>,
    pub confidence: f32,
    pub stability: f32,
    pub alternatives: Vec<KeyCandidate>,
    pub source: String,
    pub capture_mode: CaptureMode,
    pub target_app: Option<String>,
    pub enough_audio: bool,
    pub buffer_seconds: f32,
    pub window_count: usize,
    pub ambiguous: bool,
    pub reason: Option<String>,
    pub state: String,
    pub ready_to_apply: bool,
}

impl DetectedKeyPayload {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            evidence_id: None,
            track_identity: None,
            primary_key: None,
            primary_scale: None,
            display_name: None,
            confidence: 0.0,
            stability: 0.0,
            alternatives: Vec::new(),
            source: "audio_analysis".to_string(),
            capture_mode: CaptureMode::Unavailable,
            target_app: None,
            enough_audio: false,
            buffer_seconds: 0.0,
            window_count: 0,
            ambiguous: true,
            reason: Some(reason.into()),
            state: "unavailable".to_string(),
            ready_to_apply: false,
        }
    }

    pub fn warming_up(capture_mode: CaptureMode, target_app: Option<String>, reason: &str) -> Self {
        Self {
            evidence_id: None,
            track_identity: None,
            primary_key: None,
            primary_scale: None,
            display_name: None,
            confidence: 0.0,
            stability: 0.0,
            alternatives: Vec::new(),
            source: "audio_analysis".to_string(),
            capture_mode,
            target_app,
            enough_audio: false,
            buffer_seconds: 0.0,
            window_count: 0,
            ambiguous: true,
            reason: Some(reason.to_string()),
            state: "warming_up".to_string(),
            ready_to_apply: false,
        }
    }
}
