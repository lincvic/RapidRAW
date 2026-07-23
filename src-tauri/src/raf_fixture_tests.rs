use crate::{
    app_settings::AppSettings,
    camera_defaults::{
        CameraDefaults, ImageSourceKind, camera_defaults_for_path, orient_camera_crop,
        scaled_camera_crop,
    },
    export_processing::{
        FastEstimateScale, GeometryOrigin, prepare_export_estimate_input,
        prepare_export_render_input, render_export_estimate_geometry, render_export_geometry,
    },
    file_management::{prepare_thumbnail_render_input, render_thumbnail_from_loaded},
    image_loader::{
        load_base_image_with_metadata_from_bytes,
        load_base_image_without_intrinsic_exposure_for_test,
    },
    prepare_standalone_preview,
    raw_processing::get_fast_demosaic_scale_factor,
    render_standalone_preview_geometry,
};
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgb};
use rawler::{
    Orientation,
    imgop::{Dim2, Point, Rect},
};
use serde_json::Value;
use std::{fs, path::PathBuf};

#[derive(Clone, Copy)]
struct Case {
    stem: &'static str,
    ev: f64,
    crop: Option<(f64, f64, f64, f64)>,
    swaps_axes: bool,
}

const CASES: [Case; 5] = [
    Case {
        stem: "DSCF0420",
        ev: 1.0,
        crop: None,
        swaps_axes: true,
    },
    Case {
        stem: "DSCF0581",
        ev: 1.0,
        crop: Some((0.0, 2217.0, 11648.0, 4301.0)),
        swaps_axes: false,
    },
    Case {
        stem: "DSCF0434",
        ev: 2.0,
        crop: Some((1296.0, 2770.0, 9056.0, 3196.0)),
        swaps_axes: false,
    },
    Case {
        stem: "DSCF0568",
        ev: 1.0,
        crop: Some((3264.0, 2448.0, 5120.0, 3840.0)),
        swaps_axes: false,
    },
    Case {
        stem: "DSCF0476",
        ev: 2.0,
        crop: Some((0.0, 2217.0, 11648.0, 4301.0)),
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
        actual.0.abs_diff(expected.0) <= DIMENSION_TOLERANCE_PX,
        "{label} width: {actual:?} != {expected:?}"
    );
    assert!(
        actual.1.abs_diff(expected.1) <= DIMENSION_TOLERANCE_PX,
        "{label} height: {actual:?} != {expected:?}"
    );
}

fn assert_ratio_within_dimension_tolerance(label: &str, actual: (u32, u32), expected: (u32, u32)) {
    let min_width = expected.0.saturating_sub(DIMENSION_TOLERANCE_PX);
    let max_width = expected
        .0
        .checked_add(DIMENSION_TOLERANCE_PX)
        .expect("expected width plus tolerance must fit in u32");
    let min_height = expected.1.saturating_sub(DIMENSION_TOLERANCE_PX);
    let max_height = expected
        .1
        .checked_add(DIMENSION_TOLERANCE_PX)
        .expect("expected height plus tolerance must fit in u32");
    assert!(
        actual.0 > 0 && actual.1 > 0 && min_height > 0 && max_height > 0,
        "{label} ratio requires nonzero dimensions: actual={actual:?}, expected={expected:?}"
    );

    let actual_ratio = f64::from(actual.0) / f64::from(actual.1);
    let min_ratio = f64::from(min_width) / f64::from(max_height);
    let max_ratio = f64::from(max_width) / f64::from(min_height);
    assert!(
        (min_ratio..=max_ratio).contains(&actual_ratio),
        "{label} ratio {actual_ratio} outside {min_ratio}..={max_ratio}: actual={actual:?}, expected={expected:?}"
    );
}

fn log_luminance(red: f32, green: f32, blue: f32) -> f64 {
    (0.2126 * f64::from(red) + 0.7152 * f64::from(green) + 0.0722 * f64::from(blue))
        .max(1e-8)
        .log2()
}

fn float_sample_stride(width: u32, height: u32) -> usize {
    const MAX_SAMPLES: usize = 200_000;
    let pixel_count = width as usize * height as usize;
    pixel_count.div_ceil(MAX_SAMPLES).max(1)
}

