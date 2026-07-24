# Fujifilm RAF Render Metadata Design

Date: 2026-07-22
Status: Approved

## Summary

RapidRAW currently develops Fujifilm RAF pixels but drops camera rendering metadata that affects the intended initial exposure and framing. This makes Dynamic Range captures appear underexposed and ignores GFX100RF aspect-ratio and digital-teleconverter crops.

This change extends the forked RapidRAW-DngLab RAF decoder to expose structured render metadata, then consumes it in RapidRAW. RapidRAW will apply Fujifilm Dynamic Range compensation as an intrinsic linear exposure and use the camera framing as the initial editable crop. The user exposure slider remains neutral, and resetting crop reveals the full decoded sensor area.

The goal is Lightroom-style editable RAW behavior for exposure and framing. Pixel-identical camera JPEG color and tone are explicitly out of scope.

## Repository And Branch Model

Both repositories use the same branch topology:

```text
upstream/main
    |
  main
    |
  fork-dev
    |
  cl/vegdog/fix-raf-reading
```

- `main` remains an exact mirror of the corresponding upstream `main`.
- `fork-dev` is the long-lived fork integration branch.
- `cl/vegdog/fix-raf-reading` contains this feature.
- Upstream synchronization and rebasing are manual.
- No workflow, script, or command in this work creates pull requests.
- Pushes target only `lincvic/RapidRAW` and `lincvic/RapidRAW-DngLab`.
- RapidRAW pins the exact RapidRAW-DngLab feature commit rather than a moving branch.

## Evidence

The local GFX100RF sample library covers manual DR200, manual DR400, Auto DR200, portrait orientation, multiple aspect ratios, and three digital-teleconverter sizes. The files remain private local fixtures and are not copied into either repository.

Representative cases:

| File       | Exposure metadata | Aspect | Digital zoom           | Camera JPEG size |
| ---------- | ----------------- | ------ | ---------------------- | ---------------- |
| `DSCF0420` | DR200             | 4:3    | No                     | 11648x8736       |
| `DSCF0581` | DR200             | 65:24  | No                     | 11648x4304       |
| `DSCF0434` | DR400             | 17:6   | 9056x6792 at 1296x972  | 9056x3192        |
| `DSCF0568` | Auto DR200        | 4:3    | 5120x3840 at 3264x2448 | 5120x3840        |
| `DSCF0476` | DR400             | 65:24  | No                     | 11648x4304       |

The RAF base crop is 11648x8736 even when the camera JPEG is 65:24. This proves that `RawImageCropTopLeft` and `RawImageCroppedSize` describe the sensor-border crop, while `RawImageAspectRatio` describes separate camera framing.

`RawExposureBias` varies within the same camera family: DR200 samples contain both -1.5 and -1.7 EV, and DR400 samples contain both -2.5 and -2.7 EV. It therefore includes a baseline component and must not be blindly negated. Dynamic Range compensation comes from the dedicated Dynamic Range tags.

## Scope

### In Scope

- Parse Fujifilm manual and automatic Dynamic Range metadata.
- Parse Fujifilm aspect-ratio and digital-zoom metadata.
- Expose decoder-owned render metadata through rawler's generalized metadata API.
- Apply intrinsic exposure consistently to editable RAW pixels.
- Apply camera framing consistently to editor previews, thumbnails, culling previews, exports, and export-size estimates.
- Preserve existing sidecar adjustments and reset behavior.
- Invalidate thumbnails created before RAF render metadata support.
- Add unit, integration, and local fixture validation.

### Out Of Scope

- Reproducing Fujifilm film simulations or proprietary tone curves.
- Pixel-identical matching to the camera JPEG.
- Applying standard EXIF `ExposureBiasValue` as a rendering correction.
- Using `RawExposureBias` as the Dynamic Range correction.
- Showing the embedded JPEG as a separate preview mode.
- Automated upstream synchronization or pull requests.

## RapidRAW-DngLab Design

