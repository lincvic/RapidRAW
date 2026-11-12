//! Fujifilm RAF camera framing.
//!
//! Fujifilm cameras record the framing of the camera JPEG separately from the
//! sensor-border crop: an aspect ratio (for example 65:24 or 17:6 on the
//! GFX100RF) and, when the digital teleconverter is active, a zoom     compose_camera_crop(canvas, zoom, aspect).map(|rect| RafCameraCrop { canvas, rect })angle.
//! Both live in the proprietary RAF metadata block, which upstream rawler only
//! partially parses, so RapidRAW reads the few tags it needs directly.
//!
//! The resulting camera crop uses the decoder's default-cropped coordinate
//! system before EXIF orientation: `(0, 0)` is the top-left pixel that remains
//! after rawler applies the RAF base crop (`RawImageCropTopLeft` and
//! `RawImageCroppedSize`).

use rawler::imgop::{Dim2, Point, Rect};

const RAF_MAGIC: &[u8] = b"FUJIFILM";
/// Header position of the big-endian pointer to the RAF metadata block.
const RAF_TAGS_PTR_OFFSET: usize = 92;
/// Same entry limit rawler applies to the RAF metadata block.
const MAX_RAF_TAG_ENTRIES: u32 = 4000;

const RAW_IMAGE_CROP_TOP_LEFT: u16 = 0x0110;
const RAW_IMAGE_CROPPED_SIZE: u16 = 0x0111;
const RAW_IMAGE_ASPECT_RATIO: u16 = 0x0115;
const RAW_ZOOM_ACTIVE: u16 = 0x0117;
const RAW_ZOOM_TOP_LEFT: u16 = 0x0118;
const RAW_ZOOM_SIZE: u16 = 0x0119;

/// Byte length of every framing tag value: two big-endian `u16` or one `u32`.
const FRAMING_VALUE_LEN: usize = 4;

/// Framing tags read from the RAF metadata block.
///
/// Fujifilm stores two-dimensional values in height/width or y/x order; the
/// pairs here keep that on-disk order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct RafFramingTags {
    crop_top_left: Option<[u16; 2]>,
    cropped_size: Option<[u16; 2]>,
    aspect_ratio: Option<[u16; 2]>,
    zoom_active: Option<u32>,
    zoom_top_left: Option<[u16; 2]>,
    zoom_size: Option<[u16; 2]>,
}

/// Camera framing for a RAF file whose framing differs from its full
/// default-cropped canvas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RafCameraCrop {
    /// Default-cropped output canvas, `(0, 0, base_width, base_height)`.
    pub(crate) canvas: Dim2,
    /// Camera framing in `canvas` coordinates.
    pub(crate) rect: Rect,
}

/// Returns the camera framing of a RAF file, or `None` when the file is not a
/// RAF, the metadata is absent or malformed, or the framing equals the full
/// default-cropped canvas. Never fails: framing metadata is advisory.
pub(crate) fn camera_crop(file_bytes: &[u8]) -> Option<RafCameraCrop> {
    if !file_bytes.starts_with(RAF_MAGIC) {
        return None;
    }
    let block_offset = read_be_u32(file_bytes, RAF_TAGS_PTR_OFFSET)?;
    let tags = parse_framing_tags(file_bytes, usize::try_from(block_offset).ok()?)?;
    camera_crop_from_tags(&tags)
}

fn camera_crop_from_tags(tags: &RafFramingTags) -> Option<RafCameraCrop> {
    // The base crop offset only positions the canvas inside the full RAF; the
    // camera crop is relative to the canvas, so only its size matters here.
    tags.crop_top_left?;
    let [crop_h, crop_w] = tags.cropped_size?;
    let canvas = Dim2::new(crop_w.into(), crop_h.into());

    let aspect = tags
        .aspect_ratio
        .map(|[h, w]| Dim2::new(w.into(), h.into()));
    let zoom = if tags.zoom_active == Some(1) {
        match (tags.zoom_top_left, tags.zoom_size) {
            (Some([y, x]), Some([h, w])) => Some(Rect::new(
                Point::new(x.into(), y.into()),
                Dim2::new(w.into(), h.into()),
            )),
            _ => None,
        }
    } else {
        None
    };

    compose_camera_crop(canvas, zoom, aspect).map(|rect| RafCameraCrop { canvas, rect })
}

fn read_be_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    Some(u16::from_be_bytes(bytes.get(offset..end)?.try_into().ok()?))
}

fn read_be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    Some(u32::from_be_bytes(bytes.get(offset..end)?.try_into().ok()?))
}

fn read_short_pair(value: &[u8]) -> Option<[u16; 2]> {
    Some([read_be_u16(value, 0)?, read_be_u16(value, 2)?])
}