fn sampled_median_log_luminance(image: &DynamicImage) -> f64 {
    // `thumbnail` adds integer-style rounding to float samples, so preserve HDR values directly.
    let mut values: Vec<f64> = match image {
        DynamicImage::ImageRgb32F(buffer) => buffer
            .pixels()
            .step_by(float_sample_stride(buffer.width(), buffer.height()))
            .map(|pixel| log_luminance(pixel[0], pixel[1], pixel[2]))
            .collect(),
        DynamicImage::ImageRgba32F(buffer) => buffer
            .pixels()
            .step_by(float_sample_stride(buffer.width(), buffer.height()))
            .map(|pixel| log_luminance(pixel[0], pixel[1], pixel[2]))
            .collect(),
        _ => image
            .thumbnail(1024, 1024)
            .to_rgb32f()
            .pixels()
            .step_by(5)
            .map(|pixel| log_luminance(pixel[0], pixel[1], pixel[2]))
            .collect(),
    };
    let middle = values.len() / 2;
    *values
        .select_nth_unstable_by(middle, |a, b| a.total_cmp(b))
        .1
}

#[test]
fn float_luminance_sampling_preserves_one_stop_gain() {
    let base = DynamicImage::ImageRgb32F(ImageBuffer::from_pixel(2048, 1, Rgb([0.05, 0.10, 0.20])));
    let gained =
        DynamicImage::ImageRgb32F(ImageBuffer::from_pixel(2048, 1, Rgb([0.10, 0.20, 0.40])));

    let measured_gain = sampled_median_log_luminance(&gained) - sampled_median_log_luminance(&base);
    assert!((measured_gain - 1.0).abs() < 1e-6, "{measured_gain}");
}

