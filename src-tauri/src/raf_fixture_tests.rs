//! Validation against private Fujifilm GFX100RF fixtures.
//!
//! Set `RAPIDRAW_RAF_FIXTURE_DIR` to a directory containing `raw/DSCF*.RAF`.
//! The files are never modified: every check runs on a temporary copy, and
//! the original sidecars are verified to be untouched. Without the variable
//! the tests skip.

use crate::{
    camera_defaults::{
        CameraDefaults, ImageSourceKind, camera_defaults_for_bytes, camera_defaults_for_path,
        first_edit_adjustments, first_edit_adjustments_for_path, persisted_render_adjustments,
    },
    file_management::camera_framed_thumbnail,
    image_processing::default_adjustments,
    render_source::SourceTransform,
};
use image::{DynamicImage, GenericImageView};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Clone, Copy)]
struct Case {
    stem: &'static str,
    /// Fujifilm Dynamic Range compensation in EV (DR200 = 1, DR400 = 2).
    ev: f32,
    /// Expected oriented camera crop `(x, y, width, height)`.
    crop: Option<(f64, f64, f64, f64)>,
    /// Camera JPEG dimensions recorded in the design evidence table.
    jpeg: (u32, u32),
    swaps_axes: bool,
}

const CASES: [Case; 5] = [
    Case {
        stem: "DSCF0420",
        ev: 1.0,
        crop: None,
        jpeg: (11648, 8736),
        swaps_axes: true,
    },
    Case {
        stem: "DSCF0581",
        ev: 1.0,
        crop: Some((0.0, 2217.0, 11648.0, 4301.0)),
        jpeg: (11648, 4304),
        swaps_axes: false,
    },
    Case {
        stem: "DSCF0434",
        ev: 2.0,
        crop: Some((1296.0, 2770.0, 9056.0, 3196.0)),
        jpeg: (9056, 3192),
        swaps_axes: false,
    },
    Case {
        stem: "DSCF0568",
        ev: 1.0,
        crop: Some((3264.0, 2448.0, 5120.0, 3840.0)),
        jpeg: (5120, 3840),
        swaps_axes: false,
    },
    Case {
        stem: "DSCF0476",
        ev: 2.0,
        crop: Some((0.0, 2217.0, 11648.0, 4301.0)),
        jpeg: (11648, 4304),
        swaps_axes: false,
    },
];

const DIMENSION_TOLERANCE_PX: u32 = 8;

fn root() -> Option<PathBuf> {
    std::env::var_os("RAPIDRAW_RAF_FIXTURE_DIR").map(PathBuf::from)
}

fn displayed((width, height): (u32, u32), swap: bool) -> (u32, u32) {
    if swap {
        (height, width)
    } else {
        (width, height)
    }
}

fn assert_dims_close(label: &str, actual: (u32, u32), expected: (u32, u32)) {
    assert!(
        actual.0.abs_diff(expected.0) <= DIMENSION_TOLERANCE_PX
            && actual.1.abs_diff(expected.1) <= DIMENSION_TOLERANCE_PX,
        "{label}: {actual:?} is not within {DIMENSION_TOLERANCE_PX}px of {expected:?}"
    );
}

/// Bytes and modification time of a file that must stay untouched.
type FileState = Option<(Vec<u8>, SystemTime)>;

fn file_state(path: &Path) -> FileState {
    let bytes = fs::read(path).ok()?;
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some((bytes, modified))
}

struct Fixture {
    case: Case,
    _dir: tempfile::TempDir,
    raw: PathBuf,
    bytes: Vec<u8>,
}

fn fixtures() -> Option<Vec<Fixture>> {
    let Some(root) = root() else {
        eprintln!("SKIP: set RAPIDRAW_RAF_FIXTURE_DIR");
        return None;
    };
    Some(
        CASES
            .iter()
            .map(|&case| {
                let source = root.join("raw").join(format!("{}.RAF", case.stem));
                let dir = tempfile::tempdir().unwrap();
                let raw = dir.path().join(format!("{}.RAF", case.stem));
                fs::copy(&source, &raw).unwrap();
                let bytes = fs::read(&raw).unwrap();
                Fixture {
                    case,
                    _dir: dir,
                    raw,
                    bytes,
                }
            })
            .collect(),
    )
}

fn original_sidecars() -> Vec<(PathBuf, FileState)> {
    let Some(root) = root() else {
        return Vec::new();
    };
    CASES
        .iter()
        .map(|case| {
            let sidecar = root.join("raw").join(format!("{}.RAF.rrdata", case.stem));
            let state = file_state(&sidecar);
            (sidecar, state)
        })
        .collect()
}

fn assert_sidecars_untouched(before: &[(PathBuf, FileState)]) {
    for (sidecar, state) in before {
        assert!(
            file_state(sidecar) == *state,
            "original sidecar {} changed",
            sidecar.display()
        );
    }
}