/// Parses the framing tags of the RAF metadata block at `offset`.
///
/// The block is a big-endian entry count followed by `(tag, byte length,
/// value)` entries. Framing tags with an unexpected length are skipped without
/// misaligning the following entries. A truncated or oversized block yields
/// `None`, mirroring rawler, which then ignores the whole block.
fn parse_framing_tags(bytes: &[u8], offset: usize) -> Option<RafFramingTags> {
    let count = read_be_u32(bytes, offset)?;
    if count > MAX_RAF_TAG_ENTRIES {
        return None;
    }

    let mut tags = RafFramingTags::default();
    let mut cursor = offset.checked_add(4)?;
    for _ in 0..count {
        let tag = read_be_u16(bytes, cursor)?;
        let len = usize::from(read_be_u16(bytes, cursor.checked_add(2)?)?);
        let value_start = cursor.checked_add(4)?;
        let value_end = value_start.checked_add(len)?;
        let value = bytes.get(value_start..value_end)?;
        cursor = value_end;

        if len != FRAMING_VALUE_LEN {
            continue;
        }
        match tag {
            RAW_IMAGE_CROP_TOP_LEFT => tags.crop_top_left = read_short_pair(value),
            RAW_IMAGE_CROPPED_SIZE => tags.cropped_size = read_short_pair(value),
            RAW_IMAGE_ASPECT_RATIO => tags.aspect_ratio = read_short_pair(value),
            RAW_ZOOM_ACTIVE => tags.zoom_active = read_be_u32(value, 0),
            RAW_ZOOM_TOP_LEFT => tags.zoom_top_left = read_short_pair(value),
            RAW_ZOOM_SIZE => tags.zoom_size = read_short_pair(value),
            _ => {}
        }
    }
    Some(tags)
}

fn rect_within(canvas: Dim2, rect: Rect) -> bool {
    if canvas.w == 0 || canvas.h == 0 || rect.d.w == 0 || rect.d.h == 0 {
        return false;
    }

    let Some(right) = rect.p.x.checked_add(rect.d.w) else {
        return false;
    };
    let Some(bottom) = rect.p.y.checked_add(rect.d.h) else {
        return false;
    };
    right <= canvas.w && bottom <= canvas.h
}

fn round_mul_div(value: usize, multiplier: usize, denominator: usize) -> Option<usize> {
    if denominator == 0 {
        return None;
    }

    let denominator = denominator as u128;
    let rounded = (value as u128)
        .checked_mul(multiplier as u128)?
        .checked_add(denominator / 2)?
        / denominator;
    usize::try_from(rounded).ok()
}

