//! `milim-privacy` - milim's local privacy filter.
//!
//! Detects common PII with deterministic regexes and redacts it to stable
//! `[KIND_N]` placeholders, with a reversible map so cloud replies can be
//! un-redacted on the way back.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

/// A category of detected PII.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectionKind {
    Email,
    Phone,
    Ssn,
    CreditCard,
    IpAddress,
    Url,
    AwsAccessKey,
    GithubToken,
}

impl DetectionKind {
    /// Placeholder label, e.g. `EMAIL`.
    fn label(self) -> &'static str {
        match self {
            DetectionKind::Email => "EMAIL",
            DetectionKind::Phone => "PHONE",
            DetectionKind::Ssn => "SSN",
            DetectionKind::CreditCard => "CREDIT_CARD",
            DetectionKind::IpAddress => "IP",
            DetectionKind::Url => "URL",
            DetectionKind::AwsAccessKey => "AWS_KEY",
            DetectionKind::GithubToken => "GITHUB_TOKEN",
        }
    }
}

/// One detected PII span.
#[derive(Debug, Clone, Serialize)]
pub struct Detection {
    pub kind: DetectionKind,
    pub value: String,
    pub start: usize,
    pub end: usize,
}

/// The reversible result of [`redact`].
#[derive(Debug, Clone, Serialize)]
pub struct Redaction {
    /// Text with PII replaced by `[KIND_N]` placeholders.
    pub text: String,
    /// placeholder → original value (for [`unredact`]).
    pub map: BTreeMap<String, String>,
}

// Detectors in priority order: earlier ones win when spans overlap. Specific,
// high-entropy patterns (keys/tokens, SSN, credit card) come before generic
// ones (phone/IP) so digit runs aren't mislabeled.
fn detectors() -> &'static [(DetectionKind, Regex)] {
    static DETECTORS: OnceLock<Vec<(DetectionKind, Regex)>> = OnceLock::new();
    DETECTORS.get_or_init(|| {
        vec![
            (
                DetectionKind::AwsAccessKey,
                Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap(),
            ),
            (
                DetectionKind::GithubToken,
                Regex::new(r"\bghp_[A-Za-z0-9]{36}\b").unwrap(),
            ),
            (
                DetectionKind::Email,
                Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").unwrap(),
            ),
            (
                DetectionKind::Url,
                Regex::new(r"https?://[^\s<>()]+").unwrap(),
            ),
            (
                DetectionKind::Ssn,
                Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").unwrap(),
            ),
            (
                DetectionKind::CreditCard,
                Regex::new(r"\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b").unwrap(),
            ),
            (
                DetectionKind::Phone,
                Regex::new(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b").unwrap(),
            ),
            (
                DetectionKind::IpAddress,
                Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap(),
            ),
        ]
    })
}

/// All non-overlapping PII detections in `text`, ordered by position.
pub fn scan(text: &str) -> Vec<Detection> {
    merge_detections(regex_scan(text))
}

fn regex_scan(text: &str) -> Vec<Detection> {
    let mut all: Vec<Detection> = Vec::new();
    for (kind, re) in detectors() {
        for m in re.find_iter(text) {
            all.push(Detection {
                kind: *kind,
                value: m.as_str().to_string(),
                start: m.start(),
                end: m.end(),
            });
        }
    }
    all
}

fn merge_detections(mut all: Vec<Detection>) -> Vec<Detection> {
    // Resolve overlaps: prefer earlier start, then longer span.
    all.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut chosen: Vec<Detection> = Vec::new();
    let mut cursor = 0usize;
    for d in all {
        if d.start >= cursor {
            cursor = d.end;
            chosen.push(d);
        }
    }
    chosen
}

/// True if `text` contains no detectable PII.
pub fn is_clean(text: &str) -> bool {
    scan(text).is_empty()
}

/// Replace PII with stable `[KIND_N]` placeholders (same value → same
/// placeholder), returning the reversible map.
pub fn redact(text: &str) -> Redaction {
    let mut r = Redactor::new();
    let out = r.redact(text);
    Redaction {
        text: out,
        map: r.map,
    }
}

