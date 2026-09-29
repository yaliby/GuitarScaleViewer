//! Live tempo from what the capture hears: no model, no second process, no extra audio copy.
//!
//! Every 10 ms of the 44.1 kHz capture becomes one onset-strength value: the log-mel spectral
//! flux, which rises wherever something is struck. The last twelve seconds of that envelope are
//! autocorrelated; the lag it repeats at, reinforced by its own double (a real beat repeats at two
//! beats as well) and weighed by where people count songs, is the tempo. Readings are integrated
//! over time so one busy fill cannot move the number, and a comb laid over the last few seconds
//! says where the beats fall, so the deck can pulse on them.
//!
//! The whole-song analysis of a saved copy uses Beat This! instead, which is far better at bars
//! and at which octave a tempo lives in; this is what Live Jam has before, or without, one.

use serde::Serialize;
use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Envelope frames per second (a 10 ms hop).
pub const FRAME_RATE: usize = 100;
const FRAME: usize = 2048;
const BANDS: usize = 40;
const LOW_HZ: f32 = 30.0;
const HIGH_HZ: f32 = 8_000.0;
/// Flux compares each frame with the one two hops back (20 ms): steadier than adjacent frames.
const FLUX_LAG: usize = 2;
const LOG_GAIN: f32 = 1_000.0;
const ENVELOPE_SECONDS: usize = 14;
const WINDOW_SECONDS: usize = 12;
/// No tempo is claimed from less music than this.
pub const MIN_SECONDS: f32 = 6.0;
pub const MIN_BPM: f32 = 50.0;
pub const MAX_BPM: f32 = 210.0;
/// Where people count a pop song: a log-normal prior, an octave wide.
const PRIOR_BPM: f32 = 110.0;
const PRIOR_OCTAVES: f32 = 1.0;
/// How much of the previous salience survives one update (about half a second).
const SALIENCE_MEMORY: f32 = 0.75;
/// Below this normalised autocorrelation at the beat lag there is no pulse worth showing.
const MIN_CLARITY: f32 = 0.08;
/// Readings in a row within `STABLE_BAND` of each other before the tempo is called steady.
const STABLE_READINGS: usize = 3;
const STABLE_BAND: f32 = 0.03;
/// The comb that finds the beat looks this far back.
const PHASE_SECONDS: f32 = 4.0;
/// Where a beat sits relative to the flux peak it causes: measured against annotated beats (see
/// `scripts/chord-research/README.md`), so the pulse lands on the beat rather than after it.
const PHASE_OFFSET_SECONDS: f32 = 0.0;

/// What Live Jam's deck shows. Serialized for `detected-tempo-update`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoReading {
    /// `idle` (nothing heard), `listening` (too little yet), `unsure`, or `steady`.
    pub state: &'static str,
    pub bpm: Option<f32>,
    /// 0..1: how clearly the music pulses at `bpm`.
    pub confidence: f32,
    /// Milliseconds since the Unix epoch at which the latest beat was heard, and the beat period.
    /// The deck extrapolates from these; both are absent when there is no steady beat to follow.
    pub last_beat_at_ms: Option<f64>,
    pub period_ms: Option<f32>,
    /// Seconds of music behind this reading.
    pub heard_seconds: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_identity: Option<String>,
}

impl TempoReading {
    pub fn idle() -> Self {
        Self {
            state: "idle",
            bpm: None,
            confidence: 0.0,
            last_beat_at_ms: None,
            period_ms: None,
            heard_seconds: 0.0,
            track_identity: None,
        }
    }
}

/// Radix-2 FFT of one fixed size, real input, magnitudes out.
struct Spectrum {
    size: usize,
    reverse: Vec<usize>,
    cos: Vec<f32>,
    sin: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
}