/// Composes the camera framing inside the default-cropped `canvas`.
///
/// A valid zoom rectangle limits the available area; a valid aspect ratio then
/// centers the largest rectangle with that ratio inside it. An invalid zoom
/// falls back to the canvas and an invalid aspect ratio keeps a valid zoom.
/// Returns `None` when the result equals the whole canvas.
fn compose_camera_crop(canvas: Dim2, zoom: Option<Rect>, aspect: Option<Dim2>) -> Option<Rect> {
    let full = Rect::new(Point::zero(), canvas);
    if !rect_within(canvas, full) {
        return None;
    }

    let available = zoom
        .filter(|rect| rect_within(canvas, *rect))
        .unwrap_or(full);
    let mut rect = available;

    if let Some(aspect) = aspect.filter(|aspect| aspect.w != 0 && aspect.h != 0) {
        let available_ratio = (available.d.w as u128).checked_mul(aspect.h as u128);
        let target_ratio = (available.d.h as u128).checked_mul(aspect.w as u128);

        if let (Some(available_ratio), Some(target_ratio)) = (available_ratio, target_ratio) {
            let candidate = if available_ratio > target_ratio {
                round_mul_div(available.d.h, aspect.w, aspect.h).and_then(|width| {
                    let width = width.min(available.d.w);
                    let x = available
                        .p
                        .x
                        .checked_add(available.d.w.checked_sub(width)? / 2)?;
                    Some(Rect::new(
                        Point::new(x, available.p.y),
                        Dim2::new(width, available.d.h),
                    ))
                })
            } else if available_ratio < target_ratio {
                round_mul_div(available.d.w, aspect.h, aspect.w).and_then(|height| {
                    let height = height.min(available.d.h);
                    let y = available
                        .p
                        .y
                        .checked_add(available.d.h.checked_sub(height)? / 2)?;
                    Some(Rect::new(
                        Point::new(available.p.x, y),
                        Dim2::new(available.d.w, height),
                    ))
                })
            } else {
                Some(available)
            };

            if let Some(candidate) = candidate.filter(|candidate| rect_within(canvas, *candidate)) {
                rect = candidate;
            }
        }
    }

    (rect != full).then_some(rect)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GFX100RF_BASE: [(u16, [u16; 2]); 2] = [
        (RAW_IMAGE_CROP_TOP_LEFT, [8, 4]),
        (RAW_IMAGE_CROPPED_SIZE, [8736, 11648]),
    ];

    fn short_pair(values: [u16; 2]) -> Vec<u8> {
        [values[0].to_be_bytes(), values[1].to_be_bytes()].concat()
    }

    fn raf_block(entries: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        for (tag, value) in entries {
            bytes.extend_from_slice(&tag.to_be_bytes());
            bytes.extend_from_slice(&(value.len() as u16).to_be_bytes());
            bytes.extend_from_slice(value);
        }
        bytes
    }

    fn raf_file(entries: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut bytes = b"FUJIFILMCCD-RAW 0201FF383501".to_vec();
        bytes.resize(160, 0);
        let block_offset = bytes.len() as u32;
        bytes[RAF_TAGS_PTR_OFFSET..RAF_TAGS_PTR_OFFSET + 4]
            .copy_from_slice(&block_offset.to_be_bytes());
        bytes.extend_from_slice(&raf_block(entries));
        bytes
    }

    fn gfx100rf_entries(extra: &[(u16, Vec<u8>)]) -> Vec<(u16, Vec<u8>)> {
        let mut entries: Vec<(u16, Vec<u8>)> = GFX100RF_BASE
            .iter()
            .map(|(tag, value)| (*tag, short_pair(*value)))
            .collect();
        entries.extend_from_slice(extra);
        entries
    }

    #[test]
    fn camera_crop_composes_aspect_and_zoom() {
        let canvas = Dim2::new(11648, 8736);
        assert_eq!(
            compose_camera_crop(canvas, None, Some(Dim2::new(4, 3))),
            None
        );
        assert_eq!(
            compose_camera_crop(canvas, None, Some(Dim2::new(65, 24))),
            Some(Rect::new(Point::new(0, 2217), Dim2::new(11648, 4301)))
        );
        let zoom = Rect::new(Point::new(1296, 972), Dim2::new(9056, 6792));
        assert_eq!(compose_camera_crop(canvas, Some(zoom), None), Some(zoom));
        assert_eq!(
            compose_camera_crop(canvas, Some(zoom), Some(Dim2::new(17, 6))),
            Some(Rect::new(Point::new(1296, 2770), Dim2::new(9056, 3196)))
        );
    }

    #[test]
    fn camera_crop_falls_back_per_property() {
        let canvas = Dim2::new(11648, 8736);
        let invalid_zoom = Rect::new(Point::new(10000, 8000), Dim2::new(9056, 6792));
        assert_eq!(
            compose_camera_crop(canvas, Some(invalid_zoom), Some(Dim2::new(65, 24))),
            Some(Rect::new(Point::new(0, 2217), Dim2::new(11648, 4301)))
        );
        let valid_zoom = Rect::new(Point::new(3264, 2448), Dim2::new(5120, 3840));
        assert_eq!(
            compose_camera_crop(canvas, Some(valid_zoom), Some(Dim2::new(0, 3))),
            Some(valid_zoom)
        );
    }

    #[test]
    fn camera_crop_rejects_empty_and_overflowing_geometry() {
        assert_eq!(
            compose_camera_crop(Dim2::new(0, 10), None, Some(Dim2::new(1, 1))),
            None
        );
        let overflow = Rect::new(Point::new(usize::MAX, 0), Dim2::new(2, 2));
        assert_eq!(
            compose_camera_crop(Dim2::new(100, 100), Some(overflow), None),
            None
        );
    }

    #[test]
    fn parse_render_tags_uses_fuji_byte_order_and_types() {
        let block = raf_block(&[
            (RAW_IMAGE_ASPECT_RATIO, short_pair([24, 65])),
            (RAW_ZOOM_ACTIVE, 1_u32.to_be_bytes().to_vec()),
            (RAW_ZOOM_TOP_LEFT, short_pair([972, 1296])),
            (RAW_ZOOM_SIZE, short_pair([6792, 9056])),
        ]);
        let tags = parse_framing_tags(&block, 0).unwrap();
        assert_eq!(tags.aspect_ratio, Some([24, 65]));
        assert_eq!(tags.zoom_active, Some(1));
        assert_eq!(tags.zoom_top_left, Some([972, 1296]));
        assert_eq!(tags.zoom_size, Some([6792, 9056]));
    }

    fn assert_malformed_framing_length_is_skipped(tag: u16) {
        let block = raf_block(&[
            (tag, vec![0, 1, 0, 2, 0xff]),
            (RAW_IMAGE_CROPPED_SIZE, short_pair([8736, 11648])),
        ]);
        let tags = parse_framing_tags(&block, 0).unwrap();
        assert_eq!(
            tags,
            RafFramingTags {
                cropped_size: Some([8736, 11648]),
                ..RafFramingTags::default()
            },
            "malformed tag 0x{tag:04x} must be omitted without consuming the following entry",
        );
    }

    #[test]
    fn parse_rejects_malformed_aspect_ratio_length_without_misalignment() {
        assert_malformed_framing_length_is_skipped(RAW_IMAGE_ASPECT_RATIO);
    }

    #[test]
    fn parse_rejects_malformed_zoom_active_length_without_misalignment() {
        assert_malformed_framing_length_is_skipped(RAW_ZOOM_ACTIVE);
    }

    #[test]
    fn parse_rejects_malformed_zoom_top_left_length_without_misalignment() {
        assert_malformed_framing_length_is_skipped(RAW_ZOOM_TOP_LEFT);
    }

    #[test]
    fn parse_rejects_malformed_zoom_size_length_without_misalignment() {
        assert_malformed_framing_length_is_skipped(RAW_ZOOM_SIZE);
    }

    #[test]
    fn parse_skips_unrelated_tags_of_any_length() {
        let block = raf_block(&[
            (0x0100, vec![0; 7]),
            (0x2ff0, vec![1, 2, 3, 4, 5, 6, 7, 8]),
            (RAW_IMAGE_ASPECT_RATIO, short_pair([6, 17])),
        ]);
        assert_eq!(
            parse_framing_tags(&block, 0).unwrap().aspect_ratio,
            Some([6, 17])
        );
    }

    #[test]
    fn parse_rejects_truncated_and_oversized_blocks() {
        let mut truncated = raf_block(&[(RAW_IMAGE_ASPECT_RATIO, short_pair([24, 65]))]);
        truncated.pop();
        assert_eq!(parse_framing_tags(&truncated, 0), None);

        let oversized = (MAX_RAF_TAG_ENTRIES + 1).to_be_bytes().to_vec();
        assert_eq!(parse_framing_tags(&oversized, 0), None);

        assert_eq!(parse_framing_tags(&[0, 0], 0), None);
        assert_eq!(parse_framing_tags(&[], usize::MAX), None);
    }

    #[test]
    fn camera_crop_reads_the_block_from_the_raf_header() {
        let file = raf_file(&gfx100rf_entries(&[(
            RAW_IMAGE_ASPECT_RATIO,
            short_pair([24, 65]),
        )]));
        assert_eq!(
            camera_crop(&file),
            Some(RafCameraCrop {
                canvas: Dim2::new(11648, 8736),
                rect: Rect::new(Point::new(0, 2217), Dim2::new(11648, 4301)),
            })
        );
    }

    #[test]
    fn zoom_is_active_only_for_the_documented_value() {
        let zoom_tags = |active: u32| {
            gfx100rf_entries(&[
                (RAW_ZOOM_ACTIVE, active.to_be_bytes().to_vec()),
                (RAW_ZOOM_TOP_LEFT, short_pair([2448, 3264])),
                (RAW_ZOOM_SIZE, short_pair([3840, 5120])),
            ])
        };
        assert_eq!(
            camera_crop(&raf_file(&zoom_tags(1))).map(|crop| crop.rect),
            Some(Rect::new(Point::new(3264, 2448), Dim2::new(5120, 3840)))
        );
        for inactive in [0, 2, u32::MAX] {
            assert_eq!(camera_crop(&raf_file(&zoom_tags(inactive))), None);
        }
    }

    #[test]
    fn camera_crop_requires_raf_magic_base_crop_and_a_valid_pointer() {
        let aspect = [(RAW_IMAGE_ASPECT_RATIO, short_pair([24, 65]))];

        let mut not_raf = raf_file(&gfx100rf_entries(&aspect));
        not_raf[..8].copy_from_slice(b"NOTAFUJI");
        assert_eq!(camera_crop(&not_raf), None);

        assert_eq!(camera_crop(&raf_file(&aspect)), None);

        let mut dangling = raf_file(&gfx100rf_entries(&aspect));
        dangling[RAF_TAGS_PTR_OFFSET..RAF_TAGS_PTR_OFFSET + 4]
            .copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(camera_crop(&dangling), None);

        assert_eq!(camera_crop(b"FUJIFILM"), None);
    }

    #[test]
    fn full_canvas_framing_is_not_a_camera_crop() {
        let file = raf_file(&gfx100rf_entries(&[(
            RAW_IMAGE_ASPECT_RATIO,
            short_pair([3, 4]),
        )]));
        assert_eq!(camera_crop(&file), None);
        assert_eq!(camera_crop(&raf_file(&gfx100rf_entries(&[]))), None);
    }
}
