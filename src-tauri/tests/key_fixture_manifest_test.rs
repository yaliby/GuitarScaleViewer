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
    for fixture in fixtures {
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
    let required = [
        "easy_stable_major",
        "easy_stable_minor",
        "contradiction_prone",
        "dominant_bias_failure_case",
        "relative_major_minor_ambiguity",
        "relative_ground_truth_minor_center",
    ];
    for cls in required {
        assert!(classes.contains(cls), "missing required fixture class: {cls}");
    }
}