/// Stateful redactor for redacting **multiple** texts consistently: the same
/// value maps to the same `[KIND_N]` placeholder across every [`Redactor::redact`]
/// call, accumulating one combined reversal map. Use this to redact a batch of
/// chat messages so a placeholder never means two different originals.
#[derive(Debug, Default)]
pub struct Redactor {
    value_to_ph: HashMap<(DetectionKind, String), String>,
    counters: HashMap<DetectionKind, usize>,
    map: BTreeMap<String, String>,
}

impl Redactor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Redact `text`, reusing/extending the shared placeholder map.
    pub fn redact(&mut self, text: &str) -> String {
        let dets = scan(text);
        for d in &dets {
            let key = (d.kind, d.value.clone());
            self.value_to_ph.entry(key).or_insert_with(|| {
                let n = self.counters.entry(d.kind).or_insert(0);
                *n += 1;
                let ph = format!("[{}_{}]", d.kind.label(), n);
                self.map.insert(ph.clone(), d.value.clone());
                ph
            });
        }
        // Replace from the end so earlier byte offsets stay valid.
        let mut out = text.to_string();
        for d in dets.iter().rev() {
            if let Some(ph) = self.value_to_ph.get(&(d.kind, d.value.clone())) {
                out.replace_range(d.start..d.end, ph);
            }
        }
        out
    }

    /// The accumulated placeholder → original map (for [`unredact`]).
    pub fn map(&self) -> &BTreeMap<String, String> {
        &self.map
    }

    /// Consume the redactor, yielding the accumulated reversal map.
    pub fn into_map(self) -> BTreeMap<String, String> {
        self.map
    }

    /// True if nothing has been redacted yet.
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// Reverse a [`redact`] by substituting originals back in.
pub fn unredact(text: &str, map: &BTreeMap<String, String>) -> String {
    let mut out = text.to_string();
    for (placeholder, original) in map {
        out = out.replace(placeholder, original);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_pii() {
        let aws_key = ["AKIA", "ABCDEFGHIJKLMNOP"].concat();
        let text = format!("Mail a@b.com, call 555-123-4567, SSN 123-45-6789, key {aws_key}.");
        let kinds: Vec<DetectionKind> = scan(&text).into_iter().map(|d| d.kind).collect();
        assert!(kinds.contains(&DetectionKind::Email));
        assert!(kinds.contains(&DetectionKind::Phone));
        assert!(kinds.contains(&DetectionKind::Ssn));
        assert!(kinds.contains(&DetectionKind::AwsAccessKey));
    }

    #[test]
    fn redact_unredact_round_trips() {
        let text = "Email a@b.com or a@b.com again; SSN 123-45-6789.";
        let r = redact(text);
        assert!(r.text.contains("[EMAIL_1]"));
        assert!(r.text.contains("[SSN_1]"));
        assert!(!r.text.contains("a@b.com"));
        // Same value reuses the same placeholder.
        assert_eq!(r.text.matches("[EMAIL_1]").count(), 2);
        assert_eq!(r.map["[EMAIL_1]"], "a@b.com");
        assert_eq!(unredact(&r.text, &r.map), text);
    }

    #[test]
    fn redactor_is_stable_across_texts() {
        // The same value gets the same placeholder across separate redact calls,
        // and distinct values get distinct placeholders (no cross-message collision).
        let mut r = Redactor::new();
        let a = r.redact("ping a@b.com");
        let b = r.redact("again a@b.com and c@d.com");
        assert_eq!(a, "ping [EMAIL_1]");
        assert_eq!(b, "again [EMAIL_1] and [EMAIL_2]");
        assert_eq!(r.map()["[EMAIL_1]"], "a@b.com");
        assert_eq!(r.map()["[EMAIL_2]"], "c@d.com");
    }

    #[test]
    fn clean_text_is_clean_and_failclosed() {
        assert!(is_clean("just a normal sentence with no secrets"));
        // Fail-closed: a redacted document must itself be clean.
        let r = redact("reach me at a@b.com");
        assert!(is_clean(&r.text), "redacted text still leaked PII");
    }
}
