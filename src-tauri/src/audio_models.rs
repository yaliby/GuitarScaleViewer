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
    /// The profile's score gap between its top two candidates, **when those two are a relative
    /// major/minor pair** — and `None` when they are not, or when the analyzer sent no shortlist.
    ///
    /// This is the only evidence that answers "is the root a coin flip here", and it has to travel
    /// separately from `candidates` because the consensus layer cannot answer it. A relative pair
    /// is one pitch-class set with two names, so every window agreeing tells you nothing about
    /// which end is home; vote agreement is precisely the wrong evidence for this question.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_pair_gap: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tuning_cents: Option<f32>,
    /// How far the verdict's score stands above the best key with a *different* set of notes.
    ///
    /// The evidence behind `key_confidence`: over the real corpus it splits readings from 38% right
    /// to 87% right at twelve seconds of audio, where the gap to the plain runner-up — often the
    /// relative, which draws the same notes — says nothing about the notes at all. `None` when the
    /// analyzer sent no shortlist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_set_margin: Option<f32>,
    /// The profile's best score for this pass, which calibrates how much the margin is worth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_score: Option<f32>,
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

/// The evidence behind one reading, in the terms the neck's revision policy needs.
///
/// The run lengths are counted over the analyzer's readings, not over payloads: the engine emits a
/// payload whenever anything in it changes, several per reading, so a frontend counting repeats
/// would count the same audio more than once.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSetEvidence {
    /// The probability that the key's seven notes are the song's.
    pub confidence: f32,
    /// How many readings immediately before this one named the same seven notes (the key or its
    /// relative).
    pub note_set_run: u32,
    /// How many readings immediately before this one named this exact key.
    pub key_run: u32,
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
    /// What `key_confidence` read off the analyzer about `primary_key` — and `None` whenever the
    /// backend could not supply the evidence, or the newest reading named a different key.
    ///
    /// Separate from `confidence` because `confidence` has always meant whatever the backend's vote
    /// produced, and for the python sidecar it still does. A reader that needs a probability — the
    /// neck's revision policy in `keyFusion.ts` compares two of them — must be able to tell one
    /// from a vote share, and a flag on the side would be one more thing to keep in step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_set_evidence: Option<NoteSetEvidence>,
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
            note_set_evidence: None,
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
            note_set_evidence: None,
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