### Generalized Render Metadata

Add a defaultable render metadata value to `RawMetadata`. The exact Rust names may be adjusted to match local conventions, but the contract is:

```rust
struct RawRenderMetadata {
    sensor_exposure_comp: Option<SRational>,
    camera_crop: Option<RawCameraCrop>,
}

struct RawCameraCrop {
    canvas: Dim2,
    rect: Rect,
}
```

`canvas` and `rect` use the decoder's default-cropped output coordinate system before EXIF orientation. `camera_crop` is absent when the camera framing equals the entire default-cropped image. All non-RAF decoders receive the default empty value.

Keeping the crop canvas with the rectangle makes the coordinate contract self-contained. Consumers can transform the crop through any EXIF orientation without decoding pixels first.

The coordinate origin is exact: `(0, 0)` is the top-left pixel produced after rawler applies its existing `RawImage.crop_area`. The absolute full-RAF origin from `RawImageCropTopLeft` is not carried into `RawCameraCrop.rect`.

### Exposure Parsing

The RAF decoder reads MakerNote fields in this order:

1. `DevelopmentDynamicRange` (`0x1403`) for manual DR.
2. `AutoDynamicRange` (`0x140b`) when the manual field is absent.

Recognized values map as follows:

| Metadata value | Intrinsic exposure |
| -------------- | ------------------ |
| 100            | 0 EV               |
| 200            | +1 EV              |
| 400            | +2 EV              |
| 800            | +3 EV              |

The implementation accepts only valid power-of-two multiples of 100 in the supported range. A recognized DR100 value produces `Some(0 EV)`, which distinguishes it from missing metadata. Zero, malformed values, and unknown values produce no compensation and do not fail decoding.

`RawExposureBias` (`0x9650`) is not parsed or used by this feature.

### Crop Parsing

Extend the proprietary RAF-block parser with the correct value types:

| Tag      | Type                        | Meaning               |
| -------- | --------------------------- | --------------------- |
| `0x0115` | two big-endian `u16` values | `RawImageAspectRatio` |
| `0x0117` | one big-endian `u32` value  | `RawZoomActive`       |
| `0x0118` | two big-endian `u16` values | `RawZoomTopLeft`      |
| `0x0119` | two big-endian `u16` values | `RawZoomSize`         |

Fuji stores the two-dimensional values in height/width or y/x order. The decoder converts them to width/height and x/y coordinates.

Let the existing absolute base crop be `B = (base_x, base_y, base_width, base_height)`. The default-cropped output canvas is `C = (0, 0, base_width, base_height)`. `RawZoomTopLeft` is already relative to `C`, not to the full RAF origin.

Crop composition is:

1. Use `RawImageCroppedSize` as the dimensions of `C`. `RawImageCropTopLeft` continues to drive rawler's existing base crop but is not added to the camera-crop coordinates.
2. If zoom is active and its rectangle is valid, use `Z = (zoom_x, zoom_y, zoom_width, zoom_height)` directly in `C` coordinates.
3. If a valid aspect ratio is present, center the largest rectangle with that ratio inside the available framing rectangle.
4. Return that rectangle directly in `C` coordinates.
5. Omit `camera_crop` when the result equals `C`.

All arithmetic is checked. Rectangles must be non-empty and contained by the canvas. An invalid zoom rectangle falls back to the canvas; an invalid aspect ratio leaves any valid zoom crop intact.

Aspect crop dimensions use positive checked integer rational arithmetic. When width-limited, height is `round(available_width * ratio_height / ratio_width)`; when height-limited, width is `round(available_height * ratio_width / ratio_height)`. Positive half values round up. Center offsets use floor division, so an odd leftover pixel remains on the right or bottom. The final dimensions are clamped to the available rectangle before the bounds check.

## RapidRAW Design

### RAW Development Result

