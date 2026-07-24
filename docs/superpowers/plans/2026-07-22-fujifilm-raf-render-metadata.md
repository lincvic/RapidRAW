# Fujifilm RAF Render Metadata Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fujifilm RAF development honor camera Dynamic Range exposure compensation and initial aspect/digital-zoom framing everywhere RapidRAW renders an editable RAW.

**Architecture:** RapidRAW-DngLab exposes advisory, pre-orientation render metadata without changing decoded pixels. RapidRAW applies the intrinsic linear gain to successfully developed RAW pixels, converts camera crop coordinates through EXIF orientation, and merges the crop only when persisted adjustments are null. A source-kind value and an explicit frontend persistence baseline prevent embedded previews and cached editor state from receiving or saving RAW-only defaults.

**Tech Stack:** Rust 2024, rawler/RapidRAW-DngLab, Tauri 2, `image`, serde/serde_json, React 19, TypeScript 6, Zustand, Vitest, Cargo test, private GFX100RF RAF/JPEG fixtures.

---

## Working Agreement

- RapidRAW repository: `/Users/laynewang/Documents/RustProjects/RapidRAW`
- Decoder repository: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab`
- Work only on `cl/vegdog/fix-raf-reading` in both repositories.
- Push only to `https://github.com/lincvic/RapidRAW` and `https://github.com/lincvic/RapidRAW-DngLab`.
- Never create a pull request and never push to either original repository.
- Keep `main` and `fork-dev` unchanged; upstream synchronization remains manual.
- Keep `/Users/laynewang/Documents/PhotoBooth/pre` private. Tests may read it through `RAPIDRAW_RAF_FIXTURE_DIR`; no photo or existing `.rrdata` file may be staged.
- Implement decoder tasks first, push the decoder feature commit, then pin that exact commit in RapidRAW.
- Follow @test-driven-development for every behavior change and @verification-before-completion before any completion claim.

### Rust Toolchain Bootstrap

Homebrew's `rustup` is keg-only. Before running any Rust command in either repository, initialize the current task shell without editing shell startup files:

```bash
brew list rustup >/dev/null 2>&1 || brew install rustup
export PATH="$(brew --prefix rustup)/bin:$PATH"
export RUSTUP_TOOLCHAIN=1.96.1
rustup toolchain install 1.96.1 --profile minimal
rustup component add rustfmt clippy --toolchain 1.96.1
rustc --version
```

Expected: `rustc 1.96.1`. The formula, toolchain, `rustfmt`, and `clippy` are already installed on this workstation; the guard keeps future execution reproducible without selecting a global default toolchain.

## Fixed Contract Decisions

- Serialized source kinds are exactly `developed_raw`, `embedded_preview`, and `non_raw`.
- Any persisted adjustments object, including `{}` or `{ "crop": null }`, wins over camera defaults. Only literal JSON `null` receives camera defaults.
- A frontend pixel crop adds `unit: "px"`; the Rust `Crop` remains `{x,y,width,height}`.
- Opening an untouched RAF must not write a sidecar. The first explicit user edit persists the complete effective adjustment object. Returning exactly to the initial baseline serializes the original persisted value.
- Reset Crop persists `crop: null` plus the oriented full-canvas ratio. Existing rotation/transform reset behavior in that control remains otherwise unchanged.
- Reset Adjustments writes literal JSON `null`, reloads the camera-default baseline, and does not immediately auto-save it.
- `cameraDefaults.canvasWidth` and `canvasHeight` and developed image dimensions are all post-EXIF-orientation values.
- Fast RAW crops scale independently by the oriented x/y dimension ratios and are rejected if the scaled rectangle is invalid.
- `RawZoomActive` is active only when its parsed value equals `1`; unknown nonzero values are advisory metadata and do not activate a zoom crop.
- Legacy `fuji_rotation` and `fuji_rotation_alt` modes expose valid exposure metadata but suppress camera crop metadata because their pixel coordinates do not follow the modern default-cropped contract.

## File Map

### RapidRAW-DngLab

- Modify `rawler/src/imgop/mod.rs`: make `Dim2`, `Point`, and `Rect` orderable so render metadata can preserve `RawMetadata`'s existing ordering traits.
- Modify `rawler/src/decoders/mod.rs`: define generalized render metadata and attach its default to every `RawMetadata` constructor.
- Modify `rawler/src/decoders/raf.rs`: parse Fuji render tags, map Dynamic Range, compose camera crop, and add focused unit tests.
- Create `rawler/tests/raf_render_metadata.rs`: environment-gated validation against private RAF/JPEG pairs.

### RapidRAW Backend

- Modify `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`: pin the exact forked rawler commit.
- Create `src-tauri/src/camera_defaults.rs`: source-kind DTO, orientation conversion, non-failing metadata extraction, crop scaling, and effective-adjustment precedence.
- Modify `src-tauri/src/lib.rs`: register the module and make standalone previews resolve effective adjustments.
- Modify `src-tauri/src/raw_processing.rs`: return decoder render metadata with developed pixels.
- Modify `src-tauri/src/image_loader.rs`: return metadata-aware base loads, apply intrinsic exposure after RAW preprocessing, and report authoritative source kind.
- Modify `src-tauri/src/cache_utils.rs`: retain source kind in decoded-image cache entries and include render-version salt in hashes.
- Modify `src-tauri/src/app_state.rs`: retain source kind on `LoadedImage` and pass metadata-aware preloaded images.
- Modify `src-tauri/src/image_processing.rs`: make `Crop` comparable for tests without changing its serialized shape.
- Modify `src-tauri/src/file_management.rs`: flatten `cameraDefaults` into `load_metadata`, apply defaults to thumbnails, reset adjustments to null, and salt persistent thumbnails.
- Modify `src-tauri/src/export_processing.rs`: use the same effective defaults for unopened exports and export-size estimates.
- Create `src-tauri/src/raf_fixture_tests.rs`: crate-level, environment-gated integration checks for app conversion and intrinsic gain.

### RapidRAW Frontend

- Modify `package.json` and `package-lock.json`: add the Vitest test runner and scripts.
- Create `src/types/imageLoading.ts`: typed metadata/image DTOs, source kind, and adjustment-load context.
- Create `src/utils/rafCameraDefaults.ts` and `src/utils/rafCameraDefaults.test.ts`: pure initialization, reconciliation, and persistence rules.
- Modify `src/store/useEditorStore.ts`: store load provenance/dirty state and reconcile history atomically.
- Create `src/services/editorPersistence.ts`: own the shared history debounce and awaitable per-path save queue.
- Modify `src/hooks/useEditorActions.ts`: mark only explicit user changes dirty and serialize null baselines correctly.
- Modify `src/hooks/useImageProcessing.ts`: block auto-save/auto-sync until reconciliation and skip unchanged camera defaults.
- Modify `src/hooks/useImageLoader.ts`: make metadata-first loading the sole editor load coordinator.
- Modify `src/hooks/useAppNavigation.ts`: route cached selections through the same coordinator.
- Modify `src/utils/ImageLRUCache.ts`: cache authoritative source kind and load context without treating effective state as persisted state.
- Modify `src/components/ui/AppProperties.tsx`: type `SelectedImage.sourceKind`.
- Modify `src/utils/cropUtils.ts` and create `src/utils/cropUtils.test.ts`: support a local full-canvas crop overlay without materializing a persisted crop.
- Modify `src/components/panel/Editor.tsx`: preserve `crop: null` after Reset Crop.
- Modify `src/components/panel/library/CullingView.tsx` and `src/components/modals/CollageModal.tsx`: let backend-owned previews load effective adjustments.

## Chunk 1: Decoder Metadata Contract

### Task 1: Add Generalized Raw Render Metadata

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab/rawler/src/imgop/mod.rs:49`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab/rawler/src/decoders/mod.rs:240`

- [ ] **Step 1: Write failing constructor and serialization tests**

Add an inline `decoders::tests` module. The tests require an empty default and prevent the advisory field from changing existing analyzer snapshots:

```rust
#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn raw_render_metadata_defaults_empty() {
    let metadata = RawMetadata::new(&Camera::default(), Exif::default());
    assert_eq!(metadata.render_metadata, RawRenderMetadata::default());
  }

  #[test]
  fn raw_render_metadata_is_not_in_analyzer_serialization() {
    let mut metadata = RawMetadata::new(&Camera::default(), Exif::default());
    metadata.render_metadata.sensor_exposure_comp = Some(SRational::new(1, 1));
    let yaml = serde_yaml::to_string(&metadata).unwrap();
    assert!(!yaml.contains("render_metadata"));
  }
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run from `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab`:

```bash
cargo test -p rawler --lib decoders::tests -- --nocapture
```

Expected: compilation fails because `RawRenderMetadata` and `RawMetadata.render_metadata` do not exist.

- [ ] **Step 3: Add the minimal generalized types**

Import `SRational`, then add:

```rust
#[derive(Default, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct RawRenderMetadata {
  pub sensor_exposure_comp: Option<SRational>,
  pub camera_crop: Option<RawCameraCrop>,
}

#[derive(Default, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct RawCameraCrop {
  pub canvas: Dim2,
  pub rect: Rect,
}
```

Extend the existing geometry derives with `PartialOrd, Ord`, and add the advisory field to `RawMetadata`:

```rust
#[serde(skip)]
pub render_metadata: RawRenderMetadata,
```

Initialize it with `RawRenderMetadata::default()` in both `RawMetadata::new` and `RawMetadata::new_with_lens`. Do not alter existing EXIF fields or serialized snapshots.

- [ ] **Step 4: Run focused tests and formatting**

```bash
cargo test -p rawler --lib decoders::tests -- --nocapture
cargo fmt --all
cargo fmt --all -- --check
```

Expected: both decoder tests pass and formatting reports no diff.

- [ ] **Step 5: Commit the API contract**

```bash
git add rawler/src/imgop/mod.rs rawler/src/decoders/mod.rs
git commit -m "feat(rawler): add raw render metadata API"
```

### Task 2: Parse RAF Aspect And Zoom Tag Types

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab/rawler/src/decoders/raf.rs:77`
- Test: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab/rawler/src/decoders/raf.rs`

- [ ] **Step 1: Add a synthetic RAF-block test**

Create the inline test module at the end of `raf.rs`, then build a block without using private images. Tasks 3 and 4 add their tests to this same module:

```rust
#[cfg(test)]
mod tests {
  use super::*;

  fn raf_block(entries: &[(u16, Vec<u8>)]) -> RawSource {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (tag, value) in entries {
      bytes.extend_from_slice(&tag.to_be_bytes());
      bytes.extend_from_slice(&(value.len() as u16).to_be_bytes());
      bytes.extend_from_slice(value);
    }
    RawSource::new_from_slice(&bytes)
  }

  #[test]
  fn parse_render_tags_uses_fuji_byte_order_and_types() {
    let source = raf_block(&[
      (0x0115, [24_u16.to_be_bytes(), 65_u16.to_be_bytes()].concat()),
      (0x0117, 1_u32.to_be_bytes().to_vec()),
      (0x0118, [972_u16.to_be_bytes(), 1296_u16.to_be_bytes()].concat()),
      (0x0119, [6792_u16.to_be_bytes(), 9056_u16.to_be_bytes()].concat()),
    ]);
    let ifd = parse_raf_format(&source, 0).unwrap();
    assert!(matches!(ifd.get_entry(RafTags::RawImageAspectRatio).unwrap().value, Value::Short(ref v) if v == &[24, 65]));
    assert!(matches!(ifd.get_entry(RafTags::RawZoomActive).unwrap().value, Value::Long(ref v) if v == &[1]));
    assert!(matches!(ifd.get_entry(RafTags::RawZoomTopLeft).unwrap().value, Value::Short(ref v) if v == &[972, 1296]));
    assert!(matches!(ifd.get_entry(RafTags::RawZoomSize).unwrap().value, Value::Short(ref v) if v == &[6792, 9056]));
  }
}
```

- [ ] **Step 2: Run the exact test and verify it fails**

```bash
cargo test -p rawler --lib decoders::raf::tests::parse_render_tags_uses_fuji_byte_order_and_types -- --exact
```

Expected: compilation fails because the three zoom `RafTags` variants do not exist.

- [ ] **Step 3: Add tag variants and parser arms**

Add:

```rust
RawZoomActive = 0x0117,
RawZoomTopLeft = 0x0118,
RawZoomSize = 0x0119,
```

Parse `RawZoomTopLeft` and `RawZoomSize` in the existing big-endian `Value::Short` arm. Parse `RawZoomActive` in a new big-endian `Value::Long` arm. Keep `RAFData` in its existing little-endian arm.

- [ ] **Step 4: Re-run the exact parser test**

```bash
cargo test -p rawler --lib decoders::raf::tests::parse_render_tags_uses_fuji_byte_order_and_types -- --exact
```

Expected: PASS.

- [ ] **Step 5: Commit parsed framing tags**

```bash
git add rawler/src/decoders/raf.rs
git commit -m "feat(rawler): parse RAF camera framing tags"
```

### Task 3: Map Fujifilm Dynamic Range Metadata

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab/rawler/src/decoders/raf.rs:400`
- Test: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab/rawler/src/decoders/raf.rs`

- [ ] **Step 1: Add failing pure mapping tests**

```rust
#[test]
fn dynamic_range_maps_supported_values() {
  assert_eq!(dynamic_range_value(100), Some(SRational::new(0, 1)));
  assert_eq!(dynamic_range_value(200), Some(SRational::new(1, 1)));
  assert_eq!(dynamic_range_value(400), Some(SRational::new(2, 1)));
  assert_eq!(dynamic_range_value(800), Some(SRational::new(3, 1)));
}

#[test]
fn dynamic_range_uses_auto_only_when_manual_is_absent() {
  let manual = Entry { tag: 0x1403, value: Value::Short(vec![400]), embedded: None };
  let auto = Entry { tag: 0x140b, value: Value::Short(vec![200]), embedded: None };
  assert_eq!(dynamic_range_comp(None, Some(&auto)), Some(SRational::new(1, 1)));
  assert_eq!(dynamic_range_comp(Some(&manual), Some(&auto)), Some(SRational::new(2, 1)));
}