impl Spectrum {
    fn new(size: usize) -> Self {
        assert!(size.is_power_of_two());
        let bits = size.trailing_zeros();
        let reverse = (0..size)
            .map(|i| i.reverse_bits() >> (usize::BITS - bits))
            .collect();
        let angle = |k: usize| 2.0 * std::f64::consts::PI * k as f64 / size as f64;
        Self {
            size,
            reverse,
            cos: (0..size / 2).map(|k| angle(k).cos() as f32).collect(),
            sin: (0..size / 2).map(|k| angle(k).sin() as f32).collect(),
            re: vec![0.0; size],
            im: vec![0.0; size],
        }
    }

    /// |X[k]| for k in 0..=size/2 of the windowed frame.
    fn magnitudes(&mut self, frame: &[f32], window: &[f32], out: &mut [f32]) {
        let n = self.size;
        for i in 0..n {
            let j = self.reverse[i];
            self.re[j] = frame[i] * window[i];
            self.im[j] = 0.0;
        }
        let mut size = 2;
        while size <= n {
            let half = size / 2;
            let step = n / size;
            for start in (0..n).step_by(size) {
                for k in 0..half {
                    let (c, s) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + half);
                    // Twiddle e^{-2πik/size} = c - i s.
                    let tr = self.re[b] * c + self.im[b] * s;
                    let ti = self.im[b] * c - self.re[b] * s;
                    self.re[b] = self.re[a] - tr;
                    self.im[b] = self.im[a] - ti;
                    self.re[a] += tr;
                    self.im[a] += ti;
                }
            }
            size *= 2;
        }
        for (k, value) in out.iter_mut().enumerate().take(n / 2 + 1) {
            *value = (self.re[k] * self.re[k] + self.im[k] * self.im[k]).sqrt();
        }
    }
}

/// Triangular bands on the mel scale, each normalised to unit area.
fn mel_bands(sample_rate: f32) -> Vec<(usize, Vec<f32>)> {
    let mel = |hz: f32| 2595.0 * (1.0 + hz / 700.0).log10();
    let hz = |m: f32| 700.0 * (10f32.powf(m / 2595.0) - 1.0);
    let (low, high) = (mel(LOW_HZ), mel(HIGH_HZ.min(sample_rate / 2.0 - 1.0)));
    let edges: Vec<f32> = (0..BANDS + 2)
        .map(|i| hz(low + (high - low) * i as f32 / (BANDS + 1) as f32))
        .collect();
    let bin_hz = sample_rate / FRAME as f32;
    (0..BANDS)
        .map(|b| {
            let (left, centre, right) = (edges[b], edges[b + 1], edges[b + 2]);
            let first = (left / bin_hz).floor().max(0.0) as usize;
            let last = ((right / bin_hz).ceil() as usize).min(FRAME / 2);
            let mut weights: Vec<f32> = (first..=last)
                .map(|k| {
                    let f = k as f32 * bin_hz;
                    if f <= left || f >= right {
                        0.0
                    } else if f <= centre {
                        (f - left) / (centre - left)
                    } else {
                        (right - f) / (right - centre)
                    }
                })
                .collect();
            let sum: f32 = weights.iter().sum();
            if sum > 0.0 {
                weights.iter_mut().for_each(|w| *w /= sum);
            }
            (first, weights)
        })
        .collect()
}

/// The streaming onset envelope: 100 values a second of log-mel flux.
struct OnsetEnvelope {
    sample_rate: u32,
    hop: usize,
    window: Vec<f32>,
    bands: Vec<(usize, Vec<f32>)>,
    spectrum: Spectrum,
    magnitudes: Vec<f32>,
    pending: Vec<f32>,
    history: VecDeque<Vec<f32>>,
}

