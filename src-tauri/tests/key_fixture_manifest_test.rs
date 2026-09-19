use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureKey {
    key: String,
    scale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureSpec {
    id: String,
    r#class: String,
    path: String,
    expected_primary: FixtureKey,
    acceptable_alternatives: Vec<FixtureKey>,
    expected_ambiguous: bool,
    expected_not_ready: Option<bool>,
}

#[test]
fn fixture_manifest_is_well_formed() {
    let raw = std::fs::read_to_string("tests/key_fixtures_manifest.json")
        .expect("read tests/key_fixtures_manifest.json");
    let fixtures: Vec<FixtureSpec> =
        serde_json::from_str(&raw).expect("manifest should be valid json");
    assert!(!fixtures.is_empty());
    let mut classes = std::collections::BTreeSet::new();
    for fixture in &fixtures {
        assert!(!fixture.id.is_empty());
        assert!(!fixture.r#class.is_empty());
        classes.insert(fixture.r#class.clone());
        assert!(fixture.path.ends_with(".wav"));
        assert!(!fixture.expected_primary.key.is_empty());
        assert!(!fixture.expected_primary.scale.is_empty());
        assert!(fixture.expected_ambiguous || !fixture.acceptable_alternatives.is_empty());
        if let Some(not_ready) = fixture.expected_not_ready {
            if not_ready {
                assert!(fixture.expected_ambiguous || !fixture.acceptable_alternatives.is_empty());
            }
        }
    }
    // A fixture that shares another's audio is not a sixth test case, it is the same test run
    // twice under two names — and the manifest claimed six for exactly that reason until this
    // assertion existed. Relative-major-over-minor ground truth is now covered far better by
    // `key_accuracy_scoreboard.rs`, which runs all twelve minor keys through three progressions.
    let mut seen_paths = std::collections::HashSet::new();
    for fixture in &fixtures {
        assert!(
            seen_paths.insert(fixture.path.clone()),
            "fixture {} reuses another fixture's wav: {}",
            fixture.id,
            fixture.path
        );
    }

    let required = [
        "easy_stable_major",
        "easy_stable_minor",
        "contradiction_prone",
        "dominant_bias_failure_case",
        "relative_major_minor_ambiguity",
    ];
    for cls in required {
        assert!(
            classes.contains(cls),
            "missing required fixture class: {cls}"
        );
    }
}