#[test]
fn dynamic_range_rejects_unknown_and_present_malformed_manual_values() {
  for value in [0, 50, 300, 1600, u32::MAX] {
    assert_eq!(dynamic_range_value(value), None);
  }

  let auto = Entry { tag: 0x140b, value: Value::Short(vec![200]), embedded: None };
  let malformed = [
    Value::Short(vec![]),
    Value::Short(vec![400, 800]),
    Value::Rational(vec![Rational::new(400, 1)]),
  ];
  for value in malformed {
    let manual = Entry { tag: 0x1403, value, embedded: None };
    assert_eq!(dynamic_range_comp(Some(&manual), Some(&auto)), None);
  }
}
```

- [ ] **Step 2: Verify the mapping tests fail**

```bash
cargo test -p rawler --lib decoders::raf::tests::dynamic_range -- --nocapture
```

Expected: compilation fails because `dynamic_range_comp` is undefined.

- [ ] **Step 3: Implement the minimal mapping and safe entry reader**

```rust
fn dynamic_range_value(value: u32) -> Option<SRational> {
  match value {
    100 => Some(SRational::new(0, 1)),
    200 => Some(SRational::new(1, 1)),
    400 => Some(SRational::new(2, 1)),
    800 => Some(SRational::new(3, 1)),
    _ => None,
  }
}

fn scalar_u32(entry: &Entry) -> Option<u32> {
  match &entry.value {
    Value::Byte(values) if values.len() == 1 => Some(u32::from(values[0])),
    Value::Short(values) if values.len() == 1 => Some(u32::from(values[0])),
    Value::Long(values) if values.len() == 1 => Some(values[0]),
    _ => None,
  }
}

fn dynamic_range_comp(manual: Option<&Entry>, auto: Option<&Entry>) -> Option<SRational> {
  match manual {
    Some(entry) => scalar_u32(entry).and_then(dynamic_range_value),
    None => scalar_u32(auto?).and_then(dynamic_range_value),
  }
}
```

In `RafDecoder::raw_metadata`, make `mdata` mutable and call `dynamic_range_comp` with the optional MakerNote entries themselves. Passing the entries, rather than already converted values, preserves the difference between an absent manual tag and a present malformed tag. Assign `mdata.render_metadata.sensor_exposure_comp` and return `Ok(mdata)`. Do not read `ExposureBiasValue` or `RawExposureBias`.

- [ ] **Step 4: Run all RAF unit tests**

```bash
cargo test -p rawler --lib decoders::raf::tests -- --nocapture
```

Expected: all parser and Dynamic Range tests pass.

- [ ] **Step 5: Commit Dynamic Range metadata**

```bash
git add rawler/src/decoders/raf.rs
git commit -m "feat(rawler): expose Fujifilm DR compensation"
```

### Task 4: Compose Camera Crop In Default-Cropped Coordinates

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab/rawler/src/decoders/raf.rs:484`
- Test: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab/rawler/src/decoders/raf.rs`

- [ ] **Step 1: Add failing deterministic crop tests**

```rust
#[test]
fn camera_crop_composes_aspect_and_zoom() {
  let canvas = Dim2::new(11648, 8736);
  assert_eq!(compose_camera_crop(canvas, None, Some(Dim2::new(4, 3))), None);
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
  assert_eq!(compose_camera_crop(canvas, Some(valid_zoom), Some(Dim2::new(0, 3))), Some(valid_zoom));
}

#[test]
fn camera_crop_rejects_empty_and_overflowing_geometry() {
  assert_eq!(compose_camera_crop(Dim2::new(0, 10), None, Some(Dim2::new(1, 1))), None);
  let overflow = Rect::new(Point::new(usize::MAX, 0), Dim2::new(2, 2));
  assert_eq!(compose_camera_crop(Dim2::new(100, 100), Some(overflow), None), None);
}
```

- [ ] **Step 2: Run crop tests and verify they fail**

```bash
cargo test -p rawler --lib decoders::raf::tests::camera_crop -- --nocapture
```

Expected: compilation fails because `compose_camera_crop` is undefined.

- [ ] **Step 3: Implement checked half-up crop composition**

Implement `rect_within`, `round_mul_div`, and `compose_camera_crop`. Use `u128` checked products for ratio comparisons and multiplication. Positive half values round up by adding `denominator / 2` before division. Use floor division for centered x/y offsets, validate each `checked_add`, and return `None` when the final rectangle equals the whole canvas.

Add the exact pair decoder; malformed lengths and non-Short values are absent metadata:

```rust
fn short_pair(entry: Option<&Entry>) -> Option<[u16; 2]> {
  match &entry?.value {
    Value::Short(values) if values.len() == 2 => Some([values[0], values[1]]),
    _ => None,
  }
}
```

Read the proprietary fields as follows:

```rust
let canvas = Dim2::new(base_crop.d.w, base_crop.d.h);
let aspect = short_pair(raf.get_entry(RafTags::RawImageAspectRatio))
  .map(|[h, w]| Dim2::new(w as usize, h as usize));
let zoom = (raf.get_entry(RafTags::RawZoomActive).and_then(scalar_u32) == Some(1))
  .then(|| {
    let [y, x] = short_pair(raf.get_entry(RafTags::RawZoomTopLeft))?;
    let [h, w] = short_pair(raf.get_entry(RafTags::RawZoomSize))?;
    Some(Rect::new(Point::new(x.into(), y.into()), Dim2::new(w.into(), h.into())))
  })
  .flatten();
```

The camera rectangle is relative to `(0,0)` of the base-cropped canvas. Do not add `base_crop.p`. Populate `RawCameraCrop { canvas, rect }` in `raw_metadata`, and suppress it for `fuji_rotation`/`fuji_rotation_alt` camera hints.

- [ ] **Step 4: Run RAF and generalized metadata tests**

```bash
cargo test -p rawler --lib decoders::raf::tests -- --nocapture
cargo test -p rawler --lib decoders::tests -- --nocapture
```

Expected: all focused tests pass, including exact 65:24 and 17:6 rectangles.

- [ ] **Step 5: Commit camera crop metadata**

```bash
git add rawler/src/decoders/raf.rs
git commit -m "feat(rawler): expose Fujifilm camera crop"
```

### Task 5: Validate Private GFX100RF Fixtures And Publish Decoder Commit

**Files:**

- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab/rawler/tests/raf_render_metadata.rs`

- [ ] **Step 1: Write the environment-gated integration test**

Use `RAPIDRAW_RAF_FIXTURE_DIR` as the directory containing root JPEGs and the `raw/` subfolder. A missing variable prints `SKIP: set RAPIDRAW_RAF_FIXTURE_DIR` and returns successfully. Add this executable test:

```rust
use image::GenericImageView;
use rawler::decoders::{Orientation, RawDecodeParams};
use rawler::rawsource::RawSource;
use std::path::{Path, PathBuf};

struct Case {
  stem: &'static str,
  ev: i32,
  frame: (usize, usize, usize, usize),
  expected_crop: Option<(usize, usize, usize, usize)>,
}

fn displayed_dims(width: usize, height: usize, orientation: Orientation) -> (usize, usize) {
  if orientation.to_flips().0 { (height, width) } else { (width, height) }
}

fn fixture_root() -> Option<PathBuf> {
  std::env::var_os("RAPIDRAW_RAF_FIXTURE_DIR").map(PathBuf::from)
}

#[test]
fn gfx100rf_render_metadata_matches_private_pairs() {
  let Some(root) = fixture_root() else {
    eprintln!("SKIP: set RAPIDRAW_RAF_FIXTURE_DIR");
    return;
  };
  let cases = [
    Case { stem: "DSCF0420", ev: 1, frame: (0, 0, 11648, 8736), expected_crop: None },
    Case { stem: "DSCF0581", ev: 1, frame: (0, 0, 11648, 8736), expected_crop: Some((0, 2217, 11648, 4301)) },
    Case { stem: "DSCF0434", ev: 2, frame: (1296, 972, 9056, 6792), expected_crop: Some((1296, 2770, 9056, 3196)) },
    Case { stem: "DSCF0568", ev: 1, frame: (3264, 2448, 5120, 3840), expected_crop: Some((3264, 2448, 5120, 3840)) },
    Case { stem: "DSCF0476", ev: 2, frame: (0, 0, 11648, 8736), expected_crop: Some((0, 2217, 11648, 4301)) },
  ];

  for case in cases {
    let raw_path = root.join("raw").join(format!("{}.RAF", case.stem));
    let jpeg_path = root.join(format!("{}.JPG", case.stem));
    assert!(raw_path.is_file(), "missing {}", raw_path.display());
    assert!(jpeg_path.is_file(), "missing {}", jpeg_path.display());

    let source = RawSource::new(Path::new(&raw_path)).unwrap();
    let decoder = rawler::get_decoder(&source).unwrap();
    let metadata = decoder.raw_metadata(&source, &RawDecodeParams::default()).unwrap();
    let exposure = metadata.render_metadata.sensor_exposure_comp.unwrap();
    assert_eq!((exposure.n, exposure.d), (case.ev, 1), "{}", case.stem);

    let orientation = metadata
      .exif
      .orientation
      .map(Orientation::from_u16)
      .unwrap_or(Orientation::Normal);
    let jpeg = image::open(&jpeg_path).unwrap();
    let jpeg_dims = (jpeg.width() as usize, jpeg.height() as usize);

    match (metadata.render_metadata.camera_crop, case.expected_crop) {
      (None, None) => {
        assert!(jpeg_dims.0.abs_diff(case.frame.2) <= 8, "{} width", case.stem);
        assert!(jpeg_dims.1.abs_diff(case.frame.3) <= 8, "{} height", case.stem);
        assert_eq!(
          displayed_dims(jpeg_dims.0, jpeg_dims.1, orientation),
          displayed_dims(case.frame.2, case.frame.3, orientation)
        );
      }
      (Some(camera), Some((x, y, width, height))) => {
        assert_eq!(camera.canvas, rawler::imgop::Dim2::new(11648, 8736));
        assert_eq!((camera.rect.p.x, camera.rect.p.y, camera.rect.d.w, camera.rect.d.h), (x, y, width, height));
        assert!(camera.rect.p.x.checked_add(camera.rect.d.w).unwrap() <= camera.canvas.w);
        assert!(camera.rect.p.y.checked_add(camera.rect.d.h).unwrap() <= camera.canvas.h);
        assert!(jpeg_dims.0.abs_diff(camera.rect.d.w) <= 8, "{} width", case.stem);
        assert!(jpeg_dims.1.abs_diff(camera.rect.d.h) <= 8, "{} height", case.stem);
        let jpeg_x = case.frame.0 + (case.frame.2 - jpeg_dims.0) / 2;
        let jpeg_y = case.frame.1 + (case.frame.3 - jpeg_dims.1) / 2;
        assert!(jpeg_x.abs_diff(camera.rect.p.x) <= 4, "{} x origin", case.stem);
        assert!(jpeg_y.abs_diff(camera.rect.p.y) <= 4, "{} y origin", case.stem);
        let oriented_crop = displayed_dims(camera.rect.d.w, camera.rect.d.h, orientation);
        let oriented_jpeg = displayed_dims(jpeg_dims.0, jpeg_dims.1, orientation);
        assert!(oriented_crop.0.abs_diff(oriented_jpeg.0) <= 8, "{} displayed width", case.stem);
        assert!(oriented_crop.1.abs_diff(oriented_jpeg.1) <= 8, "{} displayed height", case.stem);
      }
      (actual, expected) => panic!("{} crop mismatch: actual={actual:?}, expected={expected:?}", case.stem),
    }
  }
}
```

The displayed-dimension assertions compare the oriented camera crop to the oriented JPEG dimensions within the same 8-pixel tolerance.

- [ ] **Step 2: Run fixture validation**

```bash
RAPIDRAW_RAF_FIXTURE_DIR=/Users/laynewang/Documents/PhotoBooth/pre cargo test -p rawler --test raf_render_metadata -- --nocapture
```

Expected: all five private cases pass; the test output contains no copied fixture data.

- [ ] **Step 3: Run decoder repository verification**

```bash
cargo fmt --all -- --check
cargo test -p rawler --lib
cargo test -p rawler
cargo check -p rawler
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 4: Confirm only source/tests are staged and commit**

```bash
git status --short
git add rawler/tests/raf_render_metadata.rs
git commit -m "test(rawler): validate GFX100RF render metadata"
```

Expected: no `.RAF`, `.JPG`, or `.rrdata` file appears in `git status` or the commit.

- [ ] **Step 5: Push only the decoder fork feature branch and record the immutable revision**

```bash
[[ "$(git remote get-url --push origin)" == "https://github.com/lincvic/RapidRAW-DngLab" ]]
git push origin cl/vegdog/fix-raf-reading
git rev-parse HEAD
```

Expected: the push target is `github.com/lincvic/RapidRAW-DngLab`, and `git rev-parse HEAD` prints the revision to pin in RapidRAW Task 6.

## Chunk 2: RapidRAW Backend Integration

### Task 6: Pin The Forked Decoder Revision

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/Cargo.toml:27`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/Cargo.lock:5039`

- [ ] **Step 1: Verify the decoder revision exists only on the fork feature branch**

Run in `/Users/laynewang/Documents/RustProjects/RapidRAW-DngLab`:

```bash
git status --short --branch
git remote get-url --push origin
git rev-parse HEAD
git ls-remote origin refs/heads/cl/vegdog/fix-raf-reading
```

Expected: the worktree is clean, the push URL is `https://github.com/lincvic/RapidRAW-DngLab`, and the local/remote 40-character revisions match. Record that literal revision for the next step.

- [ ] **Step 2: Replace the moving upstream dependency with the immutable fork revision**

In RapidRAW `src-tauri/Cargo.toml`, set the dependency to:

```toml
rawler = { git = "https://github.com/lincvic/RapidRAW-DngLab.git", rev = "the literal 40-character revision recorded in Step 1" }
```

The implementation must replace the quoted description with the actual revision; a branch name is not accepted.

- [ ] **Step 3: Refresh only the rawler lock entry**

Run from `/Users/laynewang/Documents/RustProjects/RapidRAW`:

```bash
cargo update --manifest-path src-tauri/Cargo.toml -p rawler
cargo check --manifest-path src-tauri/Cargo.toml --lib
```

Expected: `Cargo.lock` resolves rawler from `github.com/lincvic/RapidRAW-DngLab` with the same `rev`, and RapidRAW compiles before consuming the new API.

- [ ] **Step 4: Check the dependency diff and commit**

```bash
git diff --check
git diff -- src-tauri/Cargo.toml src-tauri/Cargo.lock
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build: pin forked rawler render metadata revision"
```

Expected: no unrelated package is upgraded.

### Task 7: Convert Decoder Metadata Into Camera Defaults

**Files:**

- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/camera_defaults.rs`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/lib.rs:1`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/image_processing.rs:75`

- [ ] **Step 1: Write failing orientation and scaling tests**

Create `camera_defaults.rs` with the test module first. Use a 10x6 pre-orientation canvas and `(2,1,3,2)` rectangle:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rawler::imgop::{Dim2, Point, Rect};

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
                (oriented.canvas.w, oriented.canvas.h, oriented.rect.p.x, oriented.rect.p.y,
                 oriented.rect.d.w, oriented.rect.d.h),
                expected
            );
        }
    }

    #[test]
    fn scales_in_the_oriented_coordinate_space() {
        let defaults = CameraDefaults {
            crop: Some(Crop { x: 3.0, y: 2.0, width: 2.0, height: 3.0 }),
            aspect_ratio: Some(2.0 / 3.0),
            canvas_width: Some(6),
            canvas_height: Some(10),
        };
        assert_eq!(
            scaled_camera_crop(&defaults, 3, 5),
            Some(Crop { x: 1.5, y: 1.0, width: 1.0, height: 1.5 })
        );
        assert_eq!(scaled_camera_crop(&defaults, 0, 5), None);
    }
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests -- --nocapture
```

Expected: compilation fails because the module and helper types do not exist.

- [ ] **Step 3: Add DTOs and the complete orientation transform**

Register `mod camera_defaults;` in `lib.rs`, add `PartialEq` to the existing `Crop` derive, and implement:

```rust
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct OrientedCameraCrop {
    pub(crate) canvas: Dim2,
    pub(crate) rect: Rect,
}
```

`orient_camera_crop` must first reject empty/out-of-bounds rectangles using checked addition, then use these exact formulas:

```rust
let (canvas, rect) = match orientation {
    Orientation::Normal | Orientation::Unknown => (canvas, rect),
    Orientation::HorizontalFlip => (canvas, Rect::new(Point::new(canvas.w - right, y), size)),
    Orientation::Rotate180 => (canvas, Rect::new(Point::new(canvas.w - right, canvas.h - bottom), size)),
    Orientation::VerticalFlip => (canvas, Rect::new(Point::new(x, canvas.h - bottom), size)),
    Orientation::Transpose => (Dim2::new(canvas.h, canvas.w), Rect::new(Point::new(y, x), Dim2::new(size.h, size.w))),
    Orientation::Rotate90 => (Dim2::new(canvas.h, canvas.w), Rect::new(Point::new(canvas.h - bottom, x), Dim2::new(size.h, size.w))),
    Orientation::Transverse => (Dim2::new(canvas.h, canvas.w), Rect::new(Point::new(canvas.h - bottom, canvas.w - right), Dim2::new(size.h, size.w))),
    Orientation::Rotate270 => (Dim2::new(canvas.h, canvas.w), Rect::new(Point::new(y, canvas.w - right), Dim2::new(size.h, size.w))),
};
```

Here `x = rect.p.x`, `y = rect.p.y`, `size = rect.d`, `right = x.checked_add(size.w)?`, and `bottom = y.checked_add(size.h)?`.

- [ ] **Step 4: Convert `RawMetadata` and scale camera pixels**

Implement `camera_defaults_from_raw(&RawMetadata) -> CameraDefaults`. Read EXIF orientation with `Orientation::from_u16`, call `orient_camera_crop`, then delegate to `pub(crate) CameraDefaults::from_oriented(OrientedCameraCrop)`. That constructor converts the oriented rectangle to `Crop`, sets `aspect_ratio` to oriented width divided by oriented height, and carries oriented canvas dimensions. Missing/invalid crop returns `CameraDefaults::default()`. Keep `orient_camera_crop` and the constructor `pub(crate)` for the deterministic crate fixture test.

Implement `pub(crate) scaled_camera_crop(&CameraDefaults, developed_width, developed_height) -> Option<Crop>` using:

```rust
let scale_x = f64::from(developed_width) / f64::from(defaults.canvas_width?);
let scale_y = f64::from(developed_height) / f64::from(defaults.canvas_height?);
let crop = defaults.crop?;
let scaled = Crop {
    x: crop.x * scale_x,
    y: crop.y * scale_y,
    width: crop.width * scale_x,
    height: crop.height * scale_y,
};
```

Reject zero/non-finite dimensions, negative coordinates, empty rectangles, and any scaled right/bottom beyond the developed image with a `1e-6` floating tolerance.

- [ ] **Step 5: Run focused tests and commit**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests -- --nocapture
git add src-tauri/src/camera_defaults.rs src-tauri/src/lib.rs src-tauri/src/image_processing.rs
git commit -m "feat(metadata): convert RAW camera defaults"
```

Expected: all eight orientation cases and the rotated reduced-resolution case pass.

### Task 8: Merge Camera Defaults With Persisted Adjustments

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/camera_defaults.rs`

- [ ] **Step 1: Write failing precedence and bounds tests**

```rust
#[test]
fn defaults_apply_only_to_null_developed_raw_adjustments() {
    let defaults = CameraDefaults {
        crop: Some(Crop { x: 10.0, y: 20.0, width: 100.0, height: 40.0 }),
        aspect_ratio: Some(2.5),
        canvas_width: Some(200),
        canvas_height: Some(100),
    };
    let null = Value::Null;
    let effective = effective_adjustments(&null, &defaults, ImageSourceKind::DevelopedRaw, 200, 100);
    assert_eq!(effective["crop"]["x"], 10.0);
    assert_eq!(effective["aspectRatio"], 2.5);
    assert_eq!(effective_adjustments(&null, &defaults, ImageSourceKind::EmbeddedPreview, 200, 100), Value::Null);
    assert_eq!(effective_adjustments(&null, &defaults, ImageSourceKind::NonRaw, 200, 100), Value::Null);
}

#[test]
fn every_persisted_object_wins_unchanged() {
    let defaults = CameraDefaults::default();
    for persisted in [json!({}), json!({"crop": null}), json!({"crop": {"x": 1}})] {
        assert_eq!(
            effective_adjustments(&persisted, &defaults, ImageSourceKind::DevelopedRaw, 200, 100),
            persisted
        );
    }
}
```

- [ ] **Step 2: Run and verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests::defaults_apply -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests::every_persisted -- --nocapture
```

Expected: compilation fails because `effective_adjustments` does not exist.

- [ ] **Step 3: Implement one shared merge helper**

```rust
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
```

Do not insert exposure into adjustments. Callers must retain `persisted.is_null()` separately when selecting the existing default thumbnail/tone-mapper path.

- [ ] **Step 4: Add non-failing metadata-only extraction**

```rust
pub fn camera_defaults_for_path(path: &Path) -> CameraDefaults {
    let result = (|| -> anyhow::Result<CameraDefaults> {
        let source = RawSource::new(path)?;
        let decoder = rawler::get_decoder(&source)?;
        let metadata = decoder.raw_metadata(&source, &RawDecodeParams::default())?;
        Ok(camera_defaults_from_raw(&metadata))
    })();
    match result {
        Ok(defaults) => defaults,
        Err(error) => {
            log::debug!("No camera defaults for '{}': {error}", path.display());
            CameraDefaults::default()
        }
    }
}
```

Add a test using a guaranteed missing `tempfile::TempDir` child and assert the function returns empty defaults without an error.

- [ ] **Step 5: Run tests and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests -- --nocapture
git add src-tauri/src/camera_defaults.rs
git commit -m "feat(metadata): resolve effective camera adjustments"
```

### Task 9: Apply Intrinsic Exposure And Preserve Decode Source

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/raw_processing.rs:15`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/image_loader.rs:32`

- [ ] **Step 1: Write failing gain/source-kind tests in `image_loader.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use rawler::formats::tiff::SRational;

    fn pixel_image() -> DynamicImage {
        DynamicImage::ImageRgba32F(ImageBuffer::from_pixel(1, 1, Rgba([0.25, 0.5, 1.0, 0.75])))
    }

    #[test]
    fn intrinsic_exposure_is_linear_unclamped_and_preserves_alpha() {
        for (ev, expected) in [(0, [0.25, 0.5, 1.0]), (1, [0.5, 1.0, 2.0]), (2, [1.0, 2.0, 4.0]), (3, [2.0, 4.0, 8.0])] {
            let mut image = pixel_image();
            apply_intrinsic_exposure(&mut image, ImageSourceKind::DevelopedRaw, Some(SRational::new(ev, 1)));
            let pixel = image.to_rgba32f().get_pixel(0, 0).0;
            assert_eq!(&pixel[..3], &expected);
            assert_eq!(pixel[3], 0.75);
        }
    }

    #[test]
    fn intrinsic_exposure_skips_fallback_and_non_raw_pixels() {
        for kind in [ImageSourceKind::EmbeddedPreview, ImageSourceKind::NonRaw] {
            let mut image = pixel_image();
            apply_intrinsic_exposure(&mut image, kind, Some(SRational::new(2, 1)));
            assert_eq!(image.to_rgba32f().get_pixel(0, 0).0, [0.25, 0.5, 1.0, 0.75]);
        }
    }
}
```

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib image_loader::tests::intrinsic_exposure -- --nocapture
```

Expected: compilation fails because `apply_intrinsic_exposure` and the source-kind integration do not exist.

- [ ] **Step 3: Return render metadata from RAW development**

In `raw_processing.rs`, add:

```rust
pub struct DevelopedRawImage {
    pub image: DynamicImage,
    pub render_metadata: RawRenderMetadata,
}
```

Make `develop_internal` return `(DynamicImage, Orientation, RawRenderMetadata)`. It already calls `raw_metadata`; clone/move `metadata.render_metadata` into the tuple. Make `develop_raw_image` apply EXIF orientation to pixels and return `DevelopedRawImage`. Do not apply exposure here because RAW artifact preprocessing still occurs in `image_loader.rs`.

- [ ] **Step 4: Add the metadata-aware base-load result**

```rust
#[derive(Clone)]
pub struct LoadedBaseImage {
    pub image: DynamicImage,
    pub source_kind: ImageSourceKind,
}

pub fn load_base_image_with_metadata_from_bytes(/* existing arguments */) -> Result<LoadedBaseImage>;
```

Move the current body into this function. Return `DevelopedRaw` only from `Ok(Ok(developed))`, `EmbeddedPreview` from both embedded-preview fallback branches, and `NonRaw` from the normal image branch. Keep `load_base_image_from_bytes` as a compatibility wrapper that returns `.image`.

Factor the body through a private `load_base_image_with_intrinsic_policy(..., IntrinsicExposurePolicy)` implementation. The production wrappers always pass `Apply`. Under `#[cfg(test)]`, expose `pub(crate) load_base_image_without_intrinsic_exposure_for_test` with the same inputs and `Skip`; it runs the otherwise identical RAW preprocessing/decode path but captures pixels immediately before the intrinsic-gain call. Private fixture tests use this independent pre-gain result, not an algebraic inverse of the production output.

After `remove_raw_artifacts_and_enhance` completes in the successful RAW branch, call:

```rust
apply_intrinsic_exposure(
    &mut developed.image,
    ImageSourceKind::DevelopedRaw,
    developed.render_metadata.sensor_exposure_comp,
);
```

Implement `apply_intrinsic_exposure` for `ImageRgb32F` and `ImageRgba32F`, multiplying RGB by `2_f32.powf(n as f32 / d as f32)` without clamping and leaving alpha unchanged. Missing metadata or a zero denominator is a no-op.

- [ ] **Step 5: Run tests and commit**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib image_loader::tests -- --nocapture
git add src-tauri/src/raw_processing.rs src-tauri/src/image_loader.rs
git commit -m "feat(raw): apply intrinsic exposure and report decode source"
```

### Task 10: Carry Source Kind Through Editor Cache Hits

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/cache_utils.rs:159`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/app_state.rs:40`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/image_loader.rs:748`

- [ ] **Step 1: Write a failing decoded-cache round-trip test**

Append a real test module to `cache_utils.rs`; the module path matters because the focused command below uses an exact filter:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera_defaults::ImageSourceKind;

    #[test]
    fn decoded_cache_retains_embedded_preview_source_kind() {
        let mut cache = DecodedImageCache::new(2);
        let entry = DecodedImageCacheEntry {
            image: Arc::new(DynamicImage::new_rgb8(2, 2)),
            exif: HashMap::new(),
            source_kind: ImageSourceKind::EmbeddedPreview,
        };
        cache.insert("sample.raf".into(), entry);
        assert_eq!(
            cache.get("sample.raf").unwrap().source_kind,
            ImageSourceKind::EmbeddedPreview
        );
    }
}
```

- [ ] **Step 2: Run the cache test and verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib cache_utils::tests::decoded_cache_retains_embedded_preview_source_kind -- --exact
```

Expected: compilation fails because `DecodedImageCacheEntry` and cached source kind do not exist.

- [ ] **Step 3: Replace cache tuples with a named entry**

```rust
#[derive(Clone)]
pub struct DecodedImageCacheEntry {
    pub image: Arc<DynamicImage>,
    pub exif: HashMap<String, String>,
    pub source_kind: ImageSourceKind,
}
```

Store `Vec<(String, DecodedImageCacheEntry)>`; make `get` return a cloned entry and `insert` accept the entry. This cache is in-memory only, so changing the entry type makes an old source-less hit impossible without a persistent migration.

- [ ] **Step 4: Write failing cache-hit response and serialization tests**

In `image_loader.rs::tests`, first add named tests for the actual boundary that `load_image` will use:

```rust
#[test]
fn cached_raf_load_returns_the_stored_embedded_preview_kind() {
    let cached = DecodedImageCacheEntry {
        image: Arc::new(DynamicImage::new_rgb8(2, 3)),
        exif: HashMap::new(),
        source_kind: ImageSourceKind::EmbeddedPreview,
    };
    let selected = select_cached_or_decoded(Some(cached), || {
        panic!("a cache hit must not decode or infer from the .raf extension")
    })
    .unwrap();
    let response = load_image_result_from_entry(ImageMetadata::default(), selected, true);
    assert_eq!(response.source_kind, ImageSourceKind::EmbeddedPreview);
    assert!(response.is_raw);
}

#[test]
fn source_kind_serialization_is_stable() {
    assert_eq!(serde_json::to_value(ImageSourceKind::DevelopedRaw).unwrap(), "developed_raw");
    assert_eq!(serde_json::to_value(ImageSourceKind::EmbeddedPreview).unwrap(), "embedded_preview");
    assert_eq!(serde_json::to_value(ImageSourceKind::NonRaw).unwrap(), "non_raw");
}
```

Run both exact tests before defining the selection/response helpers:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib image_loader::tests::cached_raf_load_returns_the_stored_embedded_preview_kind -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --lib image_loader::tests::source_kind_serialization_is_stable -- --exact
```

Expected: compilation fails because the selection helper, response helper, and response source field do not exist.

- [ ] **Step 5: Propagate the authoritative kind through `load_image`**

Add `source_kind: ImageSourceKind` to `LoadedImage` and `LoadImageResult`. On a miss, call `load_base_image_with_metadata_from_bytes`, cache its kind, and return it. On a hit, use the cached kind without inspecting the extension. Keep `is_raw` as the existing file-format flag for tone-mapper behavior.

Extract `select_cached_or_decoded(cached, decode)` and `load_image_result_from_entry(metadata, entry, is_raw)` from the production command. `load_image` must call these exact helpers, so the first test covers the same cache-hit selection and response construction used by Tauri. On a hit, the decode closure is not called and the stored entry flows unchanged into `LoadedImage` and `LoadImageResult`.

- [ ] **Step 6: Run cache/load tests and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib cache_utils::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib image_loader::tests -- --nocapture
git add src-tauri/src/cache_utils.rs src-tauri/src/app_state.rs src-tauri/src/image_loader.rs
git commit -m "feat(raw): preserve authoritative source kind in caches"
```

### Task 11: Return Non-Failing Camera Defaults From `load_metadata`

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/camera_defaults.rs`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/file_management.rs:2651`

- [ ] **Step 1: Write failing flattened-response tests**

Before defining the response type, add tests in `camera_defaults.rs::tests` that reference the not-yet-created `LoadMetadataResult` and production response boundary:

```rust
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
    assert_eq!(value["cameraDefaults"], serde_json::to_value(CameraDefaults::default()).unwrap());
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
    assert_eq!(value["cameraDefaults"], serde_json::to_value(CameraDefaults::default()).unwrap());
}
```

Both literal null and `{}` must survive unchanged when decoder metadata extraction fails.

- [ ] **Step 2: Run the response test and verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests::load_metadata_response_is_flattened -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests::metadata_advisory_failure_preserves_sidecar_fields -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests::metadata_advisory_failure_preserves_literal_null -- --exact
```

Expected: compilation fails because `LoadMetadataResult` and `metadata_result_for_path` do not exist.

- [ ] **Step 3: Add the response type and production response boundary**

Add:

```rust
#[derive(Clone, Debug, Serialize)]
pub struct LoadMetadataResult {
    #[serde(flatten)]
    pub metadata: ImageMetadata,
    #[serde(rename = "cameraDefaults")]
    pub camera_defaults: CameraDefaults,
}

pub fn metadata_result_for_path(metadata: ImageMetadata, source_path: &Path) -> LoadMetadataResult {
    let camera_defaults = if is_raw_file(source_path) {
        camera_defaults_for_path(source_path)
    } else {
        CameraDefaults::default()
    };
    LoadMetadataResult { metadata, camera_defaults }
}
```

This is the one final response-building boundary used by the Tauri command and directly exercised by the advisory-failure test.

- [ ] **Step 4: Change the Tauri command without changing sidecar semantics**

Change `load_metadata` to `Result<LoadMetadataResult, String>`. Keep settings lookup, sidecar loading, XMP import, and any healed sidecar write exactly as they are. After those succeed, return `metadata_result_for_path(metadata, &source_path)`. That boundary calls `camera_defaults_for_path` only for a RAW extension and returns empty defaults otherwise. Decoder/source/metadata errors have already been converted to empty defaults and must not fail this command.

- [ ] **Step 5: Run tests and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml --lib
git add src-tauri/src/camera_defaults.rs src-tauri/src/file_management.rs
git commit -m "feat(metadata): expose RAF camera defaults"
```

### Task 12: Use Effective Framing In Every Backend Render Path

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/camera_defaults.rs`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/image_loader.rs:67`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/file_management.rs:65`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/file_management.rs:1204`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/file_management.rs:3167`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/lib.rs:1514`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/export_processing.rs:719`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/export_processing.rs:1080`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/panel/library/CullingView.tsx`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/modals/CollageModal.tsx`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/modals/NegativeConversionModal.tsx`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/imagePreviews.ts`

- [ ] **Step 1: Write failing composite and shared-render-input tests**

In `image_loader.rs::tests`, add a test for a not-yet-created `load_and_composite_with_metadata` and assert that compositing a no-patch object preserves `EmbeddedPreview`. In `camera_defaults.rs::tests`, add a table-driven test for a not-yet-created `ResolvedRenderInput::from_loaded`: the same literal-null sidecar/defaults must produce proportional crops at full, half-thumbnail, and half-estimate dimensions, while `EmbeddedPreview` remains null. Assert its separate `persisted_is_null` flag stays true so camera defaults never select the object/GPU/basic tone-mapper path.

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib image_loader::tests::metadata_aware_composite_preserves_source_kind -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests::resolved_render_input_scales_once_and_preserves_null_tone_path -- --exact
```

Expected: compilation fails because both production boundaries are absent.

- [ ] **Step 2: Implement metadata-aware compositing and one render-input contract**

Add `load_and_composite_with_metadata` beside the compatibility wrapper. It calls `load_base_image_with_metadata_from_bytes`, composites patches, and returns `LoadedBaseImage` with the same authoritative kind.

Add `pub(crate) ResolvedRenderInput` in `camera_defaults.rs` with `pub(crate)` fields `effective_adjustments`, `source_kind`, and `persisted_is_null`, plus `ResolvedRenderInput::from_loaded(persisted: &Value, defaults: &CameraDefaults, loaded: &LoadedBaseImage) -> Self`. It uses `loaded.image.dimensions()` as the only scaling dimensions. Every standalone preview, thumbnail, unopened export, and unopened estimate below must use this type; no caller may independently merge camera fields.

- [ ] **Step 3: Write failing standalone-preview path tests**

Extract the command's `pub(crate)` production preparation boundary as `prepare_standalone_preview(persisted: &Value, explicit_adjustments: Option<&Value>, loaded: &LoadedBaseImage, defaults: &CameraDefaults) -> ResolvedRenderInput`. Before implementing it, test all of these cases with an 8x6 synthetic image and a centered 4x2 camera crop:

Also extract `pub(crate) fn render_standalone_preview_geometry(loaded: &LoadedBaseImage, render: &ResolvedRenderInput) -> (DynamicImage, (f32, f32))`. It calls `apply_all_transformations` and is the only geometry result the real command may pass into masks/GPU processing. Tests and fixtures call this same wired boundary, not `apply_all_transformations` independently.

Append the tests inside an explicit `#[cfg(test)] mod tests { use super::*; ... }` in `lib.rs`; do not place bare `#[test]` functions at module scope. Name them with the `standalone_preview_` prefix used by both red and green commands.

- omitted adjustments plus `DevelopedRaw` loads literal-null sidecar state and returns the camera crop;
- omitted adjustments plus `EmbeddedPreview` returns null/full framing;
- `Some(json!({}))` and `Some(json!({"crop": null}))` win unchanged;
- compositing, `apply_all_transformations`, masks, geometry/GPU hashes, and final dimensions all consume the returned effective value.

Define the real production command argument as `GeneratePreviewRequest { path, #[serde(default)] js_adjustments: Option<Value> }`, with camelCase serde names, and make the Tauri command accept that request object. Add a serde test against this exact production type proving an omitted `jsAdjustments` field deserializes to `None` while an explicit object deserializes to `Some`; do not create a test-only mirror DTO.

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib tests::standalone_preview_ -- --nocapture
```

Expected: tests fail because the optional command boundary and preparation function do not exist.

- [ ] **Step 4: Implement standalone preview ownership**

Change `generate_preview_for_path` to accept the production `GeneratePreviewRequest`. Its `Some` adjustments are explicit caller state and win. For `None`, load the sidecar value without converting null to `{}`. Load pixels with `load_and_composite_with_metadata`, obtain `camera_defaults_for_path`, and call `prepare_standalone_preview` before transformations, mask generation, hashes, or GPU parsing. Frontend callers send `{ request: { path, jsAdjustments? } }`, matching the real Tauri boundary.

In the same step, create `src/services/imagePreviews.ts` with a typed `GeneratePreviewInvokePayload` and `generateExplicitPreviewForPath(path, adjustments)` wrapper; only that wrapper calls `invoke(Invokes.GeneratePreviewForPath, { request: { path, jsAdjustments: adjustments } })`. Migrate CullingView, CollageModal, and NegativeConversionModal to the wrapper while preserving their current explicit-adjustment behavior. Task 19 adds the omitted-adjustment wrapper and removes Culling/Collage coercion.

Run `rg -n "generate_preview_for_path|GeneratePreviewForPath" src`. Inspect every match: outside the enum declaration and `imagePreviews.ts`, there must be no direct preview invoke. Negative Conversion must call the explicit wrapper. This centralized typed wrapper, not `invoke`'s generic payload, enforces the nested request shape.

Negative Conversion continues to pass `Some(adjustments)`. Culling and Collage omit the argument in Task 19.

- [ ] **Step 5: Write failing thumbnail-render and persistent-cache tests**

Extract the actual `pub(crate)` literal-null post-load thumbnail renderer as `render_thumbnail_from_loaded(loaded: &LoadedBaseImage, render: &ResolvedRenderInput, is_raw: bool, settings: &AppSettings) -> anyhow::Result<DynamicImage>`. The object/GPU branch dispatches before this helper and remains on its existing path. Test the dispatch plus helper directly with synthetic pixels:

Add `pub(crate) fn prepare_thumbnail_render_input(persisted: &Value, defaults: &CameraDefaults, loaded: &LoadedBaseImage) -> ResolvedRenderInput`. Both normal-library and tagging thumbnail paths must call it before dispatch/render/cache fingerprinting; fixtures call it too. No thumbnail caller may borrow an export-preparation result.

Create an explicit test module before adding the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera_defaults::{CameraDefaults, ImageSourceKind, effective_adjustments};
    use serde_json::json;
    use std::collections::HashMap;
}
```

Add subsequent thumbnail and reset tests inside this module, not at file scope. Use these required names so the focused filter is nonempty: `thumbnail_null_developed_raw_uses_camera_crop`, `thumbnail_embedded_preview_stays_full_frame`, `thumbnail_manifest_hashes_path_defaults_effective_crop_and_source`, and `thumbnail_tagging_and_library_share_manifest`.

- null `DevelopedRaw` takes the existing default CPU/AgX tone path and then returns camera-cropped dimensions;
- null `EmbeddedPreview` takes that same null tone path but returns full dimensions;
- an object uses the existing GPU/geometry path unchanged;
- a metadata-bearing preloaded image preserves its source kind.

Define a serializable `ThumbnailManifestKey` containing render version, virtual path, source modification timestamp, persisted adjustments, and full oriented camera defaults. Define `ThumbnailRenderFingerprint` as that complete key plus effective adjustments and authoritative source kind. Add failing tests proving different source paths, modification times, camera crops, effective crops, and `DevelopedRaw` versus `EmbeddedPreview` all produce different final cache hashes. A constant salt alone must not satisfy the test.

Because source kind is only authoritative after decode, add a small manifest named from `blake3(serde_json(ThumbnailManifestKey))`. Its contents carry the complete `ThumbnailRenderFingerprint` and final JPEG filename. Test that lookup verifies the stored manifest key, re-hashes the complete fingerprint, locates exactly that JPEG, rejects missing/malformed/mismatched data, and that a successful write atomically replaces the manifest only after the JPEG exists. This preserves fast persistent cache hits without guessing source kind from `.raf` or allowing identical metadata from different files to collide.

Add a regression test for `get_cached_or_generate_thumbnail_image` at `file_management.rs:3183`, the separate path used by `tagging.rs`. It must use the same manifest lookup/write functions and `render_thumbnail_from_loaded`; delete `get_cache_key_hash`'s legacy pre-decode JPEG naming. Assert the normal library generator and tagging generator resolve the same manifest/JPEG for one input.

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib file_management::tests::thumbnail_ -- --nocapture
```

Expected: tests fail before renderer/fingerprint/manifest boundaries exist.

- [ ] **Step 6: Apply defaults and complete inputs to thumbnails**

Change preloaded thumbnail input from `Option<&DynamicImage>` to a metadata-bearing input containing pixels and `ImageSourceKind`. Load non-preloaded pixels with `load_and_composite_with_metadata`, build `ResolvedRenderInput`, and call `render_thumbnail_from_loaded`.

For a literal-null sidecar, run current default RAW processing first, then apply only `effective_adjustments["crop"]` with `apply_crop`. For a persisted object, retain the current GPU/geometry path. Keep edited status based on persisted adjustments.

Replace both legacy hash callers with the fingerprint plus manifest protocol. Include `THUMBNAIL_RENDER_VERSION = "raf-render-metadata-v1"`, but also hash path, modification timestamp, persisted/effective adjustments, actual camera defaults, and authoritative source kind. Thumbnail generation returns the kind/fingerprint needed for the final name, writes the JPEG, and atomically publishes the manifest; lookup never infers source kind. `get_cached_or_generate_thumbnail_image` used by tagging delegates to these same functions rather than independently constructing a cache path.

- [ ] **Step 7: Write failing export and estimate path tests**

Extract `pub(crate)` production boundary `prepare_export_render_input(persisted: &Value, explicit: Option<&Value>, defaults: &CameraDefaults, loaded: &LoadedBaseImage) -> ResolvedRenderInput`.

For estimates, use this complete API rather than a placeholder:

```rust
pub(crate) struct FastEstimateScale {
    pub crop_x: f64,
    pub crop_y: f64,
    pub masks: f32,
    pub output_x: f32,
    pub output_y: f32,
}