impl OnsetEnvelope {
    fn new(sample_rate: u32) -> Self {
        let window = (0..FRAME)
            .map(|n| {
                0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / FRAME as f64).cos() as f32
            })
            .collect();
        Self {
            sample_rate,
            hop: (sample_rate as usize / FRAME_RATE).max(1),
            window,
            bands: mel_bands(sample_rate as f32),
            spectrum: Spectrum::new(FRAME),
            magnitudes: vec![0.0; FRAME / 2 + 1],
            pending: Vec::with_capacity(FRAME * 2),
            history: VecDeque::with_capacity(FLUX_LAG + 1),
        }
    }

    fn reset(&mut self) {
        self.pending.clear();
        self.history.clear();
    }

    /// Feed samples; returns the envelope values of every frame they completed.
    fn push(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        self.pending.extend_from_slice(samples);
        let mut start = 0;
        while self.pending.len() - start >= FRAME {
            let frame = &self.pending[start..start + FRAME];
            self.spectrum
                .magnitudes(frame, &self.window, &mut self.magnitudes);
            let scale = 2.0 / FRAME as f32;
            let levels: Vec<f32> = self
                .bands
                .iter()
                .map(|(first, weights)| {
                    let energy: f32 = weights
                        .iter()
                        .enumerate()
                        .map(|(i, w)| w * self.magnitudes[first + i])
                        .sum();
                    (1.0 + LOG_GAIN * energy * scale).ln()
                })
                .collect();
            let flux = match self.history.front() {
                Some(reference) if self.history.len() == FLUX_LAG => {
                    // Against the loudest of each band's neighbours, so vibrato is not an onset.
                    let mut sum = 0.0;
                    for b in 0..BANDS {
                        let lo = b.saturating_sub(1);
                        let hi = (b + 1).min(BANDS - 1);
                        let prior = reference[lo..=hi].iter().cloned().fold(f32::MIN, f32::max);
                        sum += (levels[b] - prior).max(0.0);
                    }
                    sum / BANDS as f32
                }
                _ => 0.0,
            };
            if self.history.len() == FLUX_LAG {
                self.history.pop_front();
            }
            self.history.push_back(levels);
            out.push(flux);
            start += self.hop;
        }
        self.pending.drain(..start);
    }
}

/// One tempo reading from an envelope: lag salience, the chosen period and its clarity.
#[derive(Debug, Clone)]
pub struct Periodicity {
    /// Beat period in envelope frames (fractional).
    pub period: f32,
    /// Normalised autocorrelation at that period, 0..1.
    pub clarity: f32,
}

fn prior(bpm: f32) -> f32 {
    let octaves = (bpm / PRIOR_BPM).log2() / PRIOR_OCTAVES;
    (-0.5 * octaves * octaves).exp()
}

/// Mean removal against a half-second running average, then half-wave rectification: what is
/// left is the accents, which is what repeats at the beat.
pub fn accents(envelope: &[f32]) -> Vec<f32> {
    let n = envelope.len();
    let radius = FRAME_RATE / 4;
    let mut prefix = vec![0.0f64; n + 1];
    for (i, v) in envelope.iter().enumerate() {
        prefix[i + 1] = prefix[i] + *v as f64;
    }
    (0..n)
        .map(|i| {
            let lo = i.saturating_sub(radius);
            let hi = (i + radius + 1).min(n);
            let mean = (prefix[hi] - prefix[lo]) / (hi - lo) as f64;
            (envelope[i] as f64 - mean).max(0.0) as f32
        })
        .collect()
}

/// Normalised autocorrelation of `x` for lags 0..=max_lag.
pub fn autocorrelation(x: &[f32], max_lag: usize) -> Vec<f32> {
    let n = x.len();
    let mut out = vec![0.0f32; max_lag + 1];
    for (lag, value) in out.iter_mut().enumerate() {
        if lag >= n {
            break;
        }
        let mut sum = 0.0f64;
        for t in lag..n {
            sum += x[t] as f64 * x[t - lag] as f64;
        }
        *value = (sum / (n - lag) as f64) as f32;
    }
    let zero = out[0];
    if zero > 0.0 {
        out.iter_mut().for_each(|v| *v /= zero);
    }
    out
}

fn lag_of(bpm: f32) -> f32 {
    60.0 * FRAME_RATE as f32 / bpm
}