RAW loading returns the image, decoder render metadata, and a source kind: successfully developed RAW, embedded-preview fallback, or non-RAW. Existing call sites that only need pixels use a compatibility wrapper; editor, thumbnail, and export paths use the metadata-aware result.

The exposure gain is `2^sensor_exposure_comp`. It is applied only after successful RAW calibration, demosaic, and existing RAW artifact preprocessing, but before editor transforms, histogram-driven editing, and tone mapping. Applying it after preprocessing avoids the current preprocessing clamps discarding the compensated highlights. It is not applied to an embedded-JPEG fallback because that JPEG already contains camera rendering.

Intrinsic exposure is not stored in the user exposure adjustment, is not copied by presets, and does not move the visible exposure slider away from zero.

Only the successfully developed RAW source kind receives intrinsic exposure. Embedded-preview fallback and non-RAW pixels receive no RAW exposure gain.

### Metadata Transport

`load_metadata` performs metadata-only parsing from the source path. It creates a `RawSource`, obtains the decoder, and calls `raw_metadata`; it does not decode or allocate the RAW pixel image. A shared RapidRAW helper converts the returned pre-orientation render metadata into camera defaults.

Camera metadata is advisory. If `RawSource` creation, decoder creation, or `raw_metadata` fails, `load_metadata` logs the failure and still returns the successfully loaded sidecar `ImageMetadata` with an empty `cameraDefaults`. Backend metadata-only callers follow the same rule: failure to obtain camera defaults is equivalent to absent defaults and cannot fail thumbnails, previews, exports, or export-size estimation.

The command returns a flattened response that preserves all existing top-level `ImageMetadata` fields:

```rust
struct LoadMetadataResult {
    // Serialized with serde flatten for backward-compatible top-level fields.
    metadata: ImageMetadata,
    camera_defaults: CameraDefaults,
}

struct CameraDefaults {
    crop: Option<Crop>,
    aspect_ratio: Option<f64>,
    canvas_width: Option<u32>,
    canvas_height: Option<u32>,
}
```

The serialized field name is `cameraDefaults`; its fields use camel case. The canvas dimensions are the oriented full default-cropped canvas and are present whenever `crop` is present. They let consumers scale full-resolution camera coordinates onto a reduced RAW development without inferring scale from the filename or crop rectangle. The frontend awaits `load_metadata` before `load_image`, initializes adjustments and history from this response once, and does not depend on completion of pixel decoding. Backend thumbnail and export paths call the same metadata-only helper when they need effective defaults. No new persistent metadata cache is required for the first implementation.

The later `load_image` response includes the authoritative source kind. The frontend records whether `crop` and `aspectRatio` were injected from `cameraDefaults`, as distinct from values read from a sidecar. It also retains the adjustment baseline that current loading behavior would have produced without camera defaults. If RAW decoding used an embedded preview, then before marking the image ready it atomically restores both injected fields from that no-camera-default baseline and replaces the initial history snapshot with the restored state. Undo therefore cannot restore an invalid RAW-space crop. Reconciliation never modifies either field when it came from a persisted sidecar adjustment object. Backend render paths suppress camera defaults for that load.

This metadata-first state machine also applies when the frontend preview cache contains an editor entry. Cached pixels and adjustment state may be shown provisionally, but `load_metadata` completes before the authoritative `load_image` reconciliation, and the selected image is not treated as ready for rendering or saving until both results agree on the effective baseline.

### Orientation-Aware Camera Defaults

RapidRAW converts `RawCameraCrop.rect` from the pre-orientation canvas into the displayed pixel coordinate system using the EXIF orientation. The helper handles all eight EXIF orientations and returns both the oriented canvas dimensions and crop rectangle.

The resulting crop uses RapidRAW's existing `Crop` adjustment representation. `CameraDefaults.aspect_ratio` is explicitly the oriented crop width divided by the oriented crop height, after transforming both canvas and rectangle. The camera ratio is supplied as the initial `aspectRatio` so crop controls display the correct ratio, including for orientations that swap the axes. Camera defaults are valid only for successfully developed RAW pixels.