pub(crate) enum GeometryOrigin {
    CameraDefault,
    PersistedFullResolution,
    CurrentEditor,
}

pub(crate) struct PreparedEstimateInput {
    pub render: ResolvedRenderInput,
    pub mask_scale: f32,
    pub output_scale: (f32, f32),
}

pub(crate) fn prepare_export_estimate_input(
    persisted: &Value,
    explicit: Option<&Value>,
    defaults: &CameraDefaults,
    loaded: &LoadedBaseImage,
    geometry_origin: GeometryOrigin,
    fast_scale: FastEstimateScale,
) -> PreparedEstimateInput;

pub(crate) fn render_export_geometry(
    loaded: &LoadedBaseImage,
    render: &ResolvedRenderInput,
) -> (DynamicImage, (f32, f32));

pub(crate) fn render_export_estimate_geometry(
    loaded: &LoadedBaseImage,
    prepared: &PreparedEstimateInput,
) -> (DynamicImage, (f32, f32));
```

The real batch-export branch must use `render_export_geometry`; both real estimate branches must use `render_export_estimate_geometry` before masks/GPU/output extrapolation. Create this complete module shell in `export_processing.rs` before adding scoped tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        adjustment_utils::apply_all_transformations,
        camera_defaults::{CameraDefaults, ImageSourceKind},
        image_loader::LoadedBaseImage,
    };
    use image::DynamicImage;
    use serde_json::{Value, json};
}
```

Add the tests inside it with required names `raf_unopened_camera_crop_reaches_export`, `raf_embedded_preview_stays_full_in_export`, `raf_fast_camera_crop_scales_once`, and `raf_fast_persisted_geometry_scales_crop_masks_and_output_axes`. Make batch export and both estimate branches call these boundaries. The tests run `PreparedEstimateInput.render.effective_adjustments` through `apply_all_transformations` on synthetic full- and half-size images:

- unopened null `DevelopedRaw` exports/estimates the proportional camera crop;
- unopened null `EmbeddedPreview` remains full frame;
- current-editor explicit adjustments win unchanged;
- the fast estimate scales by actual oriented x/y dimensions exactly once, including a synthetic axis-swapping orientation;
- an unopened persisted crop object and masks retain the existing `get_fast_demosaic_scale_factor` conversion needed to map full-resolution user geometry into the fast image;
- only newly injected camera-default geometry skips that legacy conversion because it was already scaled by `ResolvedRenderInput` against actual fast dimensions;
- preview, thumbnail renderer, export, and both estimate preparation boundaries return identical framing for the same loaded dimensions/source kind.

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib export_processing::tests::raf_ -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib file_management::tests::thumbnail_ -- --nocapture
```

Expected: tests fail because the export/estimate boundaries do not exist or still consume persisted adjustments directly.

- [ ] **Step 8: Apply defaults to unopened exports and both size estimates**

In batch export, preserve the distinction between current-editor explicit adjustments and sidecar adjustments. Load a metadata-bearing base image first, then call `prepare_export_render_input`; current-editor objects win. Use the returned value for compositing, transformations, masks, GPU hashes, and final sizing.

In both `estimate_export_sizes` branches, compute `FastEstimateScale` explicitly. For the existing fast RAW path, populate the fields from the current `get_fast_demosaic_scale_factor`, or use independent x/y ratios when both oriented full dimensions are available; use identity for the full current-editor path. `CameraDefault` uses `ResolvedRenderInput`'s already-scaled crop, ignores `crop_x/crop_y`, but retains `(output_x, output_y)` for independent full-width/full-height extrapolation. `PersistedFullResolution` multiplies user crop x/width by `crop_x`, y/height by `crop_y`, returns `masks` for mask generation, and returns both output scales. `CurrentEditor` uses identity geometry. Prove a persisted object with no camera defaults still scales its crop, masks, output width, and output height correctly, including a nonuniform synthetic scale.

- [ ] **Step 9: Write the failing reset test, then persist literal null**

Before changing the reset command, add this named test in `file_management.rs::tests`:

```rust
#[test]
fn reset_metadata_restores_null_camera_default_baseline() {
    let existing = ImageMetadata {
        rating: 4,
        adjustments: json!({"exposure": 1.0, "crop": null}),
        tags: Some(vec!["keep".into()]),
        exif: Some(HashMap::from([("Model".into(), "GFX100RF".into())])),
        ..ImageMetadata::default()
    };
    let reset = metadata_with_reset_adjustments(existing);
    assert!(reset.adjustments.is_null());
    assert_eq!(reset.rating, 4);
    assert_eq!(reset.tags.as_ref().unwrap(), &vec!["keep".to_string()]);
    assert_eq!(reset.exif.as_ref().unwrap()["Model"], "GFX100RF");

    let defaults = CameraDefaults {
        crop: Some(Crop { x: 2.0, y: 1.0, width: 4.0, height: 2.0 }),
        aspect_ratio: Some(2.0),
        canvas_width: Some(8),
        canvas_height: Some(6),
    };
    let effective = effective_adjustments(
        &reset.adjustments,
        &defaults,
        ImageSourceKind::DevelopedRaw,
        8,
        6,
    );
    assert_eq!(effective["crop"]["width"], 4.0);
}
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib file_management::tests::reset_metadata_restores_null_camera_default_baseline -- --exact
```

Expected: FAIL because `metadata_with_reset_adjustments` does not exist. Implement it, change `reset_adjustments_for_paths` to call it rather than assign `serde_json::json!({})`, and rerun the exact test to green. Task 20 adds disk-write/error and completion-order coverage.

- [ ] **Step 10: Run backend path tests and commit**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib image_loader::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib cache_utils::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib tests::standalone_preview_ -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib file_management::tests::thumbnail_ -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib file_management::tests::reset_metadata_restores_null_camera_default_baseline -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --lib export_processing::tests::raf_ -- --nocapture
test "$(cargo test --manifest-path src-tauri/Cargo.toml --lib -- --list | rg -c '^file_management::tests::thumbnail_')" -ge 4
test "$(cargo test --manifest-path src-tauri/Cargo.toml --lib -- --list | rg -c '^export_processing::tests::raf_')" -ge 4
cargo check --manifest-path src-tauri/Cargo.toml --lib
npm run typecheck
git add src-tauri/src/camera_defaults.rs src-tauri/src/image_loader.rs src-tauri/src/file_management.rs src-tauri/src/lib.rs src-tauri/src/export_processing.rs src/services/imagePreviews.ts src/components/panel/library/CullingView.tsx src/components/modals/CollageModal.tsx src/components/modals/NegativeConversionModal.tsx
git commit -m "feat(render): apply RAF framing across backend paths"
```

Expected: editor loads, standalone previews, thumbnails, batch exports, and both estimate branches compile against one effective-adjustment contract; null sidecars retain current default tone mapping.

## Chunk 3: Backend Private-Fixture Validation

### Task 13: Validate The Backend Against Private Fixtures

**Files:**

- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/raf_fixture_tests.rs`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/lib.rs`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/camera_defaults.rs`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/image_loader.rs`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/file_management.rs`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/export_processing.rs`

- [ ] **Step 1: Add an environment-gated crate test module**

Register `#[cfg(test)] mod raf_fixture_tests;` and implement the following executable shape. Imports may be grouped by rustfmt, but keep the calls to the Task 12 production boundaries. Do not load or modify fixture `.rrdata`; pass `Value::Null` explicitly.

```rust
use crate::{
    app_settings::AppSettings,
    camera_defaults::{CameraDefaults, ImageSourceKind, camera_defaults_for_path,
        orient_camera_crop, scaled_camera_crop},
    export_processing::{FastEstimateScale, GeometryOrigin, prepare_export_estimate_input,
        prepare_export_render_input, render_export_estimate_geometry, render_export_geometry},
    file_management::{prepare_thumbnail_render_input, render_thumbnail_from_loaded},
    image_loader::{load_base_image_with_metadata_from_bytes,
        load_base_image_without_intrinsic_exposure_for_test},
    raw_processing::get_fast_demosaic_scale_factor,
    prepare_standalone_preview, render_standalone_preview_geometry,
};
use image::{DynamicImage, GenericImageView};
use rawler::{decoders::Orientation, imgop::{Dim2, Point, Rect}};
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
    Case { stem: "DSCF0420", ev: 1.0, crop: None, swaps_axes: true },
    Case { stem: "DSCF0581", ev: 1.0, crop: Some((0.0, 2217.0, 11648.0, 4301.0)), swaps_axes: false },
    Case { stem: "DSCF0434", ev: 2.0, crop: Some((1296.0, 2770.0, 9056.0, 3196.0)), swaps_axes: false },
    Case { stem: "DSCF0568", ev: 1.0, crop: Some((3264.0, 2448.0, 5120.0, 3840.0)), swaps_axes: false },
    Case { stem: "DSCF0476", ev: 2.0, crop: Some((0.0, 2217.0, 11648.0, 4301.0)), swaps_axes: false },
];

fn root() -> Option<PathBuf> {
    std::env::var_os("RAPIDRAW_RAF_FIXTURE_DIR").map(PathBuf::from)
}

fn displayed((w, h): (u32, u32), swap: bool) -> (u32, u32) {
    if swap { (h, w) } else { (w, h) }
}

fn assert_dims_close(label: &str, actual: (u32, u32), expected: (u32, u32)) {
    assert!(actual.0.abs_diff(expected.0) <= 8, "{label} width: {actual:?} != {expected:?}");
    assert!(actual.1.abs_diff(expected.1) <= 8, "{label} height: {actual:?} != {expected:?}");
}

fn sampled_median_log_luminance(image: &DynamicImage) -> f64 {
    let small = image.thumbnail(1024, 1024).to_rgb32f();
    let mut values: Vec<f64> = small.pixels().step_by(5).map(|p| {
        (0.2126 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[2]))
            .max(1e-8).log2()
    }).collect();
    let middle = values.len() / 2;
    *values.select_nth_unstable_by(middle, |a, b| a.total_cmp(b)).1
}

#[test]
fn gfx100rf_backend_render_paths_match_private_pairs() {
    let Some(root) = root() else { eprintln!("SKIP: set RAPIDRAW_RAF_FIXTURE_DIR"); return; };
    let settings = AppSettings::default();
    for case in CASES {
        let raw = root.join("raw").join(format!("{}.RAF", case.stem));
        let jpeg = root.join(format!("{}.JPG", case.stem));
        let isolated = tempfile::tempdir().unwrap();
        let isolated_raw = isolated.path().join(format!("{}.RAF", case.stem));
        fs::hard_link(&raw, &isolated_raw).or_else(|_| fs::copy(&raw, &isolated_raw).map(|_| ())).unwrap();
        let bytes = fs::read(&isolated_raw).unwrap();
        let jpeg_dims = displayed(image::image_dimensions(&jpeg).unwrap(), case.swaps_axes);
        let original_sidecar = PathBuf::from(format!("{}.rrdata", raw.display()));
        let original_sidecar_before = fs::read(&original_sidecar).ok();
        let original_mtime_before = fs::metadata(&original_sidecar).and_then(|m| m.modified()).ok();
        let defaults = camera_defaults_for_path(&isolated_raw);
        match (defaults.crop, case.crop) {
            (None, None) => assert_eq!(defaults, CameraDefaults::default()),
            (Some(c), Some(expected)) => {
                assert_eq!((c.x, c.y, c.width, c.height), expected);
                assert_eq!((defaults.canvas_width, defaults.canvas_height), (Some(11648), Some(8736)));
            }
            other => panic!("{} defaults mismatch: {other:?}", case.stem),
        }

        let full = load_base_image_with_metadata_from_bytes(
            &bytes, isolated_raw.to_str().unwrap(), false, &settings, None).unwrap();
        assert_eq!(full.source_kind, ImageSourceKind::DevelopedRaw);
        let standalone = prepare_standalone_preview(&Value::Null, None, &full, &defaults);
        assert_dims_close(case.stem, render_standalone_preview_geometry(&full, &standalone).0.dimensions(), jpeg_dims);
        let export = prepare_export_render_input(&Value::Null, None, &defaults, &full);
        assert_dims_close(case.stem, render_export_geometry(&full, &export).0.dimensions(), jpeg_dims);
        let editor_estimate = prepare_export_estimate_input(
            &Value::Null, Some(&standalone.effective_adjustments), &defaults, &full,
            GeometryOrigin::CurrentEditor,
            FastEstimateScale { crop_x: 1.0, crop_y: 1.0, masks: 1.0,
                output_x: 1.0, output_y: 1.0 });
        assert_dims_close(case.stem,
            render_export_estimate_geometry(&full, &editor_estimate).0.dimensions(), jpeg_dims);
        let corrected = sampled_median_log_luminance(&full.image);
        drop(full);

        let fast = load_base_image_with_metadata_from_bytes(
            &bytes, isolated_raw.to_str().unwrap(), true, &settings, None).unwrap();
        let raw_scale = get_fast_demosaic_scale_factor(&bytes, fast.image.width(), fast.image.height());
        let fast_input = prepare_export_estimate_input(
            &Value::Null, None, &defaults, &fast, GeometryOrigin::CameraDefault,
            FastEstimateScale { crop_x: raw_scale.into(), crop_y: raw_scale.into(),
                masks: raw_scale, output_x: raw_scale, output_y: raw_scale });
        let fast_dims = render_export_estimate_geometry(&fast, &fast_input).0.dimensions();
        let thumbnail_input = prepare_thumbnail_render_input(&Value::Null, &defaults, &fast);
        let thumb = render_thumbnail_from_loaded(&fast, &thumbnail_input, true, &settings).unwrap();
        assert_eq!(thumb.dimensions(), fast_dims);
        assert!(((fast_dims.0 as f64 / fast_dims.1 as f64) -
            (jpeg_dims.0 as f64 / jpeg_dims.1 as f64)).abs() < 0.003, "{} fast ratio", case.stem);
        drop(fast);

        let pre_gain = load_base_image_without_intrinsic_exposure_for_test(
            &bytes, isolated_raw.to_str().unwrap(), false, &settings, None).unwrap();
        let uncorrected = sampled_median_log_luminance(&pre_gain.image);
        drop(pre_gain);
        let jpeg_luma = sampled_median_log_luminance(&image::open(&jpeg).unwrap());
        eprintln!("{} JPEG-corrected={:.3}EV JPEG-pre-gain={:.3}EV",
            case.stem, jpeg_luma - corrected, jpeg_luma - uncorrected);
        assert!(((corrected - uncorrected) - case.ev).abs() < 0.02, "{} intrinsic gain", case.stem);
        assert_eq!(fs::read(&original_sidecar).ok(), original_sidecar_before, "{} sidecar bytes", case.stem);
        assert_eq!(fs::metadata(&original_sidecar).and_then(|m| m.modified()).ok(),
            original_mtime_before, "{} sidecar timestamp", case.stem);
    }
}

#[test]
fn rotated_fast_crop_scales_in_oriented_space() {
    let oriented = orient_camera_crop(
        Dim2::new(10, 6), Rect::new(Point::new(2, 1), Dim2::new(3, 2)), Orientation::Rotate90).unwrap();
    assert_eq!((oriented.canvas.w, oriented.canvas.h), (6, 10));
    assert_eq!((oriented.rect.p.x, oriented.rect.p.y, oriented.rect.d.w, oriented.rect.d.h),
        (3, 2, 2, 3));
    let defaults = CameraDefaults::from_oriented(oriented);
    let crop = scaled_camera_crop(&defaults, 3, 5).unwrap();
    assert_eq!((crop.x, crop.y, crop.width, crop.height), (1.5, 1.0, 1.0, 1.5));
    assert!(crop.x + crop.width <= 3.0 && crop.y + crop.height <= 5.0);
}
```