#[test]
fn gfx100rf_backend_render_paths_match_private_pairs() {
    let Some(root) = root() else {
        eprintln!("SKIP: set RAPIDRAW_RAF_FIXTURE_DIR");
        return;
    };
    let settings = AppSettings::default();

    for case in CASES {
        let raw = root.join("raw").join(format!("{}.RAF", case.stem));
        let jpeg = root.join(format!("{}.JPG", case.stem));
        let isolated = tempfile::tempdir().unwrap();
        let isolated_raw = isolated.path().join(format!("{}.RAF", case.stem));
        fs::copy(&raw, &isolated_raw).unwrap();
        let bytes = fs::read(&isolated_raw).unwrap();
        let jpeg_dims = displayed(image::image_dimensions(&jpeg).unwrap(), case.swaps_axes);
        let original_sidecar = PathBuf::from(format!("{}.rrdata", raw.display()));
        let original_sidecar_before = fs::read(&original_sidecar).ok();
        let original_mtime_before = fs::metadata(&original_sidecar)
            .and_then(|metadata| metadata.modified())
            .ok();

        let defaults = camera_defaults_for_path(&isolated_raw);
        match (defaults.crop, case.crop) {
            (None, None) => assert_eq!(defaults, CameraDefaults::default()),
            (Some(crop), Some(expected)) => {
                assert_eq!((crop.x, crop.y, crop.width, crop.height), expected);
                assert_eq!(
                    (defaults.canvas_width, defaults.canvas_height),
                    (Some(11648), Some(8736))
                );
            }
            other => panic!("{} defaults mismatch: {other:?}", case.stem),
        }

        let full = load_base_image_with_metadata_from_bytes(
            &bytes,
            isolated_raw.to_str().unwrap(),
            false,
            &settings,
            None,
        )
        .unwrap();
        assert_eq!(full.source_kind, ImageSourceKind::DevelopedRaw);

        let standalone = prepare_standalone_preview(&Value::Null, None, &full, &defaults);
        assert_dims_close(
            case.stem,
            render_standalone_preview_geometry(&full, &standalone)
                .0
                .dimensions(),
            jpeg_dims,
        );

        let export = prepare_export_render_input(&Value::Null, None, &defaults, &full);
        assert_dims_close(
            case.stem,
            render_export_geometry(&full, &export).0.dimensions(),
            jpeg_dims,
        );

        let editor_estimate = prepare_export_estimate_input(
            &Value::Null,
            Some(&standalone.effective_adjustments),
            &defaults,
            &full,
            GeometryOrigin::CurrentEditor,
            FastEstimateScale {
                crop_x: 1.0,
                crop_y: 1.0,
                masks: 1.0,
                output_x: 1.0,
                output_y: 1.0,
            },
        );
        assert_dims_close(
            case.stem,
            render_export_estimate_geometry(&full, &editor_estimate)
                .0
                .dimensions(),
            jpeg_dims,
        );

        let corrected = sampled_median_log_luminance(&full.image);
        drop(full);

        let fast = load_base_image_with_metadata_from_bytes(
            &bytes,
            isolated_raw.to_str().unwrap(),
            true,
            &settings,
            None,
        )
        .unwrap();
        assert_eq!(
            fast.source_kind,
            ImageSourceKind::DevelopedRaw,
            "{} fast source kind",
            case.stem
        );
        let raw_scale =
            get_fast_demosaic_scale_factor(&bytes, fast.image.width(), fast.image.height());
        let fast_input = prepare_export_estimate_input(
            &Value::Null,
            None,
            &defaults,
            &fast,
            GeometryOrigin::CameraDefault,
            FastEstimateScale {
                crop_x: raw_scale.into(),
                crop_y: raw_scale.into(),
                masks: raw_scale,
                output_x: raw_scale,
                output_y: raw_scale,
            },
        );
        let fast_dims = render_export_estimate_geometry(&fast, &fast_input)
            .0
            .dimensions();
        let thumbnail_input = prepare_thumbnail_render_input(&Value::Null, &defaults, &fast);
        let thumbnail =
            render_thumbnail_from_loaded(fast, &thumbnail_input, true, &settings).unwrap();
        assert_eq!(thumbnail.dimensions(), fast_dims);
        assert_ratio_within_dimension_tolerance(case.stem, fast_dims, jpeg_dims);

        let pre_gain = load_base_image_without_intrinsic_exposure_for_test(
            &bytes,
            isolated_raw.to_str().unwrap(),
            false,
            &settings,
            None,
        )
        .unwrap();
        let uncorrected = sampled_median_log_luminance(&pre_gain.image);
        drop(pre_gain);

        let jpeg_luma = sampled_median_log_luminance(&image::open(&jpeg).unwrap());
        eprintln!(
            "{} JPEG-corrected={:.3}EV JPEG-pre-gain={:.3}EV",
            case.stem,
            jpeg_luma - corrected,
            jpeg_luma - uncorrected
        );
        assert!(
            ((corrected - uncorrected) - case.ev).abs() < 0.02,
            "{} intrinsic gain",
            case.stem
        );
        assert_eq!(
            fs::read(&original_sidecar).ok(),
            original_sidecar_before,
            "{} sidecar bytes",
            case.stem
        );
        assert_eq!(
            fs::metadata(&original_sidecar)
                .and_then(|metadata| metadata.modified())
                .ok(),
            original_mtime_before,
            "{} sidecar timestamp",
            case.stem
        );
    }
}

#[test]
fn rotated_fast_crop_scales_in_oriented_space() {
    let oriented = orient_camera_crop(
        Dim2::new(10, 6),
        Rect::new(Point::new(2, 1), Dim2::new(3, 2)),
        Orientation::Rotate90,
    )
    .unwrap();
    assert_eq!((oriented.canvas.w, oriented.canvas.h), (6, 10));
    assert_eq!(
        (
            oriented.rect.p.x,
            oriented.rect.p.y,
            oriented.rect.d.w,
            oriented.rect.d.h,
        ),
        (3, 2, 2, 3)
    );

    let defaults = CameraDefaults::from_oriented(oriented);
    let crop = scaled_camera_crop(&defaults, 3, 5).unwrap();
    assert_eq!(
        (crop.x, crop.y, crop.width, crop.height),
        (1.5, 1.0, 1.0, 1.5)
    );
    assert!(crop.x + crop.width <= 3.0 && crop.y + crop.height <= 5.0);
}