### Sidecar Precedence

Camera framing is a default, not a destructive sensor crop.

- If sidecar `adjustments` is `null`, RapidRAW initializes `crop` and `aspectRatio` from camera metadata.
- If sidecar `adjustments` is an object, it wins unchanged.
- An empty adjustments object is an explicit user state.
- An explicit `crop: null` reveals the full default-cropped sensor image.
- A saved user crop replaces the camera crop.

The frontend tracks the persisted adjustment value, the effective in-memory baseline, and whether an explicit user action has made the adjustment state dirty. Injecting or reconciling camera defaults is initialization, not a user edit: it must not schedule sidecar auto-save, multi-selection auto-sync, or an edited badge. While the effective state still equals its initialized baseline, the persistence value remains the original sidecar value, including `null`. On the first explicit user adjustment, RapidRAW persists the complete effective adjustment object; at that point the camera crop becomes ordinary saved user state and preserves the rendered appearance. A whole-image Reset Adjustments operation that restores sidecar adjustments to `null` re-establishes a fresh camera-default baseline without immediately saving it back.

The camera crop becomes a regular editable crop after initialization. Reset Crop sets `crop` to `null` and sets `aspectRatio` to the oriented full-canvas width divided by height. This reveals the full image and prevents crop controls from immediately reconstructing the camera ratio.

The Tauri metadata response carries camera defaults separately from persisted `ImageMetadata`, so ephemeral decoder metadata is not accidentally serialized as a new sidecar field. The response can preserve the existing top-level metadata shape for current callers while adding a `cameraDefaults` field.

### Shared Effective Adjustments

Create one backend helper that combines persisted adjustments, camera defaults, and source kind according to the precedence rules. It applies defaults only to successfully developed RAW pixels. Use it wherever rendering can occur without first opening the editor:

- Thumbnail generation.
- Culling preview generation.
- Standalone preview generation.
- Batch export.
- Export-size estimation.

Current-editor rendering uses the initialized frontend adjustment state. Backend render paths use the same helper so an unopened RAF is framed the same way as an opened RAF.

The helper also receives the actual developed image dimensions after RapidRAW has applied the same built-in EXIF orientation used to create `cameraDefaults`. Both dimension pairs therefore share the displayed, oriented coordinate space. When the dimensions differ from `cameraDefaults.canvasWidth` and `cameraDefaults.canvasHeight`, it scales `crop.x` and `crop.width` by `developed_width / canvas_width`, and scales `crop.y` and `crop.height` by `developed_height / canvas_height`, before rendering. This covers fast demosaic output used by thumbnails and export estimates, including orientations that swap the axes. Zero canvas dimensions or a scaled rectangle outside the developed image suppress the camera crop rather than failing the render.

The edited/unmodified badge continues to be calculated from persisted user adjustments, not the ephemeral effective defaults.

### Caching

- The decoded base-image cache entry contains both the pixels with intrinsic exposure already applied and the authoritative source kind. Every cache hit returns the stored source kind; a cache hit must never infer `DevelopedRaw` from the file extension or requested path. Cache versioning invalidates any older entry that lacks source kind.
- Camera crop remains non-destructive and participates in the effective adjustment and geometry hashes.
- Add a render-version salt to the persistent thumbnail cache hash so thumbnails produced before this feature are regenerated.
- Embedded-preview fallback and non-RAW cache behavior remain unchanged.

## Error Handling

RAF render metadata is advisory. Failure to parse it must never turn a decodable RAW into an error.

- Missing metadata: retain current RapidRAW behavior for that property.
- Unknown DR value: log at debug or warning level and apply no intrinsic EV.
- Invalid zoom rectangle: ignore zoom and continue with the base canvas.
- Invalid aspect ratio: ignore the ratio while retaining a valid zoom crop.
- Out-of-bounds final crop: reject the camera crop and render the full canvas.
- Legacy Fuji rotated-sensor modes whose decoded output does not use the default-cropped coordinate system: suppress camera crop metadata while retaining valid exposure metadata.
- Embedded-JPEG fallback: apply neither RAW exposure compensation nor RAW-space camera crop. Return current fallback framing and atomically restore both provisionally injected crop fields as defined in Metadata Transport.
- Non-Fuji and non-RAW images: no behavioral change.