Expose `OrientedCameraCrop` and both fields, `orient_camera_crop`, `scaled_camera_crop`, `CameraDefaults::from_oriented`, `ResolvedRenderInput` and its three fields, `PreparedEstimateInput` and its fields, `prepare_standalone_preview`, `render_standalone_preview_geometry`, `prepare_thumbnail_render_input`, `render_thumbnail_from_loaded`, both export preparation functions, and both export geometry functions as `pub(crate)`. Expose `load_base_image_without_intrinsic_exposure_for_test` as `#[cfg(test)] pub(crate)`. The actual command/library/tagging/export/estimate branches must call these same boundaries. The normal and skip-policy loads independently execute the same development pipeline on either side of the production gain call; the EV assertion fails if production gain is missing, duplicated, or misplaced. The 1024-pixel thumbnail sampling avoids cloning full GFX float buffers into multi-gigabyte `Vec<f64>` values.

- [ ] **Step 2: Run private integration validation**

```bash
RAPIDRAW_RAF_FIXTURE_DIR=/Users/laynewang/Documents/PhotoBooth/pre cargo test --manifest-path src-tauri/Cargo.toml --lib raf_fixture_tests -- --nocapture
```

Expected: all framing/source assertions pass and the report prints luminance deltas without copying fixtures.

- [ ] **Step 3: Run full backend verification**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml --lib
git diff --check
git status --short
```

Expected: all commands exit zero and status contains only intended source/test changes.

- [ ] **Step 4: Commit fixture validation**

```bash
git add src-tauri/src/raf_fixture_tests.rs src-tauri/src/lib.rs src-tauri/src/camera_defaults.rs src-tauri/src/image_loader.rs src-tauri/src/file_management.rs src-tauri/src/export_processing.rs
if git diff --cached --name-only | rg -qi '\.(raf|jpe?g|rrdata)$'; then exit 1; fi
git commit -m "test(raw): validate GFX100RF render defaults"
```

- [ ] **Step 5: Do not push RapidRAW yet**

Keep the backend commits local until Chunk 4 frontend tests and full cross-repository verification pass. Do not open any pull request.

## Chunk 4: Frontend Initialization And Persistence

### Task 14: Add Vitest And Typed Image-Loading Contracts

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/package.json`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/package-lock.json`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/types/imageLoading.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/ui/AppProperties.tsx`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/hooks/useAppNavigation.ts`

- [ ] **Step 1: Install the focused frontend test runner**

Run from `/Users/laynewang/Documents/RustProjects/RapidRAW`:

```bash
npm install --save-dev vitest
```

Add scripts without changing the existing build, lint, or formatting scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Verify the runner before adding behavior tests**

```bash
npm exec vitest -- --version
npm run test -- --passWithNoTests
```

Expected: Vitest prints its version and exits zero with no tests. Do not add jsdom or React Testing Library; the behavior in this chunk is tested through pure helpers, the Zustand store, and injected command functions.

- [ ] **Step 3: Add exact transport and load-context types**

Create `src/types/imageLoading.ts`. Import `Adjustments` and define the serialized contract without `any`:

```ts
import type { Adjustments } from '../utils/adjustments';

export const IMAGE_SOURCE_KINDS = {
  DevelopedRaw: 'developed_raw',
  EmbeddedPreview: 'embedded_preview',
  NonRaw: 'non_raw',
} as const;

export type ImageSourceKind = (typeof IMAGE_SOURCE_KINDS)[keyof typeof IMAGE_SOURCE_KINDS];
export type PersistedAdjustments = Partial<Adjustments> | null;

export interface CameraPixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraDefaults {
  crop: CameraPixelCrop | null;
  aspectRatio: number | null;
  canvasWidth: number | null;
  canvasHeight: number | null;
}

export interface PersistedImageMetadata {
  version: number;
  rating: number;
  adjustments: PersistedAdjustments;
  tags: string[] | null;
  exif?: Record<string, string> | null;
}

export interface LoadMetadataResult extends PersistedImageMetadata {
  cameraDefaults: CameraDefaults;
}

export interface LoadImageResult {
  width: number;
  height: number;
  metadata: PersistedImageMetadata;
  exif: Record<string, string>;
  is_raw: boolean;
  source_kind: ImageSourceKind;
}

export interface AdjustmentLoadContext {
  persistedAdjustments: PersistedAdjustments;
  noCameraBaseline: Adjustments;
  effectiveBaseline: Adjustments;
  injectedCrop: boolean;
  injectedAspectRatio: boolean;
  sourceKind: ImageSourceKind | null;
  reconciled: boolean;
  dirty: boolean;
}
```

Keep `cameraDefaults` camelCase and `source_kind` plus its three values exactly snake_case. Do not add camera defaults to `PersistedImageMetadata` or `Adjustments`.

- [ ] **Step 4: Type the selected image source**

Modify `SelectedImage` in `src/components/ui/AppProperties.tsx`:

```ts
sourceKind: ImageSourceKind | null;
```

Set it to `null` in every new not-yet-loaded `SelectedImage`. The only non-null assignment comes from `LoadImageResult.source_kind`; never infer it from `is_raw`, a filename extension, or a cache hit.

- [ ] **Step 5: Run transport checks and commit**

```bash
npm run typecheck
npm run test -- --passWithNoTests
git add package.json package-lock.json src/types/imageLoading.ts src/components/ui/AppProperties.tsx src/hooks/useAppNavigation.ts
git commit -m "test(frontend): add RAF loading test contracts"
```

Expected: typecheck and the empty test suite pass.

### Task 15: Initialize, Reconcile, And Serialize Camera Defaults

**Files:**

- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/utils/rafCameraDefaults.ts`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/utils/rafCameraDefaults.test.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/utils/adjustments.ts`

- [ ] **Step 1: Write failing literal-null precedence tests**

In `rafCameraDefaults.test.ts`, import the not-yet-created helpers and use a fresh fixture factory for every test. Cover all of these cases:

```ts
it.each([
  [{}, 'empty object'],
  [{ crop: null }, 'explicit null crop'],
  [{ crop: { unit: 'px', x: 10, y: 20, width: 30, height: 40 } }, 'saved crop'],
])('does not inject camera defaults into %s', (persisted) => {
  const result = initializeAdjustmentLoad(metadataWith(persisted));
  expect(result.context.injectedCrop).toBe(false);
  expect(result.context.injectedAspectRatio).toBe(false);
  expect(result.adjustments.crop).toEqual(normalizeLoadedAdjustments(persisted as Adjustments).crop);
});

it('injects a pixel crop and ratio only for literal null', () => {
  const result = initializeAdjustmentLoad(metadataWith(null));
  expect(result.adjustments.crop).toEqual({ unit: 'px', x: 100, y: 200, width: 6500, height: 2400 });
  expect(result.adjustments.aspectRatio).toBeCloseTo(65 / 24);
  expect(result.adjustments.exposure).toBe(0);
  expect(result.context.injectedCrop).toBe(true);
  expect(result.context.persistedAdjustments).toBeNull();
});
```

Also assert the helper does not mutate `INITIAL_ADJUSTMENTS`, nested curves, metadata adjustments, or `cameraDefaults`.

- [ ] **Step 2: Run the focused test and verify it fails**

```bash
npm test -- src/utils/rafCameraDefaults.test.ts
```

Expected: FAIL because `rafCameraDefaults.ts` and `initializeAdjustmentLoad` do not exist.

- [ ] **Step 3: Implement the minimal metadata-stage initializer**

Export a deep-cloning normalizer from `adjustments.ts` or clone through `normalizeLoadedAdjustments`. Implement:

```ts
export function initializeAdjustmentLoad(metadata: LoadMetadataResult): {
  adjustments: Adjustments;
  context: AdjustmentLoadContext;
};
```

Determine precedence with `metadata.adjustments === null`; do not read `.is_null`, use truthiness, or use `Object.keys`. For literal null, create the no-camera baseline from normalized initial adjustments, then add `unit: 'px'` to a cloned camera crop. For every object, normalize only that object and ignore all camera-default fields. Initialize `sourceKind: null`, `reconciled: false`, and `dirty: false`.

- [ ] **Step 4: Add failing authoritative-source reconciliation tests**

Add table-driven tests for:

- `developed_raw` keeps an injected crop/aspect and sets the effective baseline to that result.
- `embedded_preview` atomically restores both injected fields to the no-camera baseline and uses `load_image.width / height`, not the RAF metadata canvas.
- `non_raw` receives no RAW-space defaults.
- A persisted object remains unchanged for every source kind.
- A literal-null load with no camera crop receives the current full-canvas ratio only after authoritative image dimensions exist.
- DR defaults never change `exposure`.

Run and observe failure before implementing:

```bash
npm test -- src/utils/rafCameraDefaults.test.ts -t reconciliation
```

- [ ] **Step 5: Implement reconciliation without partial mutation**

Implement:

```ts
export function reconcileAdjustmentLoad(
  provisional: Adjustments,
  context: AdjustmentLoadContext,
  image: Pick<LoadImageResult, 'width' | 'height' | 'source_kind'>,
): { adjustments: Adjustments; context: AdjustmentLoadContext };
```

Build new adjustment/context objects. If the persisted value was literal null, first complete `noCameraBaseline.aspectRatio` from the authoritative image dimensions. Keep injected fields only for `developed_raw`; restore both for `embedded_preview` and `non_raw`. Finish with `sourceKind`, `reconciled: true`, `dirty: false`, and an `effectiveBaseline` equal to the final reconciled adjustments. Never reconcile one injected field without the other.

- [ ] **Step 6: Add failing persistence tests**

Test a serializer returning `PersistedAdjustments | undefined`:

```ts
expect(adjustmentsForPersistence(unreconciledContext, current)).toBeUndefined();
expect(adjustmentsForPersistence(reconciledUntouchedContext, current)).toBeUndefined();

const dirtyAtBaseline = { ...reconciledContext, dirty: true };
expect(adjustmentsForPersistence(dirtyAtBaseline, effectiveBaseline)).toBeNull();

const resetCrop = { ...effectiveBaseline, crop: null, aspectRatio: 4 / 3 };
expect(adjustmentsForPersistence(dirtyAtBaseline, resetCrop)).toEqual(resetCrop);
```

Repeat the return-to-baseline case for an original `{}` and an original saved object; return the exact cloned persisted value rather than its normalized expansion. This preserves literal null after undo while allowing the first real edit to persist the complete effective object.

Add a reordered-object-key case and nested array/object cases. Baseline equality must use an exported structural comparator that recursively compares primitives, arrays, and objects by sorted key sets; do not use `JSON.stringify`, reference identity, or property insertion order.

- [ ] **Step 7: Implement persistence and run all helper tests**

Implement `markAdjustmentLoadDirty`, the structural comparator, and `adjustmentsForPersistence`. A not-reconciled or not-dirty context returns `undefined`, meaning “do not invoke save.” A dirty state structurally equal to `effectiveBaseline` returns the original persisted value. Otherwise return a deep clone of the current effective adjustments.

```bash
npm test -- src/utils/rafCameraDefaults.test.ts
npm run typecheck
git add src/utils/adjustments.ts src/utils/rafCameraDefaults.ts src/utils/rafCameraDefaults.test.ts
git commit -m "feat(frontend): resolve RAF camera adjustment defaults"
```

### Task 16: Make Editor Load State Atomic And Save-Safe

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/store/useEditorStore.ts`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/store/useEditorStore.test.ts`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/editorPersistence.ts`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/editorPersistence.test.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/hooks/useEditorActions.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/hooks/useImageProcessing.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/panel/Editor.tsx`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/hooks/useAppContextMenus.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/hooks/useExternalEditSession.ts`

- [ ] **Step 1: Write failing store-transition tests**

Reset the Zustand store before each test. Add tests proving:

1. `beginAdjustmentLoad` installs provisional adjustments, a one-entry history, index zero, and an unreconciled clean context.
2. `completeAdjustmentLoad` replaces adjustments, history, index, context, and the selected image's `sourceKind`/`isReady` in one state transition.
3. Embedded-preview completion leaves no camera crop in either adjustments or history; undo cannot restore it.
4. `applyExplicitAdjustments` changes adjustments and the dirty flag in one state transition, then writes one debounced history entry under fake timers.
5. `undo`, `redo`, and `goToHistoryIndex` mark a reconciled load dirty because they are explicit user actions.
6. `beginAdjustmentReload` atomically sets `isReady: false`, `sourceKind: null`, clears context/history, and returns an `AdjustmentSessionSnapshot` containing the `SuspendedHistoryToken` for any not-yet-committed undo entry.
7. `clearEditorSession` cancels pending history and atomically clears the selected image, provenance, and history while restoring a cloned initial adjustment value for the empty editor.
8. `restoreAdjustmentSession(snapshot)` atomically restores the exact pre-reload adjustments/history/context/source/readiness after a reset failure; no intermediate ready/unreconciled state is observable.

Subscribe once around `completeAdjustmentLoad` and assert no observed state combines `isReady: true` with an unreconciled context.

- [ ] **Step 2: Run the store test and verify it fails**

```bash
npm test -- src/store/useEditorStore.test.ts
```

Expected: FAIL because the load context/actions do not exist.

- [ ] **Step 3: Add explicit editor load actions**

Add `adjustmentLoadContext: AdjustmentLoadContext | null` and focused actions to the store:

```ts
beginAdjustmentLoad(adjustments, context): void;
completeAdjustmentLoad(adjustments, context, selectedImage): void;
applyExplicitAdjustments(value): void;
beginAdjustmentReload(path, suspendedHistory?: SuspendedHistoryToken): AdjustmentSessionSnapshot;
restoreAdjustmentSession(snapshot): void;
clearEditorSession(): void;
```

`beginAdjustmentLoad` and `completeAdjustmentLoad` directly set `history: [adjustments]` and `historyIndex: 0`; they do not call debounced history. `completeAdjustmentLoad` is the only initial-load action allowed to set `isReady: true`, and discards any successful reload snapshot/token. `beginAdjustmentReload` and `clearEditorSession` are each one Zustand update, not sequences of component mutations. Every aborted reload calls `restoreAdjustmentSession`, which restores both the store history and its suspended pending-history token through `restorePendingHistory`.

- [ ] **Step 4: Write failing shared debounce and save-queue tests**

With fake timers and an injected `invoke`, test `editorPersistence.ts`:

- adjustment bursts from two callers collapse to one history snapshot;
- `cancelPendingHistory` prevents a pre-navigation/pre-reset snapshot from arriving later;
- `scheduleSave(path, value)` never invokes for `undefined`;
- saves for one path are serialized in call order;
- `flushPendingSave(path)` triggers the debounced call and does not resolve until the actual invoke promise resolves;
- `cancelPendingSave(path)` cancels a queued debounce but still awaits an already in-flight write.
- a rejected invoke retains the exact newest value in a per-path failed-save slot; the next `flushPendingSave(path)` retries it and clears it only after success;
- `suspendPendingHistory()` returns the pending latest snapshot, `restorePendingHistory(token)` reinstates it after an aborted navigation, and successful navigation discards it.

```bash
npm test -- src/services/editorPersistence.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 5: Centralize explicit edits and persistence scheduling**

Implement the shared history debounce and per-path promise queue in `editorPersistence.ts`. `flushPendingSave` must return `Promise<void>` from the underlying Tauri invocation, not merely call lodash's synchronous `.flush()`. On rejection, retain the newest unsaved value by path; never drop it in a `.catch`. A later flush retries that retained value before allowing navigation/reset/export to continue.

`applyExplicitAdjustments` marks the reconciled context dirty in the same Zustand update that changes adjustments, then schedules history through the shared service. Undo/redo/history navigation cancel pending history before applying their explicit dirty transition. Loader/reconciliation actions never mark dirty or schedule history.

Remove both existing independent debounce implementations: the exported one in `useEditorActions.ts` and the private `debouncedSetHistory` at `Editor.tsx:122`. Both `useEditorActions.setAdjustments` and the main Editor controls must call the same store `applyExplicitAdjustments` action. This includes Crop Reset and every control passed through `Editor.tsx`.

Delete the existing public `resetHistory`; it is an untracked adjustment/history replacement and must not remain callable. Narrow `setEditor`'s TypeScript patch type so it cannot set `adjustments`, `history`, `historyIndex`, or `adjustmentLoadContext`. Typecheck must force every replacement into one of four categories:

- loader initialization/reconciliation: `beginAdjustmentLoad` or `completeAdjustmentLoad`;
- user edit: `applyExplicitAdjustments`;
- backend-persisted replacement/reset: `beginAdjustmentReload`, followed by Task 17's coordinator.
- leaving/clearing the editor: `clearEditorSession`, with no subsequent load.

Update current direct replacements in `useImageLoader.ts`, `useAppNavigation.ts`, `useEditorActions.ts`, and `useAppContextMenus.ts` to use the appropriate dedicated action. In particular, context-menu auto adjustments at `useAppContextMenus.ts:437` are backend-persisted state and must invalidate/reload, not call `setEditor({ adjustments })` plus `resetHistory`.

Replace all three legacy debounce sites in `useAppNavigation.ts` explicitly:

- before an image-to-image path switch, call `suspendPendingHistory()`, then `await flushPendingSave(oldPath)`, then discard the history token and install the new unready selection;
- before the explicit return-to-library clear flow around current line 72, suspend history and await the selected path's save before discarding the token and calling `clearEditorSession()`;
- before the effect-driven clear flow around current line 331, perform the same suspension/await sequence before `clearEditorSession()`.

Make the relevant navigation callbacks async and ensure their callers await or intentionally `void` the returned promise. If `flushPendingSave` rejects, catch it, restore the suspended history snapshot, show the existing save error, abort the switch/clear, and keep the current editor session ready; never allow an unhandled async event rejection. Add fake-promise tests proving neither path replacement nor either clear action occurs before the old save resolves, rejection leaves the old session selected with its latest undo snapshot and retained save value, and a second navigation attempt proceeds only after retrying that value successfully.

Migrate `useExternalEditSession.ts`: replace its import and synchronous `debouncedSave.flush()` with `await flushPendingSave(selectedImage.path)` before external-edit export and process exit. Catch rejection inside the hook's existing export error flow and abort export/process exit. This caller must not terminate while a sidecar write is still queued, in flight, or failed.

- [ ] **Step 6: Block initial auto-save and auto-sync**

At `useImageProcessing.ts:415`, resolve persistence through `adjustmentsForPersistence`:

```ts
const persisted = adjustmentsForPersistence(adjustmentLoadContext, adjustments);
if (persisted !== undefined) {
  scheduleSave(selectedImage.path, persisted);
}
```

Do not save or auto-sync while the context is null/unreconciled or clean. Rendering remains allowed only after `isReady`, so the first developed preview uses effective defaults without writing them. Set `prevAdjustmentsRef` only after reconciliation; auto-sync deltas remain based on explicit effective edits.

- [ ] **Step 7: Run state/persistence tests and commit**

```bash
npm test -- src/store/useEditorStore.test.ts src/services/editorPersistence.test.ts src/utils/rafCameraDefaults.test.ts
npm run typecheck
git add src/store/useEditorStore.ts src/store/useEditorStore.test.ts src/services/editorPersistence.ts src/services/editorPersistence.test.ts src/hooks/useEditorActions.ts src/hooks/useImageProcessing.ts src/components/panel/Editor.tsx src/hooks/useAppContextMenus.ts src/hooks/useExternalEditSession.ts src/hooks/useImageLoader.ts src/hooks/useAppNavigation.ts
git commit -m "fix(frontend): keep RAF camera defaults ephemeral"
```

### Task 17: Unify Metadata-First Cached And Uncached Loading

**Files:**

- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/editorImageLoad.ts`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/editorImageLoad.test.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/hooks/useImageLoader.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/hooks/useAppNavigation.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/utils/ImageLRUCache.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/App.tsx`

- [ ] **Step 1: Write failing coordinator-order tests**

Make `editorImageLoad.ts` accept injected `flushPendingSave`, `loadMetadata`, `loadImage`, `onMetadata`, and `onComplete` functions. In tests, record calls and assert exact order:

```ts
expect(events).toEqual([
  'flush_save:start',
  'flush_save:end',
  'load_metadata:start',
  'load_metadata:end',
  'begin_adjustments',
  'load_image:start',
  'load_image:end',
  'complete_atomic',
]);
```

Add cases for developed RAW, embedded fallback, non-RAW, one transient metadata-command failure, and a fast cache hit. The fast cache-hit test must still call metadata first and use the authoritative `source_kind` returned by `load_image`. Assert `onComplete` receives reconciled adjustments/history data and never provisional camera state for an embedded preview.

Add mismatch/race cases:

- a pending save promise must resolve before the first `load_metadata` call;
- when `load_metadata.adjustments` and `load_image.metadata.adjustments` differ structurally, `onComplete` is not called and the coordinator retries the metadata-then-image pair;
- a second matching pair completes from that pair only, never mixing first-pass metadata with second-pass image state;
- three consecutive mismatches reject with the editor still unready;
- `{}` and `null` are a mismatch, while objects with reordered keys but equal nested values agree.

- [ ] **Step 2: Run and verify coordinator tests fail**

```bash
npm test -- src/services/editorImageLoad.test.ts
```

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement the sole editor load coordinator**

Implement an async coordinator that:

1. Awaits `flushPendingSave(path)` so a prior debounced or in-flight write cannot race the read.
2. Awaits typed `load_metadata`.
3. Calls `initializeAdjustmentLoad` and `onMetadata` while readiness remains false.
4. Awaits typed `load_image`.
5. Structurally compares `load_metadata.adjustments` with `load_image.metadata.adjustments` using the Task 15 comparator.
6. On agreement, calls `reconcileAdjustmentLoad`, then one `onComplete` with that same pair.
7. On disagreement, discards both provisional baselines and retries the complete metadata-then-image pair, at most three times. A permanent mismatch rejects without calling `onComplete` or making the image ready.

The backend contract makes camera-default extraction advisory. If the whole metadata command transiently rejects, log it and use a default `LoadMetadataResult` with `adjustments: null` and empty `cameraDefaults` for that attempt; never retain the previous image's adjustments. It may complete only if the same attempt's `load_image.metadata.adjustments` is also null. Otherwise retry; a persistent command failure plus non-null image metadata remains unready and surfaces the load error.

- [ ] **Step 4: Route uncached loads through the coordinator**

Replace `any` invokes in `useImageLoader.ts` with `invoke<LoadMetadataResult>` and `invoke<LoadImageResult>`. On metadata completion, call `beginAdjustmentLoad`. On image completion, calculate preview/original sizes and call `completeAdjustmentLoad` once with:

- `sourceKind: result.source_kind`
- `isRaw: result.is_raw`
- reconciled adjustments/context/history
- `isReady: true`

Keep the path/effect-active check immediately before each store update. Do not retain the current second update that fills `aspectRatio` after readiness; reconciliation owns that decision.

- [ ] **Step 5: Route cache hits through the same coordinator**

Before switching paths, await `flushPendingSave` for the image being left. In `useAppNavigation.ts:164`, restore cached pixels/URLs as display placeholders but set the selected image to `isReady: false` and `sourceKind: null`; do not launch background `load_image` and `load_metadata` promises there. Remove duplicated metadata normalization at lines 202-218. `useImageLoader` must run for cached and uncached selections alike; the backend decoded cache keeps this path fast.

Update `ImageCacheEntry` and `cachedEditStateRef` to retain typed persisted/effective load context and the prior reconciled source kind internally. A cache hit may use that information to retain pixels and layout, but the provisional `SelectedImage` exposes `sourceKind: null` and no reconciled context until the current coordinator completes. Only the current `load_image.source_kind` becomes visible. Never derive `developed_raw` from a `.raf` path.

- [ ] **Step 6: Run sequencing/state tests and commit**

```bash
npm test -- src/services/editorImageLoad.test.ts src/services/editorPersistence.test.ts src/store/useEditorStore.test.ts src/utils/rafCameraDefaults.test.ts
npm run typecheck
npm run lint
git add src/services/editorImageLoad.ts src/services/editorImageLoad.test.ts src/services/editorPersistence.ts src/hooks/useImageLoader.ts src/hooks/useAppNavigation.ts src/utils/ImageLRUCache.ts src/App.tsx
git commit -m "fix(frontend): reconcile RAF metadata before image readiness"
```

### Task 18: Preserve Null Reset Crop With A Local Full-Canvas Overlay

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/utils/cropUtils.ts`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/utils/cropUtils.test.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/panel/right/CropPanel.tsx`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/panel/Editor.tsx`

- [ ] **Step 1: Add failing reset and overlay tests**

Test pure helpers for both landscape and EXIF-oriented portrait dimensions:

```ts
it('resets to an explicit full-canvas override', () => {
  const reset = resetCropAdjustments(edited, 8736, 11648);
  expect(reset.crop).toBeNull();
  expect(reset.aspectRatio).toBeCloseTo(8736 / 11648);
  expect(reset.orientationSteps).toBe(0);
});

it('uses a local full overlay without materializing an adjustment crop', () => {
  expect(localCropOverlay(null, 11648, 8736)).toEqual({ unit: '%', x: 0, y: 0, width: 100, height: 100 });
});
```

Also assert `resetCropAdjustments` retains the Crop panel's existing reset values for rotation, transforms, flips, and lens geometry while leaving unrelated exposure/color adjustments unchanged.

- [ ] **Step 2: Run the focused crop test and observe failure**

```bash
npm test -- src/utils/cropUtils.test.ts
```

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3: Extract the current reset patch and full overlay**

Move the adjustment calculation from `CropPanel.tsx:356` into `resetCropAdjustments`. Its ratio uses `selectedImage.width / selectedImage.height`; those dimensions are already post-EXIF orientation. Preserve `crop: null` and the existing transform-reset behavior.

Implement `localCropOverlay` so a null persisted adjustment produces only a local ReactCrop 100% overlay. Do not return a pixel crop suitable for `Adjustments.crop`.