#[test]
fn gfx100rf_camera_defaults_and_dynamic_range_match_validated_values() {
    let sidecars = original_sidecars();
    let Some(fixtures) = fixtures() else {
        return;
    };

    for fixture in &fixtures {
        let case = fixture.case;
        let defaults = camera_defaults_for_path(&fixture.raw);
        match (defaults.crop, case.crop) {
            (None, None) => assert_eq!(defaults, CameraDefaults::default(), "{}", case.stem),
            (Some(crop), Some(expected)) => {
                assert_eq!(
                    (crop.x, crop.y, crop.width, crop.height),
                    expected,
                    "{} crop",
                    case.stem
                );
                assert_eq!(
                    (defaults.canvas_width, defaults.canvas_height),
                    (Some(11648), Some(8736)),
                    "{} canvas",
                    case.stem
                );
                assert_dims_close(
                    case.stem,
                    (crop.width as u32, crop.height as u32),
                    displayed(case.jpeg, case.swaps_axes),
                );
            }
            other => panic!("{} defaults mismatch: {other:?}", case.stem),
        }
        assert_eq!(
            crate::camera_defaults::camera_defaults_for_bytes(&fixture.bytes, &fixture.raw),
            defaults,
            "{} byte and path extraction agree",
            case.stem
        );

        let as_shot = crate::raw_processing::read_as_shot(&fixture.bytes).unwrap();
        assert_eq!(
            as_shot.exposure.highlight_preservation, case.ev,
            "{} Dynamic Range compensation",
            case.stem
        );
    }

    assert_sidecars_untouched(&sidecars);
}

/// Every backend render path frames an unedited RAF the same way.
///
/// RAW development needs the app's GPU context, so this checks the geometry
/// each path derives on the CPU, for full-resolution and reduced decodes.
#[test]
fn gfx100rf_backend_paths_agree_on_camera_framing() {
    let sidecars = original_sidecars();
    let Some(fixtures) = fixtures() else {
        return;
    };

    for fixture in &fixtures {
        let case = fixture.case;
        let path = fixture.raw.to_str().unwrap();
        let canvas = displayed((11648, 8736), case.swaps_axes);
        let expected = displayed(case.jpeg, case.swaps_axes);

        // Standalone previews and exports render full-resolution pixels.
        let full = persisted_render_adjustments(
            &fixture.raw,
            &Value::Null,
            ImageSourceKind::DevelopedRaw,
            Some(canvas),
        );
        let framed = SourceTransform::from_adjustments(path, &full).output_size(canvas);
        assert_dims_close(case.stem, framed, expected);

        // Export estimates keep the crop at full resolution and scale it like
        // a saved crop, so they inject the same adjustments.
        assert_eq!(
            persisted_render_adjustments(
                &fixture.raw,
                &Value::Null,
                ImageSourceKind::DevelopedRaw,
                None,
            ),
            full,
            "{} estimate adjustments",
            case.stem
        );

        // Unedited decoded thumbnails crop a reduced decode directly.
        const REDUCTION: u32 = 4;
        let reduced = (canvas.0 / REDUCTION, canvas.1 / REDUCTION);
        let thumbnail = camera_framed_thumbnail(
            &fixture.raw,
            &DynamicImage::new_rgb8(reduced.0, reduced.1),
            ImageSourceKind::DevelopedRaw,
        )
        .map_or(reduced, |image| image.dimensions());
        let thumbnail_at_full = (thumbnail.0 * REDUCTION, thumbnail.1 * REDUCTION);
        assert!(
            thumbnail_at_full.0.abs_diff(framed.0) <= REDUCTION
                && thumbnail_at_full.1.abs_diff(framed.1) <= REDUCTION,
            "{} thumbnail {thumbnail_at_full:?} != preview {framed:?}",
            case.stem
        );

        // First explicit edits of an untouched RAF persist the camera framing,
        // whether they decode the image (auto adjust) or not (paste, sync).
        let materialized =
            first_edit_adjustments(&fixture.raw, ImageSourceKind::DevelopedRaw, || {
                camera_defaults_for_bytes(&fixture.bytes, &fixture.raw)
            });
        if case.crop.is_some() {
            assert_eq!(materialized, full, "{} first edit", case.stem);
        } else {
            assert_eq!(
                materialized,
                default_adjustments(),
                "{} first edit",
                case.stem
            );
        }
        assert_eq!(
            first_edit_adjustments_for_path(&fixture.raw),
            materialized,
            "{} first edit without decoding",
            case.stem
        );

        // An embedded-preview fallback already shows the camera's framing.
        assert_eq!(
            persisted_render_adjustments(
                &fixture.raw,
                &Value::Null,
                ImageSourceKind::EmbeddedPreview,
                Some(canvas),
            ),
            Value::Null,
            "{} embedded preview",
            case.stem
        );
    }

    assert_sidecars_untouched(&sidecars);
}
