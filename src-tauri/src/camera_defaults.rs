use crate::{
    formats::is_raw_file,
    image_processing::{Crop, ImageMetadata},
};
use rawler::{
    Orientation,
    decoders::{RawDecodeParams, RawMetadata},
    imgop::{Dim2, Point, Rect},
    rawsource::RawSource,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{panic::AssertUnwindSafe, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageSourceKind {
    DevelopedRaw,
    EmbeddedPreview,
    NonRaw,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraDefaults {
    pub crop: Option<Crop>,
    pub aspect_ratio: Option<f64>,
    pub canvas_width: Option<u32>,
    pub canvas_height: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct LoadMetadataResult {
    #[serde(flatten)]
    pub metadata: ImageMetadata,
    #[serde(rename = "cameraDefaults")]
    pub camera_defaults: CameraDefaults,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct OrientedCameraCrop {
    pub(crate) canvas: Dim2,
    pub(crate) rect: Rect,
}

fn camera_crop_edges(canvas: Dim2, rect: Rect) -> Option<(usize, usize)> {
    if canvas.w == 0 || canvas.h == 0 || rect.d.w == 0 || rect.d.h == 0 {
        return None;
    }

    let right = rect.p.x.checked_add(rect.d.w)?;
    let bottom = rect.p.y.checked_add(rect.d.h)?;
    if right > canvas.w || bottom > canvas.h {
        return None;
    }

    Some((right, bottom))
}

pub(crate) fn orient_camera_crop(
    canvas: Dim2,
    rect: Rect,
    orientation: Orientation,
) -> Option<OrientedCameraCrop> {
    let x = rect.p.x;
    let y = rect.p.y;
    let size = rect.d;
    let (right, bottom) = camera_crop_edges(canvas, rect)?;

    let (canvas, rect) = match orientation {
        Orientation::Normal | Orientation::Unknown => (canvas, rect),
        Orientation::HorizontalFlip => (canvas, Rect::new(Point::new(canvas.w - right, y), size)),
        Orientation::Rotate180 => (
            canvas,
            Rect::new(Point::new(canvas.w - right, canvas.h - bottom), size),
        ),
        Orientation::VerticalFlip => (canvas, Rect::new(Point::new(x, canvas.h - bottom), size)),
        Orientation::Transpose => (
            Dim2::new(canvas.h, canvas.w),
            Rect::new(Point::new(y, x), Dim2::new(size.h, size.w)),
        ),
        Orientation::Rotate90 => (
            Dim2::new(canvas.h, canvas.w),
            Rect::new(Point::new(canvas.h - bottom, x), Dim2::new(size.h, size.w)),
        ),
        Orientation::Transverse => (
            Dim2::new(canvas.h, canvas.w),
            Rect::new(
                Point::new(canvas.h - bottom, canvas.w - right),
                Dim2::new(size.h, size.w),
            ),
        ),
        Orientation::Rotate270 => (
            Dim2::new(canvas.h, canvas.w),
            Rect::new(Point::new(y, canvas.w - right), Dim2::new(size.h, size.w)),
        ),
    };

    Some(OrientedCameraCrop { canvas, rect })
}

impl CameraDefaults {
    pub(crate) fn from_oriented(oriented: OrientedCameraCrop) -> Self {
        if camera_crop_edges(oriented.canvas, oriented.rect).is_none() {
            return Self::default();
        }

        let Ok(canvas_width) = u32::try_from(oriented.canvas.w) else {
            return Self::default();
        };
        let Ok(canvas_height) = u32::try_from(oriented.canvas.h) else {
            return Self::default();
        };

        Self {
            crop: Some(Crop {
                x: oriented.rect.p.x as f64,
                y: oriented.rect.p.y as f64,
                width: oriented.rect.d.w as f64,
                height: oriented.rect.d.h as f64,
            }),
            aspect_ratio: Some(oriented.rect.d.w as f64 / oriented.rect.d.h as f64),
            canvas_width: Some(canvas_width),
            canvas_height: Some(canvas_height),
        }
    }
}

fn camera_defaults_from_raw(metadata: &RawMetadata) -> CameraDefaults {
    let Some(camera_crop) = metadata.render_metadata.camera_crop.as_ref() else {
        return CameraDefaults::default();
    };
    let orientation = metadata
        .exif
        .orientation
        .map(Orientation::from_u16)
        .unwrap_or(Orientation::Normal);

    orient_camera_crop(camera_crop.canvas, camera_crop.rect, orientation)
        .map(CameraDefaults::from_oriented)
        .unwrap_or_default()
}

pub(crate) fn scaled_camera_crop(
    defaults: &CameraDefaults,
    developed_width: u32,
    developed_height: u32,
) -> Option<Crop> {
    const BOUNDS_TOLERANCE: f64 = 1e-6;

    if developed_width == 0 || developed_height == 0 {
        return None;
    }

    let canvas_width = defaults.canvas_width?;
    let canvas_height = defaults.canvas_height?;
    if canvas_width == 0 || canvas_height == 0 {
        return None;
    }

    let crop = defaults.crop?;
    let source_values = [crop.x, crop.y, crop.width, crop.height];
    if !source_values.into_iter().all(f64::is_finite)
        || crop.x < 0.0
        || crop.y < 0.0
        || crop.width <= 0.0
        || crop.height <= 0.0
    {
        return None;
    }
    let source_right = crop.x + crop.width;
    let source_bottom = crop.y + crop.height;
    if !source_right.is_finite() || !source_bottom.is_finite() {
        return None;
    }

    let scale_x = f64::from(developed_width) / f64::from(canvas_width);
    let scale_y = f64::from(developed_height) / f64::from(canvas_height);
    if !scale_x.is_finite() || !scale_y.is_finite() {
        return None;
    }

    let scaled = Crop {
        x: crop.x * scale_x,
        y: crop.y * scale_y,
        width: crop.width * scale_x,
        height: crop.height * scale_y,
    };
    let scaled_values = [scaled.x, scaled.y, scaled.width, scaled.height];
    if !scaled_values.into_iter().all(f64::is_finite)
        || scaled.x < 0.0
        || scaled.y < 0.0
        || scaled.width <= 0.0
        || scaled.height <= 0.0
    {
        return None;
    }

    let right = scaled.x + scaled.width;
    let bottom = scaled.y + scaled.height;
    if !right.is_finite()
        || !bottom.is_finite()
        || right > f64::from(developed_width) + BOUNDS_TOLERANCE
        || bottom > f64::from(developed_height) + BOUNDS_TOLERANCE
    {
        return None;
    }

    Some(scaled)
}

pub fn effective_adjustments(
    persisted: &Value,
    defaults: &CameraDefaults,
    source_kind: ImageSourceKind,
    developed_width: u32,
    developed_height: u32,
) -> Value {
    if !persisted.is_null() || source_kind != ImageSourceKind::DevelopedRaw {
        return persisted.clone();
    }
    let Some(crop) = scaled_camera_crop(defaults, developed_width, developed_height) else {
        return persisted.clone();
    };
    json!({ "crop": crop, "aspectRatio": defaults.aspect_ratio })
}

fn camera_defaults_for_path_with<F>(path: &Path, extract: F) -> CameraDefaults
where
    F: FnOnce(&Path) -> anyhow::Result<CameraDefaults>,
{
    match std::panic::catch_unwind(AssertUnwindSafe(|| extract(path))) {
        Ok(Ok(defaults)) => defaults,
        Ok(Err(error)) => {
            log::debug!("No camera defaults for '{}': {error}", path.display());
            CameraDefaults::default()
        }
        Err(_) => {
            log::debug!("RAW camera default extraction panicked");
            CameraDefaults::default()
        }
    }
}

pub fn camera_defaults_for_path(path: &Path) -> CameraDefaults {
    camera_defaults_for_path_with(path, |path| {
        let source = RawSource::new(path)?;
        let decoder = rawler::get_decoder(&source)?;
        let metadata = decoder.raw_metadata(&source, &RawDecodeParams::default())?;
        Ok(camera_defaults_from_raw(&metadata))
    })
}

pub fn metadata_result_for_path(metadata: ImageMetadata, source_path: &Path) -> LoadMetadataResult {
    let camera_defaults = if is_raw_file(source_path) {
        camera_defaults_for_path(source_path)
    } else {
        CameraDefaults::default()
    };
    LoadMetadataResult {
        metadata,
        camera_defaults,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_processing::{Crop, ImageMetadata};
    use rawler::{
        Orientation,
        decoders::{RawCameraCrop, RawMetadata},
        imgop::{Dim2, Point, Rect},
    };
    use serde_json::{Value, json};
    use std::collections::HashMap;

    fn crop(x: f64, y: f64, width: f64, height: f64) -> Crop {
        Crop {
            x,
            y,
            width,
            height,
        }
    }

    fn defaults_with_crop(crop: Crop, canvas_width: u32, canvas_height: u32) -> CameraDefaults {
        CameraDefaults {
            crop: Some(crop),
            aspect_ratio: None,
            canvas_width: Some(canvas_width),
            canvas_height: Some(canvas_height),
        }
    }

    #[test]
    fn orients_camera_crop_for_all_exif_values() {
        let canvas = Dim2::new(10, 6);
        let rect = Rect::new(Point::new(2, 1), Dim2::new(3, 2));
        let cases = [
            (Orientation::Normal, (10, 6, 2, 1, 3, 2)),
            (Orientation::HorizontalFlip, (10, 6, 5, 1, 3, 2)),
            (Orientation::Rotate180, (10, 6, 5, 3, 3, 2)),
            (Orientation::VerticalFlip, (10, 6, 2, 3, 3, 2)),
            (Orientation::Transpose, (6, 10, 1, 2, 2, 3)),
            (Orientation::Rotate90, (6, 10, 3, 2, 2, 3)),
            (Orientation::Transverse, (6, 10, 3, 5, 2, 3)),
            (Orientation::Rotate270, (6, 10, 1, 5, 2, 3)),
        ];

        for (orientation, expected) in cases {
            let oriented = orient_camera_crop(canvas, rect, orientation).unwrap();
            assert_eq!(
                (
                    oriented.canvas.w,
                    oriented.canvas.h,
                    oriented.rect.p.x,
                    oriented.rect.p.y,
                    oriented.rect.d.w,
                    oriented.rect.d.h,
                ),
                expected
            );
        }
    }

    #[test]
    fn unknown_orientation_uses_normal_geometry() {
        let canvas = Dim2::new(10, 6);
        let rect = Rect::new(Point::new(2, 1), Dim2::new(3, 2));

        assert_eq!(
            orient_camera_crop(canvas, rect, Orientation::Unknown),
            Some(OrientedCameraCrop { canvas, rect })
        );
    }

    #[test]
    fn orientation_rejects_empty_overflowing_and_out_of_bounds_geometry() {
        let valid_rect = Rect::new(Point::new(2, 1), Dim2::new(3, 2));
        assert_eq!(
            orient_camera_crop(Dim2::new(0, 6), valid_rect, Orientation::Normal),
            None
        );
        assert_eq!(
            orient_camera_crop(Dim2::new(10, 0), valid_rect, Orientation::Normal),
            None
        );

        for size in [Dim2::new(0, 2), Dim2::new(3, 0)] {
            assert_eq!(
                orient_camera_crop(
                    Dim2::new(10, 6),
                    Rect::new(Point::new(2, 1), size),
                    Orientation::Normal,
                ),
                None
            );
        }

        let invalid_rects = [
            Rect::new(Point::new(usize::MAX, 1), Dim2::new(1, 1)),
            Rect::new(Point::new(1, usize::MAX), Dim2::new(1, 1)),
            Rect::new(Point::new(8, 1), Dim2::new(3, 2)),
            Rect::new(Point::new(2, 5), Dim2::new(3, 2)),
        ];
        for rect in invalid_rects {
            assert_eq!(
                orient_camera_crop(Dim2::new(10, 6), rect, Orientation::Rotate90),
                None
            );
        }

        let edge_rect = Rect::new(Point::new(7, 4), Dim2::new(3, 2));
        assert!(orient_camera_crop(Dim2::new(10, 6), edge_rect, Orientation::Rotate90).is_some());
    }

    #[test]
    fn from_oriented_converts_crop_aspect_and_canvas() {
        let defaults = CameraDefaults::from_oriented(OrientedCameraCrop {
            canvas: Dim2::new(6, 10),
            rect: Rect::new(Point::new(3, 2), Dim2::new(2, 3)),
        });

        assert_eq!(
            defaults,
            CameraDefaults {
                crop: Some(crop(3.0, 2.0, 2.0, 3.0)),
                aspect_ratio: Some(2.0 / 3.0),
                canvas_width: Some(6),
                canvas_height: Some(10),
            }
        );
    }

    #[test]
    fn from_oriented_rejects_canvas_dimensions_that_do_not_fit_u32() {
        let Ok(oversized) = usize::try_from(u64::from(u32::MAX) + 1) else {
            return;
        };
        let defaults = CameraDefaults::from_oriented(OrientedCameraCrop {
            canvas: Dim2::new(oversized, 10),
            rect: Rect::new(Point::new(3, 2), Dim2::new(2, 3)),
        });

        assert_eq!(defaults, CameraDefaults::default());
    }

    #[test]
    fn from_oriented_rejects_zero_sized_rectangles() {
        let invalid = [
            OrientedCameraCrop {
                canvas: Dim2::new(10, 6),
                rect: Rect::new(Point::new(2, 1), Dim2::new(0, 2)),
            },
            OrientedCameraCrop {
                canvas: Dim2::new(10, 6),
                rect: Rect::new(Point::new(2, 1), Dim2::new(3, 0)),
            },
        ];

        assert_eq!(
            invalid.map(CameraDefaults::from_oriented),
            [CameraDefaults::default(), CameraDefaults::default()]
        );
    }

    #[test]
    fn from_oriented_rejects_checked_add_overflow() {
        let defaults = CameraDefaults::from_oriented(OrientedCameraCrop {
            canvas: Dim2::new(10, 6),
            rect: Rect::new(Point::new(usize::MAX, 1), Dim2::new(1, 2)),
        });

        assert_eq!(defaults, CameraDefaults::default());
    }

    #[test]
    fn from_oriented_rejects_out_of_bounds_rectangles() {
        let invalid = [
            OrientedCameraCrop {
                canvas: Dim2::new(10, 6),
                rect: Rect::new(Point::new(8, 1), Dim2::new(3, 2)),
            },
            OrientedCameraCrop {
                canvas: Dim2::new(10, 6),
                rect: Rect::new(Point::new(2, 5), Dim2::new(3, 2)),
            },
        ];

        assert_eq!(
            invalid.map(CameraDefaults::from_oriented),
            [CameraDefaults::default(), CameraDefaults::default()]
        );
    }

    #[test]
    fn raw_metadata_crop_uses_exif_orientation() {
        let mut metadata = RawMetadata::default();
        metadata.exif.orientation = Some(6);
        metadata.render_metadata.camera_crop = Some(RawCameraCrop {
            canvas: Dim2::new(10, 6),
            rect: Rect::new(Point::new(2, 1), Dim2::new(3, 2)),
        });

        assert_eq!(
            camera_defaults_from_raw(&metadata),
            CameraDefaults {
                crop: Some(crop(3.0, 2.0, 2.0, 3.0)),
                aspect_ratio: Some(2.0 / 3.0),
                canvas_width: Some(6),
                canvas_height: Some(10),
            }
        );
    }

    #[test]
    fn raw_metadata_crop_without_exif_orientation_uses_normal_geometry() {
        let mut metadata = RawMetadata::default();
        metadata.exif.orientation = None;
        metadata.render_metadata.camera_crop = Some(RawCameraCrop {
            canvas: Dim2::new(10, 6),
            rect: Rect::new(Point::new(2, 1), Dim2::new(3, 2)),
        });

        assert_eq!(
            camera_defaults_from_raw(&metadata),
            CameraDefaults {
                crop: Some(crop(2.0, 1.0, 3.0, 2.0)),
                aspect_ratio: Some(3.0 / 2.0),
                canvas_width: Some(10),
                canvas_height: Some(6),
            }
        );
    }

    #[test]
    fn raw_metadata_without_a_valid_crop_returns_empty_defaults() {
        let mut metadata = RawMetadata::default();
        assert_eq!(
            camera_defaults_from_raw(&metadata),
            CameraDefaults::default()
        );

        metadata.render_metadata.camera_crop = Some(RawCameraCrop {
            canvas: Dim2::new(10, 6),
            rect: Rect::new(Point::new(8, 1), Dim2::new(3, 2)),
        });
        assert_eq!(
            camera_defaults_from_raw(&metadata),
            CameraDefaults::default()
        );
    }

    #[test]
    fn scales_in_the_oriented_coordinate_space() {
        let defaults = CameraDefaults {
            crop: Some(crop(3.0, 2.0, 2.0, 3.0)),
            aspect_ratio: Some(2.0 / 3.0),
            canvas_width: Some(6),
            canvas_height: Some(10),
        };

        assert_eq!(
            scaled_camera_crop(&defaults, 3, 5),
            Some(crop(1.5, 1.0, 1.0, 1.5))
        );
        assert_eq!(scaled_camera_crop(&defaults, 0, 5), None);
        assert_eq!(scaled_camera_crop(&defaults, 3, 0), None);
    }

    #[test]
    fn scaling_requires_a_crop_and_nonzero_source_canvas() {
        assert_eq!(scaled_camera_crop(&CameraDefaults::default(), 3, 5), None);

        for (width, height) in [(0, 10), (6, 0)] {
            let defaults = defaults_with_crop(crop(3.0, 2.0, 2.0, 3.0), width, height);
            assert_eq!(scaled_camera_crop(&defaults, 3, 5), None);
        }
    }

    #[test]
    fn scaling_rejects_nonfinite_and_invalid_source_rectangles() {
        let invalid = [
            crop(f64::NAN, 0.0, 1.0, 1.0),
            crop(0.0, f64::INFINITY, 1.0, 1.0),
            crop(0.0, 0.0, f64::NAN, 1.0),
            crop(0.0, 0.0, 1.0, f64::NEG_INFINITY),
            crop(-1.0, 0.0, 1.0, 1.0),
            crop(0.0, -1.0, 1.0, 1.0),
            crop(0.0, 0.0, 0.0, 1.0),
            crop(0.0, 0.0, 1.0, -1.0),
        ];

        for crop in invalid {
            let defaults = defaults_with_crop(crop, 10, 10);
            assert_eq!(scaled_camera_crop(&defaults, 10, 10), None);
        }
    }

    #[test]
    fn scaling_rejects_nonfinite_edges_and_scaled_values() {
        let nonfinite_edge = defaults_with_crop(crop(f64::MAX, 0.0, f64::MAX, 1.0), 1, 1);
        assert_eq!(scaled_camera_crop(&nonfinite_edge, 1, 1), None);

        let nonfinite_scaled = defaults_with_crop(crop(0.0, 0.0, f64::MAX, 1.0), 1, 1);
        assert_eq!(scaled_camera_crop(&nonfinite_scaled, u32::MAX, 1), None);
    }

    #[test]
    fn scaling_allows_only_the_documented_bounds_tolerance() {
        let within_tolerance = defaults_with_crop(crop(2.0, 3.0, 8.000_000_5, 7.000_000_5), 10, 10);
        assert!(scaled_camera_crop(&within_tolerance, 10, 10).is_some());

        let beyond_right = defaults_with_crop(crop(2.0, 3.0, 8.000_002, 7.0), 10, 10);
        assert_eq!(scaled_camera_crop(&beyond_right, 10, 10), None);

        let beyond_bottom = defaults_with_crop(crop(2.0, 3.0, 8.0, 7.000_002), 10, 10);
        assert_eq!(scaled_camera_crop(&beyond_bottom, 10, 10), None);
    }

    #[test]
    fn dto_serialization_uses_api_case_conventions() {
        let defaults = CameraDefaults {
            crop: None,
            aspect_ratio: Some(1.5),
            canvas_width: Some(6),
            canvas_height: Some(4),
        };

        assert_eq!(
            serde_json::to_value(defaults).unwrap(),
            json!({
                "crop": null,
                "aspectRatio": 1.5,
                "canvasWidth": 6,
                "canvasHeight": 4,
            })
        );
        assert_eq!(
            serde_json::to_value(ImageSourceKind::DevelopedRaw).unwrap(),
            json!("developed_raw")
        );
        assert_eq!(
            serde_json::to_value(ImageSourceKind::EmbeddedPreview).unwrap(),
            json!("embedded_preview")
        );
        assert_eq!(
            serde_json::to_value(ImageSourceKind::NonRaw).unwrap(),
            json!("non_raw")
        );
    }

    #[test]
    fn load_metadata_response_is_flattened() {
        let metadata = ImageMetadata {
            adjustments: Value::Null,
            ..ImageMetadata::default()
        };
        let response = LoadMetadataResult {
            metadata,
            camera_defaults: CameraDefaults {
                canvas_width: Some(200),
                ..CameraDefaults::default()
            },
        };
        let value = serde_json::to_value(response).unwrap();
        assert!(value["adjustments"].is_null());
        assert_eq!(value["cameraDefaults"]["canvasWidth"], 200);
        assert!(value.get("metadata").is_none());
    }

    #[test]
    fn metadata_advisory_failure_preserves_sidecar_fields() {
        let temp = tempfile::tempdir().unwrap();
        let missing_raw = temp.path().join("missing.RAF");
        let metadata = ImageMetadata {
            version: 7,
            rating: 4,
            adjustments: json!({}),
            tags: Some(vec!["keep-me".into()]),
            exif: Some(HashMap::from([("Model".into(), "GFX100RF".into())])),
        };
        let value = serde_json::to_value(metadata_result_for_path(metadata, &missing_raw)).unwrap();
        assert_eq!(value["version"], 7);
        assert_eq!(value["rating"], 4);
        assert_eq!(value["adjustments"], json!({}));
        assert_eq!(value["tags"], json!(["keep-me"]));
        assert_eq!(value["exif"]["Model"], "GFX100RF");
        assert_eq!(
            value["cameraDefaults"],
            serde_json::to_value(CameraDefaults::default()).unwrap()
        );
    }

    #[test]
    fn metadata_advisory_failure_preserves_literal_null() {
        let temp = tempfile::tempdir().unwrap();
        let missing_raw = temp.path().join("missing.RAF");
        let metadata = ImageMetadata {
            adjustments: Value::Null,
            ..ImageMetadata::default()
        };
        let value = serde_json::to_value(metadata_result_for_path(metadata, &missing_raw)).unwrap();
        assert!(value["adjustments"].is_null());
        assert_eq!(
            value["cameraDefaults"],
            serde_json::to_value(CameraDefaults::default()).unwrap()
        );
    }

    #[test]
    fn defaults_apply_only_to_literal_null_developed_raw_adjustments() {
        let defaults = CameraDefaults {
            crop: Some(crop(10.0, 20.0, 100.0, 40.0)),
            aspect_ratio: Some(2.5),
            canvas_width: Some(200),
            canvas_height: Some(100),
        };
        let null = Value::Null;

        assert_eq!(
            effective_adjustments(&null, &defaults, ImageSourceKind::DevelopedRaw, 200, 100,),
            json!({
                "crop": {
                    "x": 10.0,
                    "y": 20.0,
                    "width": 100.0,
                    "height": 40.0,
                },
                "aspectRatio": 2.5,
            })
        );
        assert_eq!(
            effective_adjustments(&null, &defaults, ImageSourceKind::EmbeddedPreview, 200, 100,),
            Value::Null
        );
        assert_eq!(
            effective_adjustments(&null, &defaults, ImageSourceKind::NonRaw, 200, 100),
            Value::Null
        );
    }

    #[test]
    fn defaults_scale_to_downsampled_developed_dimensions() {
        let defaults = CameraDefaults {
            crop: Some(crop(10.0, 20.0, 100.0, 40.0)),
            aspect_ratio: Some(2.5),
            canvas_width: Some(200),
            canvas_height: Some(100),
        };

        assert_eq!(
            effective_adjustments(
                &Value::Null,
                &defaults,
                ImageSourceKind::DevelopedRaw,
                100,
                50,
            ),
            json!({
                "crop": {
                    "x": 5.0,
                    "y": 10.0,
                    "width": 50.0,
                    "height": 20.0,
                },
                "aspectRatio": 2.5,
            })
        );
    }

    #[test]
    fn every_persisted_non_null_value_wins_unchanged() {
        let defaults = CameraDefaults {
            crop: Some(crop(10.0, 20.0, 100.0, 40.0)),
            aspect_ratio: Some(2.5),
            canvas_width: Some(200),
            canvas_height: Some(100),
        };
        let persisted_values = [
            json!({}),
            json!({ "crop": null }),
            json!({
                "crop": { "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 },
                "aspectRatio": 0.75,
            }),
            json!(["saved", "adjustments"]),
            json!("saved adjustments"),
            json!(true),
            json!(42),
        ];

        for persisted in persisted_values {
            assert_eq!(
                effective_adjustments(
                    &persisted,
                    &defaults,
                    ImageSourceKind::DevelopedRaw,
                    200,
                    100,
                ),
                persisted
            );
        }
    }

    #[test]
    fn invalid_defaults_leave_literal_null_adjustments_unchanged() {
        let valid = CameraDefaults {
            crop: Some(crop(10.0, 20.0, 100.0, 40.0)),
            aspect_ratio: Some(2.5),
            canvas_width: Some(200),
            canvas_height: Some(100),
        };
        for (width, height) in [(0, 100), (200, 0)] {
            assert_eq!(
                effective_adjustments(
                    &Value::Null,
                    &valid,
                    ImageSourceKind::DevelopedRaw,
                    width,
                    height,
                ),
                Value::Null
            );
        }

        let invalid_defaults = [
            CameraDefaults::default(),
            defaults_with_crop(crop(10.0, 20.0, 0.0, 40.0), 200, 100),
            defaults_with_crop(crop(150.0, 20.0, 100.0, 40.0), 200, 100),
        ];
        for defaults in invalid_defaults {
            assert_eq!(
                effective_adjustments(
                    &Value::Null,
                    &defaults,
                    ImageSourceKind::DevelopedRaw,
                    200,
                    100,
                ),
                Value::Null
            );
        }
    }

    #[test]
    fn camera_defaults_for_path_is_non_failing() {
        let temp_dir = tempfile::tempdir().unwrap();
        let missing_path = temp_dir.path().join("missing.RAF");
        assert_eq!(
            camera_defaults_for_path(&missing_path),
            CameraDefaults::default()
        );

        let invalid_path = temp_dir.path().join("invalid.RAF");
        std::fs::write(&invalid_path, b"not a valid RAF").unwrap();
        assert_eq!(
            camera_defaults_for_path(&invalid_path),
            CameraDefaults::default()
        );
    }

    #[test]
    fn camera_defaults_for_path_contains_extractor_panics() {
        let defaults = camera_defaults_for_path_with(
            Path::new("unused.RAF"),
            |_| -> anyhow::Result<CameraDefaults> { panic!("synthetic extractor panic") },
        );

        assert_eq!(defaults, CameraDefaults::default());
    }
}