- [ ] **Step 4: Prevent Editor from reconstructing a null crop**

At `Editor.tsx:1394`, when `currentAdjCrop === null`, update `prevCropParams`, call local `setCrop(localCropOverlay(...))` only while crop controls are visible, and return without `setAdjustments`. At `Editor.tsx:1589`, explicitly replace the old camera overlay with the local 100% overlay when adjustment crop becomes null.

CropPanel's Reset Crop and every crop interaction use the Task 16 `applyExplicitAdjustments` action. `Editor.tsx` must not reintroduce a component-local adjustment/history debounce.

This must satisfy all three states:

- Initial camera crop: editable pixel crop remains visible.
- Reset Crop: full sensor is visible and `adjustments.crop` remains null.
- Reopen after Reset Crop: persisted object wins, so camera crop is not reinjected.

- [ ] **Step 5: Run crop and persistence tests and commit**

```bash
npm test -- src/utils/cropUtils.test.ts src/utils/rafCameraDefaults.test.ts src/store/useEditorStore.test.ts
npm run typecheck
git add src/utils/cropUtils.ts src/utils/cropUtils.test.ts src/components/panel/right/CropPanel.tsx src/components/panel/Editor.tsx
git commit -m "fix(crop): preserve full-canvas RAF reset"
```

### Task 19: Make Culling And Collage Use Backend-Owned Defaults

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/imagePreviews.ts`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/imagePreviews.test.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/panel/library/CullingView.tsx`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/modals/CollageModal.tsx`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/components/modals/NegativeConversionModal.tsx`

- [ ] **Step 1: Write failing Tauri-payload tests**

Inject an invoke function into small preview wrappers and assert exact payloads:

```ts
expect(invoke).toHaveBeenCalledWith('generate_preview_for_path', { request: { path } });
expect(invoke).not.toHaveBeenCalledWith('generate_preview_for_path', {
  request: expect.objectContaining({ jsAdjustments: expect.anything() }),
});

expect(explicitInvoke).toHaveBeenCalledWith('generate_preview_for_path', {
  request: { path, jsAdjustments: negativeConversionAdjustments },
});
```

The first assertion covers backend-owned sidecar/default resolution. The second preserves Negative Conversion's deliberate temporary adjustment object.

Re-run Task 12's Rust command-argument test in this task as the backend half of the contract: omitting `jsAdjustments` must deserialize to `None`, and an explicit object to `Some`. The mocked frontend payload test alone is not sufficient.

- [ ] **Step 2: Run the focused test and observe failure**

```bash
npm test -- src/services/imagePreviews.test.ts
```

- [ ] **Step 3: Remove frontend sidecar coercion from Culling and Collage**

Add `generateEffectivePreviewForPath(path)` with no `jsAdjustments` member to the existing typed service; retain `generateExplicitPreviewForPath(path, adjustments)` with `Some` semantics.

In `CullingView.tsx:242`, remove `LoadMetadata` and the conversion of null to `{}`. Both the main request and fallback request omit adjustments. Keep cancellation/blob cleanup and the thumbnail-key cache behavior unchanged.

In `CollageModal.tsx:143`, remove the metadata request and use the backend-owned wrapper. The returned image dimensions continue to determine the collage's source ratio.

In `NegativeConversionModal.tsx`, call only the explicit wrapper and add a short code comment that its temporary adjustments intentionally bypass sidecar/camera-default merging. Do not change its visual behavior.

- [ ] **Step 4: Run preview tests and commit**

```bash
npm test -- src/services/imagePreviews.test.ts
npm run typecheck
npm run lint
cargo test --manifest-path src-tauri/Cargo.toml --lib tests::standalone_preview_ -- --nocapture
git add src/services/imagePreviews.ts src/services/imagePreviews.test.ts src/components/panel/library/CullingView.tsx src/components/modals/CollageModal.tsx src/components/modals/NegativeConversionModal.tsx
git commit -m "fix(preview): use backend RAF camera defaults"
```

### Task 20: Reload Camera Defaults After Reset Adjustments

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/hooks/useEditorActions.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/hooks/useAppContextMenus.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src-tauri/src/file_management.rs:2399`
- Test: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/store/useEditorStore.test.ts`
- Test: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/editorImageLoad.test.ts`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/editorPersistence.ts`
- Test: `/Users/laynewang/Documents/RustProjects/RapidRAW/src/services/editorPersistence.test.ts`

- [ ] **Step 1: Add failing reset-reload tests**

Add a test sequence that starts with a saved user crop, invokes a fake reset command, then re-enters the metadata-first coordinator with `adjustments: null`. Assert:

- The reset promise resolves before the subsequent `load_metadata` begins.
- Camera crop/aspect return as the clean effective baseline.
- History contains only the reloaded camera baseline.
- Context is reconciled and not dirty.
- `adjustmentsForPersistence` returns `undefined`, so reset does not immediately create another sidecar.

Add a second test proving embedded-preview reload restores full fallback framing rather than the RAF camera crop.

In `file_management.rs::tests`, add failing backend tests for a not-yet-created `write_reset_metadata_with` boundary:

- an absent sidecar yields `ImageMetadata::default()`, but an existing unreadable or malformed sidecar returns an error instead of being replaced with defaults;
- a successful injected writer receives JSON with literal `"adjustments": null` while rating/tags/EXIF remain unchanged;
- an injected writer error is returned rather than ignored;
- a command-level orchestration helper pre-reads every path before writing, uses atomic temp-file/rename writes in sorted path order, rolls back already-written sidecars if a later write fails, and does not start thumbnail work on failure;
- if an earlier path originally had no sidecar and a later write fails, rollback deletes the newly created earlier sidecar and restores the exact absent state;
- existing XMP synchronization is invoked only after all RapidRAW sidecars succeed and remains explicitly best effort because `sync_metadata_to_xmp` returns `()`.
- the normal `save_metadata_and_update_thumbnail` write boundary also rejects an existing unreadable/malformed sidecar rather than merging into `ImageMetadata::default()` and overwriting it.

Add frontend barrier tests in `editorPersistence.test.ts`: a reset barrier captures the current rollback value, prevents any save for that path from invoking during reset, and makes `flushPendingSave(path)` wait for `finishResetBarrier`. Prove `load_metadata` cannot start while the barrier is open. Success discards rollback/buffered values and releases the coordinator. A recoverable write failure cancels the old coordinator, restores/requeues the newest value, waits for that save, then starts one fresh load. A read/parse/rollback failure restores the in-memory session without invoking the unsafe save or starting reload. If the pre-reset in-flight-save drain rejects, the barrier must close/cancel, the snapshot/history and failed save remain retryable, and `ResetAdjustmentsForPaths` is never invoked. Under fake timers, prove every aborted path restores the `SuspendedHistoryToken` and eventually commits that latest undo snapshot exactly once.

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib file_management::tests::reset_ -- --nocapture
```

Expected: Rust tests fail because the fallible write/orchestration boundaries do not exist; frontend tests fail because reset/reload is not atomic.

- [ ] **Step 2: Make backend reset completion authoritative**

Implement `read_reset_metadata_with(path, reader)` and `write_reset_metadata_with(path, writer)` so existing read, deserialize, serialization, temp-write, and rename errors become a serialized `ResetAdjustmentsError { kind, path, message, rollback_succeeded }`. A genuinely absent sidecar may start from `ImageMetadata::default()`; an existing broken sidecar must never be silently overwritten. Reuse the same fallible existing-sidecar reader in `save_metadata_and_update_thumbnail`, with tests proving ordinary auto-save also refuses to destroy malformed metadata.

Refactor `reset_adjustments_for_paths` into phases:

1. In one awaited `spawn_blocking` job, resolve and deduplicate physical sidecar paths (including equivalent virtual paths), sort them, fallibly read and serialize every original/reset value before writing anything, then atomically replace each RapidRAW sidecar. Capture original state as `Absent` or `Bytes`. If a later write fails, restore `Bytes` and delete any file whose state was `Absent`; return a deterministic path-specific error and whether rollback fully succeeded.
2. After all RapidRAW sidecars succeed, run existing `sync_metadata_to_xmp` calls as logged best effort. Do not claim XMP failure detection: that function suppresses errors and returns `()`.
3. Only then enqueue/detach thumbnail regeneration.

The command future may resolve before thumbnails finish, but never before every RapidRAW sidecar write succeeds. Do not keep the current detached block that performs both writes and thumbnails after returning `Ok(())`.

Run the existing backend reset/effective-adjustment test before frontend wiring:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests -- --nocapture
```

- [ ] **Step 3: Route all whole-image reset commands through reload**

Add a per-path reset barrier to `editorPersistence.ts`. `beginResetBarrier(path, rollbackValue)` creates a deferred completion promise, removes queued debounce work without discarding its value, exposes an in-flight-drain promise, and buffers any later save for that path. `flushPendingSave(path)` first awaits this barrier promise, so an already-triggered `useImageLoader` coordinator cannot read metadata until reset resolution. `finishResetBarrier` has explicit outcomes `Success`, `PreflightSaveFailure`, `RecoverableFailure`, and `UnsafeSidecarFailure`: success resolves the waiter, while failures reject it with a typed reset-cancel signal. The coordinator treats that signal as cancellation and performs no metadata call. `PreflightSaveFailure` leaves the failed value in the normal retry slot.

In `useEditorActions.handleResetAdjustments`, process the selected path in this order:

1. Compute the current rollback value with `adjustmentsForPersistence`, capture `suspendPendingHistory()`, call `beginResetBarrier`, then call `beginAdjustmentReload(path, suspendedHistory)` and retain its `AdjustmentSessionSnapshot`. Controls become unready before the backend request. If `useImageLoader` starts, its first flush blocks on the barrier before `load_metadata`.
2. Await the barrier's in-flight-save drain. If it rejects, atomically restore the session/history snapshot, finish with `PreflightSaveFailure`, surface the save error, and return without invoking `ResetAdjustmentsForPaths`; the retained value is retried by the next navigation/reset attempt. Otherwise invoke and await reset.
3. On success, finish with `Success`, discard rollback/buffered values, delete the frontend cache entry, and release `useImageLoader` to reload null metadata/defaults/source/history.
4. On a write error with `rollback_succeeded: true`, atomically restore the session snapshot and finish with `RecoverableFailure` so the old coordinator exits. Then requeue/flush the newest captured explicit value through the now-fallible save command and call `beginAdjustmentReload` again to start a fresh metadata-first load only after that save succeeds.
5. On `read`, `parse`, or rollback failure, atomically restore the session snapshot and finish with `UnsafeSidecarFailure`. Do not requeue through save and do not release a coordinator reload against the damaged sidecar; preserve the edit in memory, surface the path-specific error, and require the user to resolve/retry. The fallible normal save boundary prevents the restored session's later autosave from overwriting the damaged file.

For non-selected paths, rely on the backend's regenerated effective thumbnail. In `useAppContextMenus.ts:285`, replace the local `INITIAL_ADJUSTMENTS` reset with `handleResetAdjustments([selectedImage.path])` so the editor context-menu action also writes null and reloads camera defaults.

Do not change the Crop panel's Reset Crop behavior; it is an explicit persisted full-canvas override covered by Task 18.

- [ ] **Step 4: Run reset tests and commit**

```bash
npm test -- src/services/editorImageLoad.test.ts src/services/editorPersistence.test.ts src/store/useEditorStore.test.ts src/utils/rafCameraDefaults.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib file_management::tests::reset_ -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib camera_defaults::tests -- --nocapture
npm run typecheck
git add src/hooks/useEditorActions.ts src/hooks/useAppContextMenus.ts src/services/editorPersistence.ts src/services/editorPersistence.test.ts src/store/useEditorStore.ts src/store/useEditorStore.test.ts src/services/editorImageLoad.test.ts src-tauri/src/file_management.rs
git commit -m "fix(editor): reload RAF defaults after adjustment reset"
```

### Task 21: Verify Frontend And Cross-Path RAF Behavior

**Files:**

- Verify only; do not add private fixtures or generated sidecars.

- [ ] **Step 1: Run the complete frontend suite**

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Expected: all commands exit zero. Vitest covers null/object precedence, source reconciliation, history, persistence, load order, crop reset, and preview payload ownership.

- [ ] **Step 2: Run the complete RapidRAW backend suite**

Use Rust 1.96.1 as required by `src-tauri/rust-toolchain.toml`; Homebrew Rust 1.95.0 is insufficient.

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml --lib
```

- [ ] **Step 3: Re-run private fixture validation**

```bash
RAPIDRAW_RAF_FIXTURE_DIR=/Users/laynewang/Documents/PhotoBooth/pre cargo test --manifest-path src-tauri/Cargo.toml --lib raf_fixture_tests -- --nocapture
```

Expected: representative DR200/DR400, Auto DR200, 4:3, 65:24, 17:6, zoomed, and rotated samples pass crop/source/gain assertions. No JPEG-brightness closeness threshold is introduced.

- [ ] **Step 4: Inspect editor behavior with representative private files**

Open at least `DSCF0420.RAF`, `DSCF0581.RAF`, and `DSCF0434.RAF` from the private fixture directory and verify:

- Initial editor, thumbnail, culling preview, collage preview, export, and export estimate agree on framing.
- Exposure remains at zero while DR200/DR400 intrinsic gain is visible.
- Reset Crop reveals the full oriented sensor canvas and stays full after reopen.
- Undo to the untouched camera baseline removes an otherwise empty sidecar adjustment value rather than persisting the camera crop.
- Reset Adjustments restores camera framing, while an embedded-preview fallback receives neither RAW gain nor RAF crop.

- [ ] **Step 5: Audit repository boundaries and private data**

```bash
git diff --check
git status --short
git diff --name-only fork-dev...HEAD
git remote -v
```

Expected: no path under `/Users/laynewang/Documents/PhotoBooth/pre`, no `.raf`, `.RAF`, fixture JPEG, or `.rrdata` file is staged. Only the intended feature branches and `lincvic` push remotes are used.

- [ ] **Step 6: Push only the fork feature branch**

After all checks pass:

```bash
git push origin cl/vegdog/fix-raf-reading
```

Do not create a pull request and do not push to `CyberTimon/RapidRAW`.