## Testing

### RapidRAW-DngLab Unit Tests

- Decode the new RAF tag value types and byte order.
- Map manual DR100/200/400/800 values.
- Fall back to Auto DR only when manual DR is absent.
- Return `Some(0 EV)` for DR100 and reject malformed or unsupported DR values.
- Compose base, aspect-only, zoom-only, and zoom-plus-aspect crops.
- Validate crop bounds and fallback behavior.
- Confirm non-RAF `RawMetadata` defaults remain empty.

Parser and crop tests use synthetic values and do not require private images.

### RapidRAW Unit Tests

- Apply all eight EXIF orientation transforms to a camera crop.
- Merge camera defaults only when adjustments are null.
- Preserve saved crops, empty adjustment objects, and explicit null crops.
- Keep camera-default initialization clean and unsaved until an explicit user edit.
- Persist the complete effective state after the first user edit and re-establish defaults after Reset Adjustments.
- Scale camera crops from their oriented canvas onto reduced developed-image dimensions.
- Scale a rotated reduced-resolution RAW in the oriented coordinate space without swapping axes twice.
- Keep cached effective adjustments distinct from the persisted sidecar value and block saving until metadata and authoritative source kind reconcile.
- On an embedded-preview cache hit, retain the cached source kind, restore both injected crop fields, replace history atomically, and preserve all persisted sidecar fields.
- Apply the expected linear gain for 0, +1, +2, and +3 EV.
- Skip intrinsic gain for non-RAW and embedded-preview fallback paths.
- Include camera crop in geometry/cache keys and invalidate legacy thumbnails.

### Local Integration Tests

Use the representative GFX100RF RAF/JPEG pairs listed above from an external fixture directory. Tests or validation utilities accept the directory through an environment variable and skip with a clear message when it is absent. They never copy or commit the source photos.

Validation checks:

- Extracted manual and automatic DR values produce the expected EV.
- Crop rectangles stay within the 11648x8736 default-cropped canvas.
- Aspect-only and zoom-plus-aspect crop dimensions differ from the paired camera JPEG dimensions by no more than 8 pixels per axis. Center origins differ by no more than 4 pixels after accounting for that dimension difference.
- Normal and rotated samples produce the correct displayed crop.
- Editor preview, thumbnail, and export use equivalent framing.
- The validation utility reports paired corrected/uncorrected median log-luminance deltas in EV for manual inspection. Because camera JPEG tone curves and film simulations are out of scope, JPEG brightness closeness has no automated pass threshold. Automated acceptance instead verifies the decoded DR value and exact linear gain independently.

### Repository Verification

- Run focused rawler tests and the rawler test suite appropriate to the touched crate.
- Run RapidRAW Rust formatting, focused Rust tests, and the relevant frontend type/lint checks.
- Build the RapidRAW Rust crate against the exact pinned decoder commit.
- Inspect representative outputs in RapidRAW before declaring completion.

## Success Criteria

1. DR200 and Auto DR200 RAF files receive +1 EV; DR400 files receive +2 EV.
2. The visible exposure slider remains zero before user edits.
3. GFX100RF aspect-only and digital-zoom crops appear on first preview.
4. Reset Crop reveals the complete default-cropped sensor image and restores its oriented full-canvas aspect ratio.
5. Preview, thumbnail, and export framing agree.
6. Existing saved user adjustments take precedence.
7. Malformed or absent Fuji metadata degrades to current behavior without breaking decode.
8. Other camera formats do not change.
9. No private fixture is committed.
10. No pull request is created against either upstream repository.