/// Salience of every candidate beat lag: the autocorrelation there plus half of it at twice the
/// lag, since a real beat also repeats a beat later.
pub fn salience(acf: &[f32]) -> Vec<f32> {
    let lo = lag_of(MAX_BPM).floor() as usize;
    let hi = lag_of(MIN_BPM).ceil() as usize;
    let mut out = vec![0.0f32; hi + 1];
    for (lag, value) in out.iter_mut().enumerate().skip(lo.max(1)) {
        let double = acf.get(2 * lag).copied().unwrap_or(0.0).max(0.0);
        *value = acf.get(lag).copied().unwrap_or(0.0).max(0.0) + 0.5 * double;
    }
    out
}

/// The best lag of a salience curve under the prior, with a nudge towards `previous`.
pub fn choose_period(salience: &[f32], acf: &[f32], previous: Option<f32>) -> Option<Periodicity> {
    let lo = lag_of(MAX_BPM).floor().max(2.0) as usize;
    let hi = (lag_of(MIN_BPM).ceil() as usize).min(salience.len().saturating_sub(2));
    let score = |lag: usize| {
        let bpm = 60.0 * FRAME_RATE as f32 / lag as f32;
        let mut s = salience[lag] * prior(bpm);
        if let Some(p) = previous {
            let d = (lag as f32 - p) / (0.03 * p);
            s *= 1.0 + 0.15 * (-0.5 * d * d).exp();
        }
        s
    };
    let best = (lo..=hi)
        .filter(|&l| salience[l] >= salience[l - 1] && salience[l] >= salience[l + 1])
        .max_by(|a, b| score(*a).total_cmp(&score(*b)))?;
    if salience[best] <= 0.0 {
        return None;
    }
    // Parabolic interpolation for a fractional period.
    let (a, b, c) = (salience[best - 1], salience[best], salience[best + 1]);
    let denom = a - 2.0 * b + c;
    let shift = if denom.abs() > 1e-9 {
        (0.5 * (a - c) / denom).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    Some(Periodicity {
        period: best as f32 + shift,
        clarity: acf.get(best).copied().unwrap_or(0.0).clamp(0.0, 1.0),
    })
}

/// Where, in frames back from the end of `x`, the latest beat of period `period` falls.
pub fn beat_phase(x: &[f32], period: f32) -> Option<f32> {
    let span = ((PHASE_SECONDS * FRAME_RATE as f32) as usize).min(x.len());
    if period < 2.0 || span < (2.0 * period) as usize {
        return None;
    }
    let end = x.len() as f32 - 1.0;
    let sample = |t: f32| -> f32 {
        if t < 0.0 {
            return 0.0;
        }
        let i = t.floor() as usize;
        let f = t - i as f32;
        let a = x.get(i).copied().unwrap_or(0.0);
        let b = x.get(i + 1).copied().unwrap_or(a);
        a + (b - a) * f
    };
    let steps = (period * 2.0).ceil() as usize;
    let mut best = (0.0f32, f32::MIN);
    for step in 0..steps {
        let back = step as f32 * 0.5;
        let mut score = 0.0;
        let mut weight = 1.0;
        let mut t = end - back;
        while t >= end - span as f32 {
            score += weight * sample(t);
            weight *= 0.8;
            t -= period;
        }
        if score > best.1 {
            best = (back, score);
        }
    }
    Some(best.0)
}

/// Where the capture's timeline meets the wall clock: this many samples had been fed when the
/// packet ending there was captured.
#[derive(Debug, Clone, Copy)]
struct Anchor {
    samples: u64,
    at: Instant,
}

pub struct TempoTracker {
    envelope: OnsetEnvelope,
    values: VecDeque<f32>,
    /// Envelope frames produced since the last reset.
    frames: u64,
    anchor: Option<Anchor>,
    fed: u64,
    salience: Vec<f32>,
    recent: VecDeque<f32>,
    /// The latest reading's period, kept for `pause`.
    last: Option<Periodicity>,
    held: Option<TempoReading>,
    scratch: Vec<f32>,
}

impl TempoTracker {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            envelope: OnsetEnvelope::new(sample_rate),
            values: VecDeque::with_capacity(ENVELOPE_SECONDS * FRAME_RATE),
            frames: 0,
            anchor: None,
            fed: 0,
            salience: Vec::new(),
            recent: VecDeque::with_capacity(STABLE_READINGS),
            last: None,
            held: None,
            scratch: Vec::with_capacity(64),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.envelope.sample_rate
    }

    /// Forget everything: a new track, a new capture.
    pub fn reset(&mut self) {
        self.envelope.reset();
        self.values.clear();
        self.frames = 0;
        self.anchor = None;
        self.fed = 0;
        self.salience.clear();
        self.recent.clear();
        self.last = None;
        self.held = None;
    }

    /// A pause of the same song: the envelope cannot run across the gap, but the tempo heard
    /// before it still stands, and is where the next reading starts from.
    pub fn pause(&mut self) {
        let held = match self.last.take() {
            Some(last) => self.read_at(Instant::now(), Some(&last)),
            None => self.read_at(Instant::now(), None),
        };
        self.envelope.reset();
        self.values.clear();
        self.frames = 0;
        self.anchor = None;
        self.fed = 0;
        self.recent.clear();
        if held.bpm.is_some() {
            self.held = Some(TempoReading {
                last_beat_at_ms: None,
                ..held
            });
        }
    }

    /// Feed mono samples at `sample_rate()`; `captured_at` is when the last of them was captured.
    pub fn push(&mut self, samples: &[f32], captured_at: Option<Instant>) {
        self.scratch.clear();
        self.envelope.push(samples, &mut self.scratch);
        self.fed += samples.len() as u64;
        for value in self.scratch.drain(..) {
            if self.values.len() == ENVELOPE_SECONDS * FRAME_RATE {
                self.values.pop_front();
            }
            self.values.push_back(value);
            self.frames += 1;
        }
        if let Some(at) = captured_at {
            self.anchor = Some(Anchor {
                samples: self.fed,
                at,
            });
        }
    }

    pub fn heard_seconds(&self) -> f32 {
        self.frames.min(self.values.len() as u64) as f32 / FRAME_RATE as f32
    }

    /// Update the integrated salience with the latest audio and read the tempo.
    pub fn update(&mut self) -> Option<Periodicity> {
        let window = (WINDOW_SECONDS * FRAME_RATE).min(self.values.len());
        if (window as f32) < MIN_SECONDS * FRAME_RATE as f32 {
            return None;
        }
        let tail: Vec<f32> = self.values.iter().skip(self.values.len() - window).copied().collect();
        let x = accents(&tail);
        let max_lag = 2 * lag_of(MIN_BPM).ceil() as usize + 2;
        let acf = autocorrelation(&x, max_lag);
        let now = salience(&acf);
        if self.salience.len() != now.len() {
            self.salience = now;
        } else {
            for (kept, fresh) in self.salience.iter_mut().zip(now) {
                *kept = SALIENCE_MEMORY * *kept + (1.0 - SALIENCE_MEMORY) * fresh;
            }
        }
        let previous = self
            .recent
            .back()
            .copied()
            .or_else(|| self.held.as_ref().and_then(|h| h.bpm).map(lag_of));
        let chosen = choose_period(&self.salience, &acf, previous)?;
        if self.recent.len() == STABLE_READINGS {
            self.recent.pop_front();
        }
        self.recent.push_back(chosen.period);
        self.last = Some(chosen.clone());
        Some(chosen)
    }

    fn stable(&self) -> bool {
        if self.recent.len() < STABLE_READINGS {
            return false;
        }
        let last = *self.recent.back().unwrap_or(&0.0);
        self.recent
            .iter()
            .all(|p| last > 0.0 && ((p - last) / last).abs() <= STABLE_BAND)
    }

    /// The reading as of `now`, after `update`.
    pub fn read_at(&self, now: Instant, chosen: Option<&Periodicity>) -> TempoReading {
        let heard = self.heard_seconds();
        let Some(chosen) = chosen else {
            if let Some(held) = &self.held {
                return TempoReading {
                    state: "listening",
                    heard_seconds: heard,
                    last_beat_at_ms: None,
                    ..held.clone()
                };
            }
            return TempoReading {
                state: if self.frames == 0 { "idle" } else { "listening" },
                heard_seconds: heard,
                ..TempoReading::idle()
            };
        };
        let bpm = 60.0 * FRAME_RATE as f32 / chosen.period;
        let steady = chosen.clarity >= MIN_CLARITY && self.stable();
        let period_ms = chosen.period * 1000.0 / FRAME_RATE as f32;
        let last_beat_at_ms = if steady {
            self.last_beat_epoch_ms(chosen.period, now)
        } else {
            None
        };
        TempoReading {
            state: if steady { "steady" } else { "unsure" },
            bpm: Some((bpm * 10.0).round() / 10.0),
            confidence: (chosen.clarity / 0.4).clamp(0.0, 1.0),
            last_beat_at_ms,
            period_ms: Some(period_ms),
            heard_seconds: heard,
            track_identity: None,
        }
    }

    fn last_beat_epoch_ms(&self, period: f32, now: Instant) -> Option<f64> {
        let anchor = self.anchor?;
        let span = ((PHASE_SECONDS * FRAME_RATE as f32) as usize).min(self.values.len());
        let tail: Vec<f32> = self.values.iter().skip(self.values.len() - span).copied().collect();
        let x = accents(&tail);
        let back = beat_phase(&x, period)?;
        // The last envelope frame is centred half a frame into its window.
        let rate = self.envelope.sample_rate as f64;
        let last_frame_centre = self.frames.saturating_sub(1) as f64 * self.envelope.hop as f64
            + FRAME as f64 / 2.0;
        let beat_sample = last_frame_centre - back as f64 * self.envelope.hop as f64
            - PHASE_OFFSET_SECONDS as f64 * rate;
        let before_anchor = Duration::from_secs_f64(((anchor.samples as f64 - beat_sample) / rate).max(0.0));
        let beat_instant = anchor.at.checked_sub(before_anchor)?;
        let since = now.saturating_duration_since(beat_instant);
        let epoch = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
        Some((epoch.as_secs_f64() - since.as_secs_f64()) * 1000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;

    /// A click track: short decaying noise bursts every beat, a softer one on every off-beat.
    fn clicks(bpm: f32, seconds: f32, offbeats: bool) -> Vec<f32> {
        let n = (seconds * RATE as f32) as usize;
        let period = 60.0 / bpm * RATE as f32;
        let mut out = vec![0.0f32; n];
        let mut seed = 12345u32;
        let mut noise = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        };
        let mut beat = 0.0f32;
        while (beat as usize) < n {
            for (gain, at) in [(0.8f32, beat), (0.3, beat + period / 2.0)] {
                if gain < 0.5 && !offbeats {
                    continue;
                }
                let start = at as usize;
                for i in 0..(RATE as usize / 25) {
                    if start + i < n {
                        out[start + i] += gain * noise() * (-(i as f32) / 300.0).exp();
                    }
                }
            }
            beat += period;
        }
        out
    }

    fn tempo_of(samples: &[f32]) -> Option<f32> {
        let mut tracker = TempoTracker::new(RATE);
        let mut chosen = None;
        for chunk in samples.chunks(RATE as usize / 2) {
            tracker.push(chunk, Some(Instant::now()));
            chosen = tracker.update().or(chosen);
        }
        chosen.map(|p| 60.0 * FRAME_RATE as f32 / p.period)
    }

    #[test]
    fn fft_matches_a_direct_dft() {
        let mut spectrum = Spectrum::new(64);
        let frame: Vec<f32> = (0..64).map(|i| ((i * 7 % 13) as f32 - 6.0) / 6.0).collect();
        let window = vec![1.0; 64];
        let mut out = vec![0.0; 33];
        spectrum.magnitudes(&frame, &window, &mut out);
        for (k, value) in out.iter().enumerate() {
            let (mut re, mut im) = (0.0f64, 0.0f64);
            for (n, x) in frame.iter().enumerate() {
                let a = -2.0 * std::f64::consts::PI * (k * n) as f64 / 64.0;
                re += *x as f64 * a.cos();
                im += *x as f64 * a.sin();
            }
            assert!((value - (re * re + im * im).sqrt() as f32).abs() < 1e-3, "bin {k}");
        }
    }

    #[test]
    fn mel_bands_cover_the_range_with_unit_area() {
        let bands = mel_bands(RATE as f32);
        assert_eq!(bands.len(), BANDS);
        for (first, weights) in &bands {
            assert!((weights.iter().sum::<f32>() - 1.0).abs() < 1e-4);
            assert!(*first * RATE as usize / FRAME < 8_100);
        }
    }

    #[test]
    fn a_click_track_reads_its_tempo() {
        for bpm in [72.0f32, 96.0, 120.0, 150.0] {
            let found = tempo_of(&clicks(bpm, 14.0, false)).expect("tempo");
            assert!((found - bpm).abs() / bpm < 0.02, "{bpm} BPM read as {found}");
        }
    }

    #[test]
    fn softer_off_beats_do_not_double_a_mid_tempo() {
        // 120 with eighths: 240 is out of range, and the beat outweighs its subdivision.
        let found = tempo_of(&clicks(120.0, 14.0, true)).expect("tempo");
        assert!((found - 120.0).abs() < 2.4, "read as {found}");
    }

    #[test]
    fn silence_has_no_tempo() {
        assert!(tempo_of(&vec![0.0; RATE as usize * 10]).is_none());
    }

    #[test]
    fn nothing_is_claimed_before_six_seconds() {
        let mut tracker = TempoTracker::new(RATE);
        tracker.push(&clicks(120.0, 5.0, true), Some(Instant::now()));
        assert!(tracker.update().is_none());
        assert_eq!(tracker.read_at(Instant::now(), None).state, "listening");
    }

    #[test]
    fn a_steady_beat_is_called_steady_and_phased_onto_the_clicks() {
        let bpm = 100.0;
        let audio = clicks(bpm, 12.0, false);
        let mut tracker = TempoTracker::new(RATE);
        let mut chosen = None;
        let start = Instant::now();
        let mut captured = start;
        for chunk in audio.chunks(4096) {
            captured += Duration::from_secs_f64(chunk.len() as f64 / RATE as f64);
            tracker.push(chunk, Some(captured));
            if tracker.values.len() % 50 == 0 {
                chosen = tracker.update().or(chosen);
            }
        }
        for _ in 0..STABLE_READINGS {
            chosen = tracker.update();
        }
        let reading = tracker.read_at(captured, chosen.as_ref());
        assert_eq!(reading.state, "steady");
        assert!((reading.bpm.unwrap() - bpm).abs() < 1.5);
        // Clicks fall on 0, 0.6, 1.2 s ...: the latest beat is a whole number of periods from 0.
        let epoch_now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
        let beat_audio_s = (reading.last_beat_at_ms.unwrap() - epoch_now) / 1000.0
            + captured.duration_since(start).as_secs_f64();
        let period = 60.0 / bpm as f64;
        let off = (beat_audio_s / period - (beat_audio_s / period).round()) * period;
        assert!(off.abs() < 0.035, "beat {beat_audio_s:.3}s is {off:.3}s off the grid");
    }

    #[test]
    fn a_pause_keeps_the_tempo_but_not_the_beat() {
        let mut tracker = TempoTracker::new(RATE);
        let mut chosen = None;
        for chunk in clicks(120.0, 12.0, true).chunks(RATE as usize / 2) {
            tracker.push(chunk, Some(Instant::now()));
            chosen = tracker.update().or(chosen);
        }
        assert!(chosen.is_some());
        tracker.pause();
        let held = tracker.read_at(Instant::now(), None);
        assert_eq!(held.state, "listening");
        assert!((held.bpm.unwrap() - 120.0).abs() < 2.5);
        assert!(held.last_beat_at_ms.is_none());
        tracker.reset();
        assert_eq!(tracker.read_at(Instant::now(), None).state, "idle");
    }
}
