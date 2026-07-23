use memmap2::{Mmap, MmapOptions};
use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, LazyLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Utc};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma};
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tempfile::NamedTempFile;
use tokio::sync::Semaphore;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::AppState;
use crate::PendingMetadata;
#[cfg(target_os = "android")]
use crate::android_integration::*;
use crate::app_settings::*;
use crate::cache_utils::calculate_geometry_hash;
use crate::camera_defaults::{
    CameraDefaults, ImageSourceKind, LoadMetadataResult, ResolvedRenderInput,
    camera_defaults_for_path, metadata_result_for_path,
};
use crate::exif_processing;
use crate::formats::{is_raw_file, is_supported_image_file};
use crate::gpu_processing;
use crate::image_loader;
use crate::image_loader::LoadedBaseImage;
use crate::image_processing::GpuContext;
use crate::image_processing::{
    Crop, ImageMetadata, apply_coarse_rotation, apply_cpu_default_raw_processing, apply_crop,
    apply_flip, apply_geometry_warp, apply_rotation, auto_results_to_json,
    get_all_adjustments_from_json, perform_auto_analysis,
};
use crate::mask_generation::MaskDefinition;
use crate::preset_converter;
use crate::tagging::COLOR_TAG_PREFIX;

pub(crate) const THUMBNAIL_RENDER_VERSION: &str = "raf-render-metadata-v2";
const THUMBNAIL_MANIFEST_SCHEMA_VERSION: u8 = 2;
const THUMBNAIL_MANIFEST_MAX_BYTES: u64 = 4 * 1_024;
const THUMBNAIL_JPEG_MAX_BYTES: u64 = 64 * 1_024 * 1_024;
const THUMBNAIL_CACHE_RETENTION_PER_PATH: usize = 8;
const THUMBNAIL_CACHE_CLEANUP_MAX_ENTRIES: usize = 256;
const THUMBNAIL_CACHE_CLEANUP_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailSourceTimestamp {
    seconds: u64,
    nanoseconds: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ThumbnailRenderPath {
    DefaultCpu,
    ObjectGpu,
    ObjectFallback,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailLutIdentity {
    content_blake3: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ThumbnailLutRequest {
    NotRequested,
    Available(ThumbnailLutIdentity),
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ThumbnailLutOutcome {
    NotRequested,
    Applied(ThumbnailLutIdentity),
    Unavailable,
    NotApplied,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailRenderProfile {
    target_width: u32,
    default_tonemapper: String,
    tonemapper_override_enabled: bool,
    raw_highlight_compression: f32,
    linear_raw_mode: String,
    raw_preprocessing_color_nr: f32,
    raw_preprocessing_sharpening: f32,
    apply_preprocessing_to_non_raws: bool,
    dispatch: ThumbnailRenderPath,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailManifestKey {
    render_version: String,
    virtual_path: String,
    source_modified: ThumbnailSourceTimestamp,
    persisted_adjustments: Value,
    camera_defaults: CameraDefaults,
    render_profile: ThumbnailRenderProfile,
    lut_request: ThumbnailLutRequest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ThumbnailCacheIdentity {
    key_digest: String,
    virtual_path_digest: String,
    requested_render_path: ThumbnailRenderPath,
    requested_lut: ThumbnailLutRequest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailRenderFingerprint {
    key_digest: String,
    virtual_path_digest: String,
    effective_adjustments_digest: String,
    source_kind: ImageSourceKind,
    requested_render_path: ThumbnailRenderPath,
    actual_render_path: ThumbnailRenderPath,
    requested_lut: ThumbnailLutRequest,
    actual_lut_outcome: ThumbnailLutOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailManifest {
    schema_version: u8,
    fingerprint: ThumbnailRenderFingerprint,
    jpeg_digest: String,
    jpeg_byte_len: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ThumbnailCacheHit {
    manifest_path: Option<PathBuf>,
    jpeg_path: PathBuf,
}

#[derive(Clone)]
struct ThumbnailPreloadedImage {
    image: Arc<DynamicImage>,
    source_kind: ImageSourceKind,
}

#[derive(Clone)]
struct ResolvedThumbnailLut {
    request: ThumbnailLutRequest,
    lut: Option<Arc<crate::lut_processing::Lut>>,
}

impl ResolvedThumbnailLut {
    fn applied_outcome(&self) -> ThumbnailLutOutcome {
        match &self.request {
            ThumbnailLutRequest::NotRequested => ThumbnailLutOutcome::NotRequested,
            ThumbnailLutRequest::Available(identity) => {
                ThumbnailLutOutcome::Applied(identity.clone())
            }
            ThumbnailLutRequest::Unavailable => ThumbnailLutOutcome::Unavailable,
        }
    }

    fn fallback_outcome(&self) -> ThumbnailLutOutcome {
        match &self.request {
            ThumbnailLutRequest::NotRequested => ThumbnailLutOutcome::NotRequested,
            ThumbnailLutRequest::Available(_) => ThumbnailLutOutcome::NotApplied,
            ThumbnailLutRequest::Unavailable => ThumbnailLutOutcome::Unavailable,
        }
    }
}

fn thumbnail_lut_path(adjustments: &Value) -> Option<&str> {
    let effects_visible = adjustments
        .get("sectionVisibility")
        .and_then(|visibility| visibility.get("effects"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    effects_visible
        .then(|| adjustments.get("lutPath").and_then(Value::as_str))
        .flatten()
}

fn resolve_thumbnail_lut(adjustments: &Value) -> ResolvedThumbnailLut {
    let Some(path) = thumbnail_lut_path(adjustments) else {
        return ResolvedThumbnailLut {
            request: ThumbnailLutRequest::NotRequested,
            lut: None,
        };
    };

    match crate::lut_processing::load_lut_snapshot(path) {
        Ok(snapshot) => {
            let identity = ThumbnailLutIdentity {
                content_blake3: snapshot.content_blake3,
            };
            ResolvedThumbnailLut {
                request: ThumbnailLutRequest::Available(identity),
                lut: Some(Arc::new(snapshot.lut)),
            }
        }
        Err(error) => {
            log::warn!("Thumbnail LUT '{}' is unavailable: {error}", path);
            ResolvedThumbnailLut {
                request: ThumbnailLutRequest::Unavailable,
                lut: None,
            }
        }
    }
}

fn resolve_thumbnail_lut_request(adjustments: &Value) -> ThumbnailLutRequest {
    resolve_thumbnail_lut(adjustments).request
}

impl ThumbnailPreloadedImage {
    fn into_loaded(self) -> LoadedBaseImage {
        let image = Arc::try_unwrap(self.image).unwrap_or_else(|shared| shared.as_ref().clone());
        LoadedBaseImage {
            image,
            source_kind: self.source_kind,
        }
    }
}

fn resolve_thumbnail_cache_dir(app_handle: &AppHandle) -> std::result::Result<PathBuf, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let thumb_cache_dir = cache_dir.join("thumbnails");
    if !thumb_cache_dir.exists() {
        fs::create_dir_all(&thumb_cache_dir).map_err(|e| e.to_string())?;
    }
    Ok(thumb_cache_dir)
}

fn emit_thumbnail_cache_setup_error(app_handle: &AppHandle, path: &str, reason: &str) {
    let _ = app_handle.emit(
        "thumbnail-generation-error",
        serde_json::json!({ "path": path, "reason": reason }),
    );
}

fn thumbnail_source_timestamp(path: &Path) -> Option<ThumbnailSourceTimestamp> {
    let duration = fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?;
    Some(ThumbnailSourceTimestamp {
        seconds: duration.as_secs(),
        nanoseconds: duration.subsec_nanos(),
    })
}

fn thumbnail_manifest_key(
    virtual_path: &str,
    source_modified: ThumbnailSourceTimestamp,
    persisted_adjustments: &Value,
    camera_defaults: &CameraDefaults,
    render_profile: &ThumbnailRenderProfile,
    lut_request: &ThumbnailLutRequest,
) -> ThumbnailManifestKey {
    ThumbnailManifestKey {
        render_version: THUMBNAIL_RENDER_VERSION.to_string(),
        virtual_path: virtual_path.to_string(),
        source_modified,
        persisted_adjustments: persisted_adjustments.clone(),
        camera_defaults: camera_defaults.clone(),
        render_profile: render_profile.clone(),
        lut_request: lut_request.clone(),
    }
}

fn thumbnail_render_profile(
    settings: &AppSettings,
    is_raw: bool,
    persisted_adjustments: &Value,
    gpu_context_available: bool,
) -> ThumbnailRenderProfile {
    let default_tonemapper = if is_raw {
        settings.default_raw_tonemapper.as_deref().unwrap_or("agx")
    } else {
        settings
            .default_non_raw_tonemapper
            .as_deref()
            .unwrap_or("basic")
    };
    ThumbnailRenderProfile {
        target_width: settings.thumbnail_resolution.unwrap_or(720),
        default_tonemapper: default_tonemapper.to_string(),
        tonemapper_override_enabled: settings.tonemapper_override_enabled.unwrap_or(false),
        raw_highlight_compression: settings.raw_highlight_compression.unwrap_or(2.5),
        linear_raw_mode: settings.linear_raw_mode.clone(),
        raw_preprocessing_color_nr: settings.raw_preprocessing_color_nr.unwrap_or(0.5),
        raw_preprocessing_sharpening: settings.raw_preprocessing_sharpening.unwrap_or(0.35),
        apply_preprocessing_to_non_raws: settings.apply_preprocessing_to_non_raws.unwrap_or(false),
        dispatch: thumbnail_render_path(persisted_adjustments.is_null(), gpu_context_available),
    }
}

fn thumbnail_manifest_key_for_path_with<F>(
    virtual_path: &str,
    persisted_adjustments: &Value,
    render_profile: &ThumbnailRenderProfile,
    lut_request: &ThumbnailLutRequest,
    extract_defaults: F,
) -> Option<ThumbnailManifestKey>
where
    F: FnOnce(&Path) -> CameraDefaults,
{
    let (source_path, _) = parse_virtual_path(virtual_path);
    let source_modified_before = thumbnail_source_timestamp(&source_path)?;
    let camera_defaults = if is_raw_file(&source_path) {
        extract_defaults(&source_path)
    } else {
        CameraDefaults::default()
    };
    let source_modified = thumbnail_source_timestamp(&source_path)?;
    if source_modified != source_modified_before {
        return None;
    }
    Some(thumbnail_manifest_key(
        virtual_path,
        source_modified,
        persisted_adjustments,
        &camera_defaults,
        render_profile,
        lut_request,
    ))
}

fn thumbnail_manifest_key_for_path(
    virtual_path: &str,
    persisted_adjustments: &Value,
    render_profile: &ThumbnailRenderProfile,
    lut_request: &ThumbnailLutRequest,
) -> Option<ThumbnailManifestKey> {
    thumbnail_manifest_key_for_path_with(
        virtual_path,
        persisted_adjustments,
        render_profile,
        lut_request,
        camera_defaults_for_path,
    )
}

fn canonical_thumbnail_hash<T: Serialize>(value: &T) -> Result<String> {
    let bytes =
        serde_json::to_vec(value).context("Failed to serialize thumbnail cache identity")?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

fn thumbnail_manifest_key_hash(key: &ThumbnailManifestKey) -> Result<String> {
    canonical_thumbnail_hash(key)
}

fn thumbnail_cache_identity(key: &ThumbnailManifestKey) -> Result<ThumbnailCacheIdentity> {
    Ok(ThumbnailCacheIdentity {
        key_digest: thumbnail_manifest_key_hash(key)?,
        virtual_path_digest: thumbnail_virtual_path_digest(&key.virtual_path)?,
        requested_render_path: key.render_profile.dispatch,
        requested_lut: key.lut_request.clone(),
    })
}

fn thumbnail_render_fingerprint_hash(fingerprint: &ThumbnailRenderFingerprint) -> Result<String> {
    canonical_thumbnail_hash(fingerprint)
}

fn thumbnail_virtual_path_digest(virtual_path: &str) -> Result<String> {
    canonical_thumbnail_hash(&virtual_path)
}

fn thumbnail_render_fingerprint(
    identity: &ThumbnailCacheIdentity,
    effective_adjustments: &Value,
    source_kind: ImageSourceKind,
    actual_render_path: ThumbnailRenderPath,
    actual_lut_outcome: ThumbnailLutOutcome,
) -> Result<ThumbnailRenderFingerprint> {
    Ok(ThumbnailRenderFingerprint {
        key_digest: identity.key_digest.clone(),
        virtual_path_digest: identity.virtual_path_digest.clone(),
        effective_adjustments_digest: canonical_thumbnail_hash(effective_adjustments)?,
        source_kind,
        requested_render_path: identity.requested_render_path,
        actual_render_path,
        requested_lut: identity.requested_lut.clone(),
        actual_lut_outcome,
    })
}

fn thumbnail_manifest_path(cache_dir: &Path, identity: &ThumbnailCacheIdentity) -> Result<PathBuf> {
    thumbnail_manifest_path_for_digest(cache_dir, &identity.key_digest)
}

fn thumbnail_manifest_path_for_digest(cache_dir: &Path, key_digest: &str) -> Result<PathBuf> {
    ensure!(
        thumbnail_digest_is_valid(key_digest),
        "Invalid thumbnail key digest"
    );
    Ok(cache_dir.join(format!("{key_digest}.thumbnail-manifest.json")))
}

fn thumbnail_digest_is_valid(digest: &str) -> bool {
    digest.len() == blake3::OUT_LEN * 2 && blake3::Hash::from_hex(digest).is_ok()
}

fn thumbnail_jpeg_digest(jpeg_bytes: &[u8]) -> String {
    blake3::hash(jpeg_bytes).to_hex().to_string()
}

fn thumbnail_jpeg_filename(
    fingerprint: &ThumbnailRenderFingerprint,
    jpeg_digest: &str,
) -> Result<String> {
    ensure!(
        thumbnail_digest_is_valid(jpeg_digest),
        "Invalid thumbnail JPEG digest"
    );
    Ok(format!(
        "{}.{jpeg_digest}.jpg",
        thumbnail_render_fingerprint_hash(fingerprint)?,
    ))
}

fn thumbnail_transient_jpeg_path(
    cache_dir: &Path,
    fingerprint: &ThumbnailRenderFingerprint,
    jpeg_digest: &str,
) -> Result<PathBuf> {
    ensure!(
        thumbnail_digest_is_valid(jpeg_digest),
        "Invalid thumbnail JPEG digest"
    );
    Ok(cache_dir.join(format!(
        "{}.{jpeg_digest}.transient.jpg",
        thumbnail_render_fingerprint_hash(fingerprint)?,
    )))
}

fn thumbnail_fingerprint_matches_identity(
    fingerprint: &ThumbnailRenderFingerprint,
    identity: &ThumbnailCacheIdentity,
) -> bool {
    fingerprint.key_digest == identity.key_digest
        && fingerprint.virtual_path_digest == identity.virtual_path_digest
        && fingerprint.requested_render_path == identity.requested_render_path
        && fingerprint.requested_lut == identity.requested_lut
}

fn thumbnail_fingerprint_is_reusable(
    fingerprint: &ThumbnailRenderFingerprint,
    identity: &ThumbnailCacheIdentity,
) -> bool {
    thumbnail_fingerprint_matches_identity(fingerprint, identity)
        && thumbnail_fingerprint_has_reusable_outcome(fingerprint)
}

fn thumbnail_fingerprint_has_reusable_outcome(fingerprint: &ThumbnailRenderFingerprint) -> bool {
    fingerprint.actual_render_path == fingerprint.requested_render_path
        && match (&fingerprint.requested_lut, &fingerprint.actual_lut_outcome) {
            (ThumbnailLutRequest::NotRequested, ThumbnailLutOutcome::NotRequested) => true,
            (ThumbnailLutRequest::Available(requested), ThumbnailLutOutcome::Applied(applied)) => {
                requested == applied
            }
            _ => false,
        }
}

fn thumbnail_jpeg_bytes_are_valid(bytes: &[u8], expected_digest: &str) -> bool {
    bytes.len() as u64 <= THUMBNAIL_JPEG_MAX_BYTES
        && thumbnail_jpeg_digest(bytes) == expected_digest
        && image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).is_ok()
}

fn lookup_thumbnail_manifest(
    cache_dir: &Path,
    expected_identity: &ThumbnailCacheIdentity,
) -> Option<ThumbnailCacheHit> {
    let manifest_path = thumbnail_manifest_path(cache_dir, expected_identity).ok()?;
    if fs::metadata(&manifest_path).ok()?.len() > THUMBNAIL_MANIFEST_MAX_BYTES {
        return None;
    }
    let manifest: ThumbnailManifest =
        serde_json::from_slice(&fs::read(&manifest_path).ok()?).ok()?;
    if manifest.schema_version != THUMBNAIL_MANIFEST_SCHEMA_VERSION
        || !thumbnail_fingerprint_is_reusable(&manifest.fingerprint, expected_identity)
        || !thumbnail_digest_is_valid(&manifest.fingerprint.effective_adjustments_digest)
        || !thumbnail_digest_is_valid(&manifest.jpeg_digest)
        || manifest.jpeg_byte_len > THUMBNAIL_JPEG_MAX_BYTES
    {
        return None;
    }

    let jpeg_filename =
        thumbnail_jpeg_filename(&manifest.fingerprint, &manifest.jpeg_digest).ok()?;
    let jpeg_path = cache_dir.join(&jpeg_filename);
    let jpeg_metadata = fs::metadata(&jpeg_path).ok()?;
    if !jpeg_metadata.is_file() || jpeg_metadata.len() != manifest.jpeg_byte_len {
        return None;
    }
    let jpeg_bytes = fs::read(&jpeg_path).ok()?;
    if !thumbnail_jpeg_bytes_are_valid(&jpeg_bytes, &manifest.jpeg_digest) {
        return None;
    }

    Some(ThumbnailCacheHit {
        manifest_path: Some(manifest_path),
        jpeg_path,
    })
}

fn flushed_tempfile(cache_dir: &Path, bytes: &[u8]) -> Result<NamedTempFile> {
    let mut temp = tempfile::Builder::new()
        .prefix(".thumbnail-stage-")
        .tempfile_in(cache_dir)?;
    temp.write_all(bytes)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    Ok(temp)
}

fn persist_immutable_thumbnail_jpeg(
    cache_dir: &Path,
    jpeg_path: &Path,
    jpeg_bytes: &[u8],
    jpeg_digest: &str,
) -> Result<()> {
    ensure!(
        thumbnail_jpeg_bytes_are_valid(jpeg_bytes, jpeg_digest),
        "Thumbnail encoder produced invalid JPEG bytes"
    );
    let jpeg_temp = flushed_tempfile(cache_dir, jpeg_bytes)?;
    match jpeg_temp.persist_noclobber(jpeg_path) {
        Ok(file) => file.sync_all()?,
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            let should_replace = match fs::read(jpeg_path) {
                Ok(existing) => !thumbnail_jpeg_bytes_are_valid(&existing, jpeg_digest),
                Err(read_error) if read_error.kind() == std::io::ErrorKind::NotFound => true,
                Err(read_error) => return Err(read_error.into()),
            };
            if should_replace {
                error
                    .file
                    .persist(jpeg_path)
                    .map_err(|error| error.error)?
                    .sync_all()?;
            }
        }
        Err(error) => return Err(error.error.into()),
    }
    Ok(())
}

fn publish_thumbnail_cache_with_recheck<F>(
    cache_dir: &Path,
    fingerprint: &ThumbnailRenderFingerprint,
    jpeg_bytes: &[u8],
    recheck_key: F,
) -> Result<ThumbnailCacheHit>
where
    F: FnOnce() -> Option<ThumbnailCacheIdentity>,
{
    fs::create_dir_all(cache_dir)?;
    let jpeg_digest = thumbnail_jpeg_digest(jpeg_bytes);
    let jpeg_filename = thumbnail_jpeg_filename(fingerprint, &jpeg_digest)?;
    let jpeg_path = cache_dir.join(&jpeg_filename);
    persist_immutable_thumbnail_jpeg(cache_dir, &jpeg_path, jpeg_bytes, &jpeg_digest)?;

    let manifest = ThumbnailManifest {
        schema_version: THUMBNAIL_MANIFEST_SCHEMA_VERSION,
        fingerprint: fingerprint.clone(),
        jpeg_digest,
        jpeg_byte_len: jpeg_bytes.len() as u64,
    };
    let manifest_path = thumbnail_manifest_path_for_digest(cache_dir, &fingerprint.key_digest)?;
    let manifest_temp = flushed_tempfile(cache_dir, &serde_json::to_vec(&manifest)?)?;
    let rechecked_identity = recheck_key().context("Thumbnail source changed during generation")?;
    ensure!(
        thumbnail_fingerprint_matches_identity(fingerprint, &rechecked_identity),
        "Thumbnail source changed during generation"
    );
    manifest_temp
        .persist(&manifest_path)
        .map_err(|error| error.error)?
        .sync_all()?;

    lookup_thumbnail_manifest(cache_dir, &rechecked_identity)
        .context("Published thumbnail manifest did not validate")
}

fn publish_transient_thumbnail_with_recheck<F>(
    cache_dir: &Path,
    fingerprint: &ThumbnailRenderFingerprint,
    jpeg_bytes: &[u8],
    recheck_key: F,
) -> Result<ThumbnailCacheHit>
where
    F: FnOnce() -> Option<ThumbnailCacheIdentity>,
{
    fs::create_dir_all(cache_dir)?;
    let jpeg_digest = thumbnail_jpeg_digest(jpeg_bytes);
    let jpeg_path = thumbnail_transient_jpeg_path(cache_dir, fingerprint, &jpeg_digest)?;
    persist_immutable_thumbnail_jpeg(cache_dir, &jpeg_path, jpeg_bytes, &jpeg_digest)?;
    let rechecked_identity = recheck_key().context("Thumbnail source changed during generation")?;
    ensure!(
        thumbnail_fingerprint_matches_identity(fingerprint, &rechecked_identity),
        "Thumbnail source changed during generation"
    );
    Ok(ThumbnailCacheHit {
        manifest_path: None,
        jpeg_path,
    })
}

fn resolve_thumbnail_cache_with<F, R>(
    cache_dir: &Path,
    identity: &ThumbnailCacheIdentity,
    force_regenerate: bool,
    generate: F,
    recheck_key: R,
) -> Result<ThumbnailCacheHit>
where
    F: FnOnce() -> Result<(ThumbnailRenderFingerprint, Vec<u8>)>,
    R: FnOnce() -> Option<ThumbnailCacheIdentity>,
{
    if !force_regenerate && let Some(hit) = lookup_thumbnail_manifest(cache_dir, identity) {
        return Ok(hit);
    }

    let (fingerprint, jpeg_bytes) = generate()?;
    ensure!(
        thumbnail_fingerprint_matches_identity(&fingerprint, identity),
        "Thumbnail fingerprint did not contain the requested manifest key"
    );
    if thumbnail_fingerprint_is_reusable(&fingerprint, identity) {
        publish_thumbnail_cache_with_recheck(cache_dir, &fingerprint, &jpeg_bytes, recheck_key)
    } else {
        publish_transient_thumbnail_with_recheck(cache_dir, &fingerprint, &jpeg_bytes, recheck_key)
    }
}

#[derive(Clone)]
struct ThumbnailCleanupManifestEntry {
    manifest_path: PathBuf,
    jpeg_path: PathBuf,
    virtual_path_digest: String,
    modified: SystemTime,
}

struct ThumbnailCleanupUnit {
    modified: SystemTime,
    sort_name: String,
    paths: Vec<PathBuf>,
}

fn thumbnail_manifest_key_digest_from_name(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    let digest = name.strip_suffix(".thumbnail-manifest.json")?;
    thumbnail_digest_is_valid(digest).then_some(digest)
}

fn thumbnail_recognized_jpeg_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let stem = name
        .strip_suffix(".transient.jpg")
        .or_else(|| name.strip_suffix(".jpg"));
    let Some(stem) = stem else {
        return false;
    };
    let mut parts = stem.split('.');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(fingerprint), None, None) => thumbnail_digest_is_valid(fingerprint),
        (Some(fingerprint), Some(jpeg), None) => {
            thumbnail_digest_is_valid(fingerprint) && thumbnail_digest_is_valid(jpeg)
        }
        _ => false,
    }
}

fn thumbnail_recognized_staging_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".thumbnail-stage-"))
}

fn thumbnail_lut_request_digest_is_valid(request: &ThumbnailLutRequest) -> bool {
    match request {
        ThumbnailLutRequest::Available(identity) => {
            thumbnail_digest_is_valid(&identity.content_blake3)
        }
        ThumbnailLutRequest::NotRequested | ThumbnailLutRequest::Unavailable => true,
    }
}

fn thumbnail_lut_outcome_digest_is_valid(outcome: &ThumbnailLutOutcome) -> bool {
    match outcome {
        ThumbnailLutOutcome::Applied(identity) => {
            thumbnail_digest_is_valid(&identity.content_blake3)
        }
        ThumbnailLutOutcome::NotRequested
        | ThumbnailLutOutcome::Unavailable
        | ThumbnailLutOutcome::NotApplied => true,
    }
}

fn thumbnail_cleanup_manifest_entry(
    cache_dir: &Path,
    manifest_path: &Path,
) -> Option<ThumbnailCleanupManifestEntry> {
    let filename_key_digest = thumbnail_manifest_key_digest_from_name(manifest_path)?;
    let metadata = fs::metadata(manifest_path).ok()?;
    if !metadata.is_file() || metadata.len() > THUMBNAIL_MANIFEST_MAX_BYTES {
        return None;
    }
    let manifest: ThumbnailManifest =
        serde_json::from_slice(&fs::read(manifest_path).ok()?).ok()?;
    if manifest.schema_version != THUMBNAIL_MANIFEST_SCHEMA_VERSION
        || manifest.fingerprint.key_digest != filename_key_digest
        || !thumbnail_digest_is_valid(&manifest.fingerprint.key_digest)
        || !thumbnail_digest_is_valid(&manifest.fingerprint.virtual_path_digest)
        || !thumbnail_digest_is_valid(&manifest.fingerprint.effective_adjustments_digest)
        || !thumbnail_lut_request_digest_is_valid(&manifest.fingerprint.requested_lut)
        || !thumbnail_lut_outcome_digest_is_valid(&manifest.fingerprint.actual_lut_outcome)
        || !thumbnail_fingerprint_has_reusable_outcome(&manifest.fingerprint)
        || !thumbnail_digest_is_valid(&manifest.jpeg_digest)
        || manifest.jpeg_byte_len > THUMBNAIL_JPEG_MAX_BYTES
    {
        return None;
    }

    let jpeg_filename =
        thumbnail_jpeg_filename(&manifest.fingerprint, &manifest.jpeg_digest).ok()?;
    let jpeg_path = cache_dir.join(jpeg_filename);
    let jpeg_metadata = fs::metadata(&jpeg_path).ok()?;
    if !jpeg_metadata.is_file() || jpeg_metadata.len() != manifest.jpeg_byte_len {
        return None;
    }
    let jpeg_bytes = fs::read(&jpeg_path).ok()?;
    if !thumbnail_jpeg_bytes_are_valid(&jpeg_bytes, &manifest.jpeg_digest) {
        return None;
    }

    Some(ThumbnailCleanupManifestEntry {
        manifest_path: manifest_path.to_path_buf(),
        jpeg_path,
        virtual_path_digest: manifest.fingerprint.virtual_path_digest,
        modified: metadata.modified().unwrap_or(UNIX_EPOCH),
    })
}

fn thumbnail_path_is_old_enough(path: &Path, cutoff: SystemTime) -> bool {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .is_some_and(|modified| modified <= cutoff)
}

fn remove_thumbnail_cleanup_units_with<F>(
    units: Vec<ThumbnailCleanupUnit>,
    max_removed_entries: usize,
    mut remove_file: F,
) -> Vec<PathBuf>
where
    F: FnMut(&Path) -> std::io::Result<()>,
{
    let mut removed = Vec::new();
    for unit in units {
        if removed.len() + unit.paths.len() > max_removed_entries {
            break;
        }
        for path in unit.paths {
            match remove_file(&path) {
                Ok(()) => removed.push(path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    log::warn!(
                        "Could not remove stale thumbnail artifact '{}': {error}",
                        path.display()
                    );
                    break;
                }
            }
        }
    }
    removed
}

fn cleanup_stale_thumbnail_artifacts_with(
    cache_dir: &Path,
    now: SystemTime,
    grace: Duration,
    max_removed_entries: usize,
    retain_versions_per_virtual_path: usize,
) -> Result<Vec<PathBuf>> {
    if !cache_dir.exists() || max_removed_entries == 0 {
        return Ok(Vec::new());
    }
    let cutoff = now.checked_sub(grace).unwrap_or(UNIX_EPOCH);
    let mut paths: Vec<PathBuf> = fs::read_dir(cache_dir)?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    paths.sort();

    let mut valid_entries = Vec::new();
    let mut valid_manifest_paths = HashSet::new();
    let mut all_valid_referenced_jpegs = HashSet::new();
    for path in &paths {
        if thumbnail_manifest_key_digest_from_name(path).is_some()
            && let Some(entry) = thumbnail_cleanup_manifest_entry(cache_dir, path)
        {
            valid_manifest_paths.insert(entry.manifest_path.clone());
            all_valid_referenced_jpegs.insert(entry.jpeg_path.clone());
            valid_entries.push(entry);
        }
    }

    let mut grouped: HashMap<String, Vec<ThumbnailCleanupManifestEntry>> = HashMap::new();
    for entry in valid_entries {
        grouped
            .entry(entry.virtual_path_digest.clone())
            .or_default()
            .push(entry);
    }

    let mut stale_valid_entries = Vec::new();
    let mut retained_jpegs = HashSet::new();
    for entries in grouped.values_mut() {
        entries.sort_by(|left, right| {
            right.modified.cmp(&left.modified).then_with(|| {
                right
                    .manifest_path
                    .file_name()
                    .cmp(&left.manifest_path.file_name())
            })
        });
        for (index, entry) in entries.iter().enumerate() {
            if index < retain_versions_per_virtual_path
                || !thumbnail_path_is_old_enough(&entry.manifest_path, cutoff)
                || !thumbnail_path_is_old_enough(&entry.jpeg_path, cutoff)
            {
                retained_jpegs.insert(entry.jpeg_path.clone());
            } else {
                stale_valid_entries.push(entry.clone());
            }
        }
    }

    let mut units = Vec::new();
    let mut assigned_stale_jpegs = HashSet::new();
    for entry in stale_valid_entries {
        let mut unit_paths = vec![entry.manifest_path.clone()];
        if !retained_jpegs.contains(&entry.jpeg_path)
            && assigned_stale_jpegs.insert(entry.jpeg_path.clone())
        {
            unit_paths.push(entry.jpeg_path.clone());
        }
        units.push(ThumbnailCleanupUnit {
            modified: entry.modified,
            sort_name: entry
                .manifest_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string(),
            paths: unit_paths,
        });
    }

    for path in &paths {
        let recognized_manifest = thumbnail_manifest_key_digest_from_name(path).is_some();
        let recognized_orphan_jpeg =
            thumbnail_recognized_jpeg_name(path) && !all_valid_referenced_jpegs.contains(path);
        let recognized_staging = thumbnail_recognized_staging_name(path);
        let invalid_manifest = recognized_manifest && !valid_manifest_paths.contains(path);
        if (invalid_manifest || recognized_orphan_jpeg || recognized_staging)
            && thumbnail_path_is_old_enough(path, cutoff)
        {
            units.push(ThumbnailCleanupUnit {
                modified: fs::metadata(path)
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .unwrap_or(UNIX_EPOCH),
                sort_name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string(),
                paths: vec![path.clone()],
            });
        }
    }

    units.sort_by(|left, right| {
        left.modified
            .cmp(&right.modified)
            .then_with(|| left.sort_name.cmp(&right.sort_name))
    });
    Ok(remove_thumbnail_cleanup_units_with(
        units,
        max_removed_entries,
        |path| fs::remove_file(path),
    ))
}

pub(crate) fn cleanup_thumbnail_cache_on_startup(app_handle: &AppHandle) {
    let Ok(cache_dir) = get_thumb_cache_dir(app_handle) else {
        return;
    };
    match cleanup_stale_thumbnail_artifacts_with(
        &cache_dir,
        SystemTime::now(),
        THUMBNAIL_CACHE_CLEANUP_GRACE,
        THUMBNAIL_CACHE_CLEANUP_MAX_ENTRIES,
        THUMBNAIL_CACHE_RETENTION_PER_PATH,
    ) {
        Ok(removed) if !removed.is_empty() => {
            log::info!("Removed {} stale thumbnail cache artifacts", removed.len());
        }
        Ok(_) => {}
        Err(error) => log::warn!("Could not clean thumbnail cache on startup: {error}"),
    }
}

fn resolve_image_metadata(
    image_path: &Path,
    sidecar_path: &Path,
    enable_xmp_sync: bool,
    settings: &AppSettings,
) -> (bool, Option<Vec<String>>, u8) {
    let mut metadata = crate::exif_processing::load_sidecar(sidecar_path);

    if enable_xmp_sync
        && sync_metadata_from_xmp(image_path, &mut metadata)
        && let Ok(json) = serde_json::to_string_pretty(&metadata)
    {
        let _ = fs::write(sidecar_path, json);
    }

    let is_raw = crate::formats::is_raw_file(image_path);
    let tm_override = crate::image_processing::resolve_tonemapper_override(settings, is_raw);
    let edited =
        crate::image_processing::is_image_edited(&metadata.adjustments, is_raw, tm_override);
    (edited, metadata.tags, metadata.rating)
}

fn emit_image_metadata_loaded(
    app_handle: &AppHandle,
    path: &str,
    rating: u8,
    is_edited: bool,
    tags: &Option<Vec<String>>,
) {
    let _ = app_handle.emit(
        "image-metadata-loaded",
        serde_json::json!({ "path": path, "rating": rating, "is_edited": is_edited, "tags": tags }),
    );
}

fn enqueue_metadata(
    app_handle: &AppHandle,
    virtual_path: String,
    image_path: PathBuf,
    sidecar_path: PathBuf,
) {
    let state = app_handle.state::<crate::AppState>();
    let manager = &state.metadata_manager;

    let mut pending = manager.pending.lock().unwrap();
    if !pending.insert(sidecar_path.clone()) {
        return;
    }
    drop(pending);

    manager.queue.lock().unwrap().push_back(PendingMetadata {
        virtual_path,
        image_path,
        sidecar_path,
    });
    manager.cvar.notify_one();
}

// Not compute-heavy — these threads mostly block waiting on iCloud to
// materialize a file, not burning CPU — so a small fixed pool is enough and
// doesn't need a user-facing setting the way thumbnail_worker_threads does.
const METADATA_WORKER_THREADS: usize = 4;

pub fn start_metadata_workers(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<crate::AppState>();
    let manager = state.metadata_manager.clone();

    for _ in 0..METADATA_WORKER_THREADS {
        let app_clone = app_handle.clone();
        let manager_clone = manager.clone();

        std::thread::spawn(move || {
            loop {
                let item = {
                    let mut queue = manager_clone.queue.lock().unwrap();
                    while queue.is_empty() {
                        queue = manager_clone.cvar.wait(queue).unwrap();
                    }
                    queue.pop_front().unwrap()
                };

                let settings = load_settings(app_clone.clone()).unwrap_or_default();
                let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);

                let (is_edited, tags, rating) = resolve_image_metadata(
                    &item.image_path,
                    &item.sidecar_path,
                    enable_xmp_sync,
                    &settings,
                );

                emit_image_metadata_loaded(
                    &app_clone,
                    &item.virtual_path,
                    rating,
                    is_edited,
                    &tags,
                );

                manager_clone
                    .pending
                    .lock()
                    .unwrap()
                    .remove(&item.sidecar_path);
            }
        });
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub adjustments: Value,
    #[serde(rename = "includeMasks", skip_serializing_if = "Option::is_none")]
    pub include_masks: Option<bool>,
    #[serde(
        rename = "includeCropTransform",
        skip_serializing_if = "Option::is_none"
    )]
    pub include_crop_transform: Option<bool>,
    #[serde(rename = "presetType", skip_serializing_if = "Option::is_none")]
    pub preset_type: Option<String>,
}

#[derive(Serialize)]
struct ExportPresetFile<'a> {
    creator: &'a str,
    presets: &'a [PresetItem],
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PresetFolder {
    pub id: String,
    pub name: String,
    pub children: Vec<Preset>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum PresetItem {
    Preset(Preset),
    Folder(PresetFolder),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PresetFile {
    pub presets: Vec<PresetItem>,
}

#[derive(Debug)]
pub enum ReadFileError {
    Io(std::io::Error),
    Locked,
    Empty,
    NotFound,
    Invalid,
}

impl fmt::Display for ReadFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadFileError::Io(err) => write!(f, "IO error: {}", err),
            ReadFileError::Locked => write!(f, "File is locked"),
            ReadFileError::Empty => write!(f, "File is empty"),
            ReadFileError::NotFound => write!(f, "File not found"),
            ReadFileError::Invalid => write!(f, "Invalid file"),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageFile {
    path: String,
    modified: u64,
    is_edited: bool,
    rating: u8,
    tags: Option<Vec<String>>,
    exif: Option<HashMap<String, String>>,
    is_virtual_copy: bool,
    is_cloud_placeholder: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSettings {
    pub filename_template: String,
    pub organize_by_date: bool,
    pub date_folder_format: String,
    pub delete_after_import: bool,
}

pub fn parse_virtual_path(virtual_path: &str) -> (PathBuf, PathBuf) {
    let (source_path_str, copy_id) = if let Some((base, id)) = virtual_path.rsplit_once("?vc=") {
        (base.to_string(), Some(id.to_string()))
    } else {
        (virtual_path.to_string(), None)
    };

    let source_path = PathBuf::from(source_path_str);

    let sidecar_filename = if let Some(id) = copy_id {
        format!(
            "{}.{}.rrdata",
            source_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            &id
        )
    } else {
        format!(
            "{}.rrdata",
            source_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        )
    };

    let sidecar_path = source_path.with_file_name(sidecar_filename);
    (source_path, sidecar_path)
}

#[tauri::command]
pub async fn read_exif_for_paths(
    paths: Vec<String>,
) -> Result<HashMap<String, HashMap<String, String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exif_data: HashMap<String, HashMap<String, String>> = paths
            .par_iter()
            .filter_map(|virtual_path| {
                let (source_path, _) = parse_virtual_path(virtual_path);
                let source_path_str = source_path.to_string_lossy().to_string();

                let map = if let Some(sidecar_exif) =
                    crate::exif_processing::read_rrexif_sidecar(&source_path)
                {
                    sidecar_exif
                } else if is_cloud_placeholder(&source_path) {
                    HashMap::new()
                } else if let Ok(mmap) = read_file_mapped(&source_path) {
                    crate::exif_processing::read_exif_data(&source_path_str, &mmap)
                } else if let Ok(bytes) = fs::read(&source_path) {
                    crate::exif_processing::read_exif_data(&source_path_str, &bytes)
                } else {
                    HashMap::new()
                };

                if map.is_empty() {
                    None
                } else {
                    Some((virtual_path.clone(), map))
                }
            })
            .collect();

        Ok(exif_data)
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
}

#[tauri::command]
pub async fn update_exif_fields(
    paths: Vec<String>,
    updates: HashMap<String, String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths.par_iter().for_each(|path| {
            let original_path = Path::new(&path);
            let primary_path = crate::exif_processing::get_primary_sidecar_path(original_path);
            let temp_metadata = crate::exif_processing::load_sidecar(&primary_path);

            let mut exif_data = temp_metadata.exif.unwrap_or_else(|| {
                if let Some(existing) = crate::exif_processing::read_rrexif_sidecar(original_path) {
                    existing
                } else if let Ok(mmap) = read_file_mapped(original_path) {
                    crate::exif_processing::read_exif_data_from_bytes(path, &mmap)
                } else if let Ok(bytes) = fs::read(original_path) {
                    crate::exif_processing::read_exif_data_from_bytes(path, &bytes)
                } else {
                    HashMap::new()
                }
            });

            for (k, v) in &updates {
                let trimmed = v.trim();
                if trimmed.is_empty() {
                    exif_data.remove(k);
                } else {
                    exif_data.insert(k.clone(), trimmed.to_string());
                }
            }

            let mut final_metadata = crate::exif_processing::load_sidecar(&primary_path);

            final_metadata.exif = Some(exif_data);
            if let Ok(json) = serde_json::to_string_pretty(&final_metadata) {
                let _ = std::fs::write(&primary_path, json);
            }
        });
        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub fn list_images_in_dir(path: String, app_handle: AppHandle) -> Result<Vec<ImageFile>, String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);

    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut images = Vec::new();
    let mut sidecars_by_filename: HashMap<String, Vec<Option<String>>> = HashMap::new();

    for entry in entries.filter_map(Result::ok) {
        let entry_path = entry.path();
        let file_name = entry
            .file_name()
            .into_string()
            .unwrap_or_else(|os| os.to_string_lossy().into_owned());

        if file_name.ends_with(".rrdata") {
            let base = &file_name[..file_name.len() - 7];

            let (source_filename, copy_id) =
                if base.len() >= 7 && base.as_bytes()[base.len() - 7] == b'.' {
                    let id = &base[base.len() - 6..];
                    if id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
                        (&base[..base.len() - 7], Some(id.to_string()))
                    } else {
                        (base, None)
                    }
                } else {
                    (base, None)
                };

            sidecars_by_filename
                .entry(source_filename.to_string())
                .or_default()
                .push(copy_id);
        } else if is_supported_image_file(&file_name) {
            images.push((file_name, entry_path));
        }
    }

    let tasks: Vec<_> = images
        .into_iter()
        .map(|(file_name, path_buf)| {
            let sidecars = sidecars_by_filename
                .remove(&file_name)
                .unwrap_or_else(|| vec![None]);
            let path_str = path_buf.to_string_lossy().into_owned();
            (path_str, file_name, path_buf, sidecars)
        })
        .collect();

    let result_list: Vec<ImageFile> = tasks
        .into_par_iter()
        .flat_map(|(path_str, file_name, path_buf, sidecars)| {
            let modified = fs::metadata(&path_buf)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let is_cloud_placeholder = is_cloud_placeholder(&path_buf);

            let mut file_results = Vec::with_capacity(sidecars.len());

            for copy_id_opt in sidecars {
                let (virtual_path, is_virtual_copy, sidecar_filename) = match copy_id_opt {
                    Some(id) => (
                        format!("{}?vc={}", path_str, id),
                        true,
                        format!("{}.{}.rrdata", file_name, id),
                    ),
                    None => (path_str.clone(), false, format!("{}.rrdata", file_name)),
                };

                let sidecar_path = path_buf.with_file_name(sidecar_filename);

                let xmp_is_placeholder = enable_xmp_sync
                    && resolve_xmp_path(&path_buf)
                        .is_some_and(|p| crate::file_management::is_cloud_placeholder(&p));

                let (is_edited, tags, rating) =
                    if crate::file_management::is_cloud_placeholder(&sidecar_path)
                        || xmp_is_placeholder
                    {
                        enqueue_metadata(
                            &app_handle,
                            virtual_path.clone(),
                            path_buf.clone(),
                            sidecar_path.clone(),
                        );
                        (false, None, 0)
                    } else {
                        resolve_image_metadata(&path_buf, &sidecar_path, enable_xmp_sync, &settings)
                    };

                file_results.push(ImageFile {
                    path: virtual_path,
                    modified,
                    is_edited,
                    tags,
                    exif: None,
                    is_virtual_copy,
                    rating,
                    is_cloud_placeholder,
                });
            }

            file_results
        })
        .collect();

    Ok(result_list)
}

#[tauri::command]
pub fn list_images_recursive(
    path: String,
    app_handle: AppHandle,
) -> Result<Vec<ImageFile>, String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);

    let root_path = Path::new(&path);
    let mut images = Vec::new();

    let mut sidecars_by_path: HashMap<PathBuf, Vec<Option<String>>> = HashMap::new();

    for entry in WalkDir::new(root_path).into_iter().filter_map(Result::ok) {
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }

        let file_name = entry_path.file_name().unwrap_or_default().to_string_lossy();
        if let Some(base) = file_name.strip_suffix(".rrdata") {
            let (source_filename, copy_id) =
                if base.len() >= 7 && base.as_bytes()[base.len() - 7] == b'.' {
                    let id = &base[base.len() - 6..];
                    if id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
                        (&base[..base.len() - 7], Some(id.to_string()))
                    } else {
                        (base, None)
                    }
                } else {
                    (base, None)
                };

            if let Some(parent) = entry_path.parent() {
                sidecars_by_path
                    .entry(parent.join(source_filename))
                    .or_default()
                    .push(copy_id);
            }
        } else if is_supported_image_file(entry_path.to_string_lossy().as_ref()) {
            images.push(entry_path.to_path_buf());
        }
    }

    let tasks: Vec<_> = images
        .into_iter()
        .map(|path_buf| {
            let sidecars = sidecars_by_path
                .remove(&path_buf)
                .unwrap_or_else(|| vec![None]);
            let path_str = path_buf.to_string_lossy().into_owned();
            let file_name = path_buf
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            (path_str, file_name, path_buf, sidecars)
        })
        .collect();

    let result_list: Vec<ImageFile> = tasks
        .into_par_iter()
        .flat_map(|(path_str, file_name, path_buf, sidecars)| {
            let modified = fs::metadata(&path_buf)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let is_cloud_placeholder = is_cloud_placeholder(&path_buf);

            let mut file_results = Vec::with_capacity(sidecars.len());

            for copy_id_opt in sidecars {
                let (virtual_path, is_virtual_copy, sidecar_filename) = match copy_id_opt {
                    Some(id) => (
                        format!("{}?vc={}", path_str, id),
                        true,
                        format!("{}.{}.rrdata", file_name, id),
                    ),
                    None => (path_str.clone(), false, format!("{}.rrdata", file_name)),
                };

                let sidecar_path = path_buf.with_file_name(sidecar_filename);

                let xmp_is_placeholder = enable_xmp_sync
                    && resolve_xmp_path(&path_buf)
                        .is_some_and(|p| crate::file_management::is_cloud_placeholder(&p));

                let (is_edited, tags, rating) =
                    if crate::file_management::is_cloud_placeholder(&sidecar_path)
                        || xmp_is_placeholder
                    {
                        enqueue_metadata(
                            &app_handle,
                            virtual_path.clone(),
                            path_buf.clone(),
                            sidecar_path.clone(),
                        );
                        (false, None, 0)
                    } else {
                        resolve_image_metadata(&path_buf, &sidecar_path, enable_xmp_sync, &settings)
                    };

                file_results.push(ImageFile {
                    path: virtual_path,
                    modified,
                    is_edited,
                    tags,
                    exif: None,
                    is_virtual_copy,
                    rating,
                    is_cloud_placeholder,
                });
            }

            file_results
        })
        .collect();

    Ok(result_list)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AlbumItem {
    Album {
        id: String,
        name: String,
        icon: Option<String>,
        images: Vec<String>,
    },
    Group {
        id: String,
        name: String,
        icon: Option<String>,
        children: Vec<AlbumItem>,
    },
}

fn get_albums_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let albums_dir = data_dir.join("albums");
    if !albums_dir.exists() {
        fs::create_dir_all(&albums_dir).map_err(|e| e.to_string())?;
    }
    Ok(albums_dir.join("albums.json"))
}

pub fn sort_album_tree(items: &mut [AlbumItem]) {
    items.sort_by(|a, b| {
        let get_sort_key = |item: &AlbumItem| match item {
            AlbumItem::Group { name, .. } => (0, name.to_lowercase()),
            AlbumItem::Album { name, .. } => (1, name.to_lowercase()),
        };

        let key_a = get_sort_key(a);
        let key_b = get_sort_key(b);

        key_a.cmp(&key_b)
    });

    for item in items.iter_mut() {
        if let AlbumItem::Group { children, .. } = item {
            sort_album_tree(children);
        }
    }
}

#[tauri::command]
pub fn get_albums(app_handle: AppHandle) -> Result<Vec<AlbumItem>, String> {
    let path = get_albums_path(&app_handle)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut items: Vec<AlbumItem> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    sort_album_tree(&mut items);
    Ok(items)
}

#[tauri::command]
pub fn save_albums(mut tree: Vec<AlbumItem>, app_handle: AppHandle) -> Result<(), String> {
    let path = get_albums_path(&app_handle)?;
    sort_album_tree(&mut tree);
    let json_string = serde_json::to_string_pretty(&tree).map_err(|e| e.to_string())?;
    fs::write(path, json_string).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_to_album(
    album_id: String,
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let mut tree = get_albums(app_handle.clone())?;

    fn add_recursive(items: &mut [AlbumItem], target_id: &str, paths_to_add: &Vec<String>) -> bool {
        for item in items.iter_mut() {
            #[allow(clippy::collapsible_match)]
            match item {
                AlbumItem::Album { id, images, .. } if id == target_id => {
                    for p in paths_to_add {
                        if !images.contains(p) {
                            images.push(p.clone());
                        }
                    }
                    return true;
                }
                AlbumItem::Group { children, .. } => {
                    if add_recursive(children, target_id, paths_to_add) {
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }

    if add_recursive(&mut tree, &album_id, &paths) {
        save_albums(tree, app_handle)?;
    }
    Ok(())
}

fn sync_album_path_changes(
    app_handle: &AppHandle,
    renames: Option<&HashMap<String, String>>,
    deletions: Option<&HashSet<String>>,
    folder_rename: Option<(&str, &str)>,
) {
    if let Ok(mut tree) = get_albums(app_handle.clone()) {
        let mut changed = false;

        fn process_nodes(
            nodes: &mut [AlbumItem],
            renames: Option<&HashMap<String, String>>,
            deletions: Option<&HashSet<String>>,
            folder_rename: Option<(&str, &str)>,
            changed: &mut bool,
        ) {
            for node in nodes.iter_mut() {
                match node {
                    AlbumItem::Album { images, .. } => {
                        let mut new_images = Vec::new();

                        for img in images.drain(..) {
                            let mut current_img = img;

                            if let Some((old_folder, new_folder)) = folder_rename {
                                let img_path = Path::new(&current_img);
                                let old_path = Path::new(old_folder);
                                if let Ok(stripped) = img_path.strip_prefix(old_path) {
                                    let new_img_path = Path::new(new_folder).join(stripped);
                                    current_img = new_img_path.to_string_lossy().into_owned();
                                    *changed = true;
                                }
                            }

                            if let Some(r) = renames {
                                if let Some(new_path) = r.get(&current_img) {
                                    current_img = new_path.clone();
                                    *changed = true;
                                } else if let Some((base_path, vc_id)) =
                                    current_img.rsplit_once("?vc=")
                                    && let Some(new_base) = r.get(base_path)
                                {
                                    current_img = format!("{}?vc={}", new_base, vc_id);
                                    *changed = true;
                                }
                            }

                            let mut is_deleted = false;
                            if let Some(d) = deletions {
                                if d.contains(&current_img) {
                                    is_deleted = true;
                                } else {
                                    let img_path = Path::new(&current_img);
                                    for del_path_str in d {
                                        let del_path = Path::new(del_path_str);
                                        if img_path.starts_with(del_path) {
                                            is_deleted = true;
                                            break;
                                        }

                                        if let Some((base_path, _)) =
                                            current_img.rsplit_once("?vc=")
                                            && base_path == del_path_str
                                        {
                                            is_deleted = true;
                                            break;
                                        }
                                    }
                                }
                            }

                            if !is_deleted {
                                new_images.push(current_img);
                            } else {
                                *changed = true;
                            }
                        }
                        *images = new_images;
                    }
                    AlbumItem::Group { children, .. } => {
                        process_nodes(children, renames, deletions, folder_rename, changed);
                    }
                }
            }
        }

        process_nodes(&mut tree, renames, deletions, folder_rename, &mut changed);

        if changed {
            let _ = save_albums(tree, app_handle.clone());
        }
    }
}

#[tauri::command]
pub fn get_album_images(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<Vec<ImageFile>, String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);

    let result_list: Vec<ImageFile> = paths
        .into_par_iter()
        .filter_map(|virtual_path| {
            let (source_path, sidecar_path) = parse_virtual_path(&virtual_path);
            if !source_path.exists() {
                return None;
            }

            let modified = fs::metadata(&source_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let is_virtual_copy = virtual_path.contains("?vc=");
            let is_cloud_placeholder = is_cloud_placeholder(&source_path);

            let xmp_is_placeholder = enable_xmp_sync
                && resolve_xmp_path(&source_path)
                    .is_some_and(|p| crate::file_management::is_cloud_placeholder(&p));

            let (is_edited, tags, rating) = if crate::file_management::is_cloud_placeholder(
                &sidecar_path,
            ) || xmp_is_placeholder
            {
                enqueue_metadata(
                    &app_handle,
                    virtual_path.clone(),
                    source_path.clone(),
                    sidecar_path.clone(),
                );
                (false, None, 0)
            } else {
                resolve_image_metadata(&source_path, &sidecar_path, enable_xmp_sync, &settings)
            };

            Some(ImageFile {
                path: virtual_path,
                modified,
                is_edited,
                tags,
                exif: None,
                is_virtual_copy,
                rating,
                is_cloud_placeholder,
            })
        })
        .collect();

    Ok(result_list)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub children: Vec<FolderNode>,
    pub is_dir: bool,
    pub image_count: usize,
    pub has_subdirs: bool,
    pub modified: u64,
    pub created: u64,
}

fn has_subdirs(path: &Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.filter_map(Result::ok) {
            if let Ok(file_type) = entry.file_type()
                && file_type.is_dir()
            {
                let name = entry.file_name();
                if !name.to_string_lossy().starts_with('.') {
                    return true;
                }
            }
        }
    }
    false
}

fn scan_dir_lazy(
    path: &Path,
    expanded_folders: &HashSet<&str>,
    show_image_counts: bool,
    prefetch_one_level: bool,
) -> Result<(Vec<FolderNode>, usize), std::io::Error> {
    let mut children_folders = Vec::new();
    let mut current_dir_image_count = 0;

    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!("Could not scan directory '{}': {}", path.display(), e);
            return Ok((Vec::new(), 0));
        }
    };

    for entry in entries.filter_map(Result::ok) {
        let current_path = entry.path();
        let (file_type, modified, created) = match entry.metadata() {
            Ok(meta) => {
                let ft = meta.file_type();
                let mod_time = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                let cre_time = meta.created().unwrap_or(mod_time);

                (
                    ft,
                    mod_time
                        .duration_since(std::time::SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                    cre_time
                        .duration_since(std::time::SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                )
            }
            Err(_) => continue,
        };

        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();

        if name_str.starts_with('.') {
            continue;
        }

        if file_type.is_dir() {
            let path_str = current_path.to_string_lossy().into_owned();
            let is_expanded = expanded_folders.contains(path_str.as_str());

            let should_scan = is_expanded || prefetch_one_level;
            let next_prefetch = is_expanded;

            let (grand_children, sub_dir_own_images) = if should_scan {
                scan_dir_lazy(
                    &current_path,
                    expanded_folders,
                    show_image_counts,
                    next_prefetch,
                )?
            } else {
                let count = if show_image_counts {
                    WalkDir::new(&current_path)
                        .into_iter()
                        .filter_map(Result::ok)
                        .filter(|e| {
                            e.file_type().is_file()
                                && crate::formats::is_supported_image_file(e.path())
                        })
                        .count()
                } else {
                    0
                };
                (Vec::new(), count)
            };

            let has_any_subdirs = if should_scan {
                grand_children.iter().any(|c| c.is_dir)
            } else {
                has_subdirs(&current_path)
            };

            let grand_children_sum: usize = grand_children.iter().map(|c| c.image_count).sum();
            let total_child_count = sub_dir_own_images + grand_children_sum;

            children_folders.push(FolderNode {
                name: name_str.into_owned(),
                path: path_str,
                children: grand_children,
                is_dir: true,
                image_count: total_child_count,
                has_subdirs: has_any_subdirs,
                modified,
                created,
            });
        } else if show_image_counts
            && file_type.is_file()
            && crate::formats::is_supported_image_file(&current_path)
        {
            current_dir_image_count += 1;
        }
    }

    children_folders.sort_by_key(|a| a.name.to_lowercase());

    Ok((children_folders, current_dir_image_count))
}

fn get_folder_tree_sync(
    path: String,
    expanded_folders: Vec<String>,
    show_image_counts: bool,
) -> Result<FolderNode, String> {
    let root_path = Path::new(&path);
    if !root_path.is_dir() {
        return Err(format!("Directory does not exist: {}", path));
    }

    let (modified, created) = root_path
        .metadata()
        .map(|m| {
            let mod_time = m.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            let cre_time = m.created().unwrap_or(mod_time);
            (
                mod_time
                    .duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                cre_time
                    .duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            )
        })
        .unwrap_or((0, 0));

    let expanded_set: HashSet<&str> = expanded_folders.iter().map(|s| s.as_str()).collect();

    let (children, own_count) = scan_dir_lazy(root_path, &expanded_set, show_image_counts, true)
        .map_err(|e| e.to_string())?;

    let children_sum: usize = children.iter().map(|c| c.image_count).sum();
    let has_subdirs = children.iter().any(|c| c.is_dir);

    let name = match root_path.file_name() {
        Some(n) => n.to_string_lossy().into_owned(),
        None => {
            let trimmed = path.trim_end_matches(&['/', '\\'][..]);
            if trimmed.is_empty() {
                path.clone()
            } else {
                trimmed.to_string()
            }
        }
    };

    Ok(FolderNode {
        name,
        path: path.clone(),
        children,
        is_dir: true,
        image_count: own_count + children_sum,
        has_subdirs,
        modified,
        created,
    })
}

#[tauri::command]
pub async fn get_folder_children(
    path: String,
    show_image_counts: bool,
) -> Result<Vec<FolderNode>, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let root_path = Path::new(&path);
        if !root_path.is_dir() {
            return Err(format!("Directory does not exist: {}", path));
        }
        let empty_set = HashSet::new();
        let (children, _) = scan_dir_lazy(root_path, &empty_set, show_image_counts, false)
            .map_err(|e| e.to_string())?;

        Ok(children)
    })
    .await
    {
        Ok(Ok(children)) => Ok(children),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("Task failed: {}", e)),
    }
}

#[tauri::command]
pub async fn get_folder_tree(
    path: String,
    expanded_folders: Vec<String>,
    show_image_counts: bool,
) -> Result<FolderNode, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        get_folder_tree_sync(path, expanded_folders, show_image_counts)
    })
    .await
    {
        Ok(Ok(folder_node)) => Ok(folder_node),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("Failed to execute folder tree task: {}", e)),
    }
}

#[tauri::command]
pub async fn get_pinned_folder_trees(
    paths: Vec<String>,
    expanded_folders: Vec<String>,
    show_image_counts: bool,
) -> Result<Vec<FolderNode>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let results: Vec<Result<FolderNode, String>> = paths
            .par_iter()
            .map(|path| {
                get_folder_tree_sync(path.clone(), expanded_folders.clone(), show_image_counts)
            })
            .collect();

        let mut folder_nodes = Vec::new();
        for result in results {
            match result {
                Ok(node) => folder_nodes.push(node),
                Err(e) => log::warn!("Failed to get tree for pinned folder: {}", e),
            }
        }
        folder_nodes
    })
    .await;

    match result {
        Ok(nodes) => Ok(nodes),
        Err(e) => Err(format!("Task failed: {}", e)),
    }
}

/// Checks if the given path exists and is an iCloud placeholder file on macOS.
#[cfg(target_os = "macos")]
pub fn is_cloud_placeholder(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    const SF_DATALESS: u32 = 0x4000_0000;

    let c_path = match std::ffi::CString::new(path.as_os_str().as_bytes()) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let mut stat_buf: libc::stat = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::lstat(c_path.as_ptr(), &mut stat_buf) };
    ret == 0 && (stat_buf.st_flags & SF_DATALESS) != 0
}

#[cfg(not(target_os = "macos"))]
pub fn is_cloud_placeholder(_path: &Path) -> bool {
    false
}

pub fn read_file_mapped(path: &Path) -> Result<Mmap, ReadFileError> {
    if !path.is_file() {
        return Err(ReadFileError::Invalid);
    }
    if !path.exists() {
        return Err(ReadFileError::NotFound);
    }
    if path.metadata().map_err(ReadFileError::Io)?.len() == 0 {
        return Err(ReadFileError::Empty);
    }
    let file = fs::File::open(path).map_err(ReadFileError::Io)?;
    if file.try_lock_shared().is_err() {
        return Err(ReadFileError::Locked);
    }
    let mmap = unsafe {
        MmapOptions::new()
            .len(file.metadata().map_err(ReadFileError::Io)?.len() as usize)
            .map(&file)
            .map_err(ReadFileError::Io)?
    };
    Ok(mmap)
}

pub(crate) fn prepare_thumbnail_render_input(
    persisted: &Value,
    defaults: &CameraDefaults,
    loaded: &LoadedBaseImage,
) -> ResolvedRenderInput {
    ResolvedRenderInput::from_loaded(persisted, defaults, loaded)
}

fn thumbnail_render_path(
    persisted_is_null: bool,
    gpu_context_available: bool,
) -> ThumbnailRenderPath {
    if persisted_is_null {
        ThumbnailRenderPath::DefaultCpu
    } else if gpu_context_available {
        ThumbnailRenderPath::ObjectGpu
    } else {
        ThumbnailRenderPath::ObjectFallback
    }
}

fn select_thumbnail_render_path(
    render: &ResolvedRenderInput,
    gpu_context_available: bool,
) -> ThumbnailRenderPath {
    thumbnail_render_path(render.persisted_is_null, gpu_context_available)
}

pub(crate) fn render_thumbnail_from_loaded(
    loaded: LoadedBaseImage,
    render: &ResolvedRenderInput,
    is_raw: bool,
    settings: &AppSettings,
) -> anyhow::Result<DynamicImage> {
    ensure!(
        render.persisted_is_null,
        "The default thumbnail renderer cannot process persisted adjustment objects"
    );
    ensure!(
        render.source_kind == loaded.source_kind,
        "Thumbnail render input did not match the loaded image source"
    );

    let mut image = loaded.image;
    let default_tm = if is_raw {
        settings.default_raw_tonemapper.as_deref().unwrap_or("agx")
    } else {
        settings
            .default_non_raw_tonemapper
            .as_deref()
            .unwrap_or("basic")
    };
    if default_tm == "agx" {
        if !is_raw {
            image = crate::image_processing::apply_srgb_to_linear(image);
        }
        crate::image_processing::apply_cpu_agx_tonemap(&mut image);
    } else if is_raw {
        apply_cpu_default_raw_processing(&mut image);
    }

    let crop = render
        .effective_adjustments
        .get("crop")
        .unwrap_or(&Value::Null);
    Ok(apply_crop(Cow::Owned(image), crop).into_owned())
}

struct ThumbnailLoadedInput {
    loaded: LoadedBaseImage,
    raw_scale_factor: f32,
}

struct ThumbnailRenderedImage {
    image: DynamicImage,
    actual_render_path: ThumbnailRenderPath,
    actual_lut_outcome: ThumbnailLutOutcome,
}

fn resolve_thumbnail_gpu_result<E>(
    result: std::result::Result<DynamicImage, E>,
    fallback: DynamicImage,
    success_lut_outcome: ThumbnailLutOutcome,
    fallback_lut_outcome: ThumbnailLutOutcome,
) -> ThumbnailRenderedImage {
    match result {
        Ok(image) => ThumbnailRenderedImage {
            image,
            actual_render_path: ThumbnailRenderPath::ObjectGpu,
            actual_lut_outcome: success_lut_outcome,
        },
        Err(_) => ThumbnailRenderedImage {
            image: fallback,
            actual_render_path: ThumbnailRenderPath::ObjectFallback,
            actual_lut_outcome: fallback_lut_outcome,
        },
    }
}

fn thumbnail_gpu_input_exceeds_limit(width: u32, height: u32, max_dimension: u32) -> bool {
    width > max_dimension || height > max_dimension
}

fn composite_preloaded_thumbnail_with<F>(
    preloaded: ThumbnailPreloadedImage,
    adjustments: &Value,
    composite: F,
) -> Result<LoadedBaseImage>
where
    F: FnOnce(&DynamicImage, &Value) -> Result<DynamicImage>,
{
    let has_patches = adjustments
        .get("aiPatches")
        .and_then(Value::as_array)
        .is_some_and(|patches| !patches.is_empty());
    if has_patches {
        let image = composite(preloaded.image.as_ref(), adjustments)?;
        Ok(LoadedBaseImage {
            image,
            source_kind: preloaded.source_kind,
        })
    } else {
        Ok(preloaded.into_loaded())
    }
}

fn composite_preloaded_thumbnail(
    preloaded: ThumbnailPreloadedImage,
    adjustments: &Value,
) -> Result<LoadedBaseImage> {
    composite_preloaded_thumbnail_with(
        preloaded,
        adjustments,
        image_loader::composite_patches_on_image,
    )
}

fn load_thumbnail_input(
    source_path: &Path,
    source_path_str: &str,
    adjustments: &Value,
    is_raw: bool,
    preloaded_image: Option<ThumbnailPreloadedImage>,
    settings: &AppSettings,
) -> Result<ThumbnailLoadedInput> {
    if let Some(preloaded) = preloaded_image {
        return Ok(ThumbnailLoadedInput {
            loaded: composite_preloaded_thumbnail(preloaded, adjustments)?,
            raw_scale_factor: 1.0,
        });
    }

    let load = |bytes: &[u8]| -> Result<ThumbnailLoadedInput> {
        let loaded = image_loader::load_and_composite_with_metadata(
            bytes,
            source_path_str,
            adjustments,
            true,
            settings,
            None,
        )?;
        let raw_scale_factor = if is_raw {
            crate::raw_processing::get_fast_demosaic_scale_factor(
                bytes,
                loaded.image.width(),
                loaded.image.height(),
            )
        } else {
            1.0
        };
        Ok(ThumbnailLoadedInput {
            loaded,
            raw_scale_factor,
        })
    };

    match read_file_mapped(source_path) {
        Ok(mmap) => load(&mmap),
        Err(error) => {
            log::warn!("Fallback read for {}: {}", source_path_str, error);
            load(
                &fs::read(source_path)
                    .with_context(|| format!("Fallback read failed for {source_path_str}"))?,
            )
        }
    }
}

fn render_thumbnail_object_gpu(
    path_str: &str,
    context: &GpuContext,
    composite_image: DynamicImage,
    raw_scale_factor: f32,
    adjustments: &Value,
    resolved_lut: &ResolvedThumbnailLut,
    is_raw: bool,
    app_handle: &AppHandle,
    settings: &AppSettings,
) -> Result<ThumbnailRenderedImage> {
    let state = app_handle.state::<AppState>();
    let target_res = settings.thumbnail_resolution.unwrap_or(720);
    let geometry_hash = calculate_geometry_hash(adjustments);
    let crop_data: Option<Crop> = serde_json::from_value(adjustments["crop"].clone()).ok();

    let cached_base: Option<(DynamicImage, f32)> = {
        let cache = state.thumbnail_geometry_cache.lock().unwrap();
        if let Some((cached_hash, img, scale)) = cache.get(path_str) {
            let mut sufficient_resolution = true;
            if let Some(crop) = &crop_data
                && crop.width > 0.0
                && crop.height > 0.0
            {
                let final_crop_max_dim =
                    (crop.width as f32 * *scale).max(crop.height as f32 * *scale);
                if final_crop_max_dim < (target_res as f32 * 0.95) {
                    sufficient_resolution = false;
                }
            }

            if *cached_hash == geometry_hash && sufficient_resolution {
                Some((img.clone(), *scale))
            } else {
                None
            }
        } else {
            None
        }
    };

    let (processing_base, total_scale) = if let Some(hit) = cached_base {
        hit
    } else {
        let warped_image = apply_geometry_warp(Cow::Borrowed(&composite_image), adjustments);
        let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
        let coarse_rotated_image = apply_coarse_rotation(warped_image, orientation_steps);
        let (full_w, full_h) = coarse_rotated_image.dimensions();

        let mut processing_dim = target_res;
        if let Some(crop) = &crop_data
            && crop.width > 0.0
            && crop.height > 0.0
        {
            let crop_max_dim_loaded = crop.width.max(crop.height) * raw_scale_factor as f64;
            let full_max_dim = full_w.max(full_h) as f64;
            if crop_max_dim_loaded > 0.0 {
                processing_dim = ((target_res as f64 * full_max_dim / crop_max_dim_loaded).round()
                    as u32)
                    .min(full_w.max(full_h));
            }
        }

        let (base, gpu_scale) = if full_w > processing_dim || full_h > processing_dim {
            let base = crate::image_processing::downscale_f32_image(
                &coarse_rotated_image,
                processing_dim,
                processing_dim,
            );
            let scale = if full_w > 0 {
                base.width() as f32 / full_w as f32
            } else {
                1.0
            };
            (base, scale)
        } else {
            (coarse_rotated_image.into_owned(), 1.0)
        };

        let total_scale = gpu_scale * raw_scale_factor;
        let mut cache = state.thumbnail_geometry_cache.lock().unwrap();
        if cache.len() > 30 {
            cache.clear();
        }
        cache.insert(
            path_str.to_string(),
            (geometry_hash, base.clone(), total_scale),
        );
        (base, total_scale)
    };

    let rotation_degrees = adjustments["rotation"].as_f64().unwrap_or(0.0) as f32;
    let flip_horizontal = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
    let flip_vertical = adjustments["flipVertical"].as_bool().unwrap_or(false);
    let flipped_image = apply_flip(Cow::Owned(processing_base), flip_horizontal, flip_vertical);
    let rotated_image = apply_rotation(flipped_image, rotation_degrees);

    let scaled_crop_json = if let Some(crop) = &crop_data {
        serde_json::to_value(Crop {
            x: crop.x * total_scale as f64,
            y: crop.y * total_scale as f64,
            width: crop.width * total_scale as f64,
            height: crop.height * total_scale as f64,
        })
        .unwrap_or(Value::Null)
    } else {
        Value::Null
    };

    let cropped_preview = apply_crop(rotated_image, &scaled_crop_json);
    let (preview_w, preview_h) = cropped_preview.dimensions();
    if thumbnail_gpu_input_exceeds_limit(
        preview_w,
        preview_h,
        context.limits.max_texture_dimension_2d,
    ) {
        log::warn!(
            "Thumbnail dimensions ({}x{}) exceed GPU limits ({}); using a transient fallback",
            preview_w,
            preview_h,
            context.limits.max_texture_dimension_2d
        );
        return Ok(ThumbnailRenderedImage {
            image: cropped_preview.into_owned(),
            actual_render_path: ThumbnailRenderPath::ObjectFallback,
            actual_lut_outcome: resolved_lut.fallback_outcome(),
        });
    }
    if resolved_lut.request == ThumbnailLutRequest::Unavailable {
        return Ok(ThumbnailRenderedImage {
            image: cropped_preview.into_owned(),
            actual_render_path: ThumbnailRenderPath::ObjectFallback,
            actual_lut_outcome: ThumbnailLutOutcome::Unavailable,
        });
    }
    let unscaled_crop_offset = crop_data.map_or((0.0, 0.0), |crop| (crop.x as f32, crop.y as f32));
    let mask_definitions: Vec<MaskDefinition> = adjustments
        .get("masks")
        .and_then(|masks| serde_json::from_value(masks.clone()).ok())
        .unwrap_or_default();
    let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
        .iter()
        .filter_map(|definition| {
            crate::get_cached_or_generate_mask(
                &state,
                definition,
                preview_w,
                preview_h,
                total_scale,
                (
                    unscaled_crop_offset.0 * total_scale,
                    unscaled_crop_offset.1 * total_scale,
                ),
                adjustments,
            )
        })
        .collect();

    let tm_override = crate::image_processing::resolve_tonemapper_override(settings, is_raw);
    let gpu_adjustments = get_all_adjustments_from_json(adjustments, is_raw, tm_override);
    let mut hasher = DefaultHasher::new();
    path_str.hash(&mut hasher);
    adjustments.to_string().hash(&mut hasher);
    let unique_hash = hasher.finish();

    Ok(resolve_thumbnail_gpu_result(
        gpu_processing::process_and_get_dynamic_image(
            context,
            &state,
            cropped_preview.as_ref(),
            unique_hash,
            gpu_processing::RenderRequest {
                adjustments: gpu_adjustments,
                mask_bitmaps: &mask_bitmaps,
                lut: resolved_lut.lut.clone(),
                roi: None,
            },
            "generate_thumbnail_data",
        ),
        cropped_preview.into_owned(),
        resolved_lut.applied_outcome(),
        resolved_lut.fallback_outcome(),
    ))
}

fn generate_thumbnail_data(
    path_str: &str,
    gpu_context: Option<&GpuContext>,
    preloaded_image: Option<ThumbnailPreloadedImage>,
    app_handle: &AppHandle,
    settings: &AppSettings,
    persisted_adjustments: &Value,
    defaults: &CameraDefaults,
    resolved_lut: &ResolvedThumbnailLut,
) -> Result<(
    DynamicImage,
    ResolvedRenderInput,
    ThumbnailRenderPath,
    ThumbnailLutOutcome,
)> {
    let (source_path, _) = parse_virtual_path(path_str);
    let source_path_str = source_path.to_string_lossy().to_string();
    let is_raw = is_raw_file(&source_path);
    let loaded = load_thumbnail_input(
        &source_path,
        &source_path_str,
        persisted_adjustments,
        is_raw,
        preloaded_image,
        settings,
    )?;
    let render = prepare_thumbnail_render_input(persisted_adjustments, defaults, &loaded.loaded);

    let rendered = match select_thumbnail_render_path(&render, gpu_context.is_some()) {
        ThumbnailRenderPath::DefaultCpu => ThumbnailRenderedImage {
            image: render_thumbnail_from_loaded(loaded.loaded, &render, is_raw, settings)?,
            actual_render_path: ThumbnailRenderPath::DefaultCpu,
            actual_lut_outcome: resolved_lut.fallback_outcome(),
        },
        ThumbnailRenderPath::ObjectGpu => render_thumbnail_object_gpu(
            path_str,
            gpu_context.expect("GPU dispatch requires a context"),
            loaded.loaded.image,
            loaded.raw_scale_factor,
            &render.effective_adjustments,
            resolved_lut,
            is_raw,
            app_handle,
            settings,
        )?,
        ThumbnailRenderPath::ObjectFallback => {
            let orientation_steps = render.effective_adjustments["orientationSteps"]
                .as_u64()
                .unwrap_or(0) as u8;
            ThumbnailRenderedImage {
                image: apply_coarse_rotation(Cow::Owned(loaded.loaded.image), orientation_steps)
                    .into_owned(),
                actual_render_path: ThumbnailRenderPath::ObjectFallback,
                actual_lut_outcome: resolved_lut.fallback_outcome(),
            }
        }
    };

    Ok((
        rendered.image,
        render,
        rendered.actual_render_path,
        rendered.actual_lut_outcome,
    ))
}

fn encode_thumbnail(image: &DynamicImage, target_width: u32) -> Result<Vec<u8>> {
    let thumbnail = crate::image_processing::downscale_f32_image(image, target_width, target_width);
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, 75);
    encoder.encode_image(&thumbnail.to_rgb8())?;
    Ok(buf.into_inner())
}

struct CachedThumbnailResolution {
    hit: ThumbnailCacheHit,
    rating: u8,
    is_edited: bool,
}

enum CachedThumbnailAdapterMode {
    Library,
    DecodedImage,
}

enum CachedThumbnailAdapterOutput {
    Library(String, u8, bool),
    DecodedImage(DynamicImage),
}

fn adapt_cached_thumbnail_resolution(
    resolution: CachedThumbnailResolution,
    mode: CachedThumbnailAdapterMode,
) -> Result<CachedThumbnailAdapterOutput> {
    match mode {
        CachedThumbnailAdapterMode::Library => Ok(CachedThumbnailAdapterOutput::Library(
            resolution.hit.jpeg_path.to_string_lossy().into_owned(),
            resolution.rating,
            resolution.is_edited,
        )),
        CachedThumbnailAdapterMode::DecodedImage => {
            let jpeg_path = resolution.hit.jpeg_path;
            let image = image::open(&jpeg_path).with_context(|| {
                format!("Could not open cached thumbnail {}", jpeg_path.display())
            })?;
            Ok(CachedThumbnailAdapterOutput::DecodedImage(image))
        }
    }
}

fn thumbnail_identity_recheck_with<F>(
    path_str: &str,
    camera_defaults: &CameraDefaults,
    render_profile: &ThumbnailRenderProfile,
    load_adjustments: F,
) -> Option<ThumbnailCacheIdentity>
where
    F: FnOnce(&Path) -> Value,
{
    let (source_path, sidecar_path) = parse_virtual_path(path_str);
    let persisted_adjustments = load_adjustments(&sidecar_path);
    let lut_request = resolve_thumbnail_lut_request(&persisted_adjustments);
    let source_modified = thumbnail_source_timestamp(&source_path)?;
    let key = thumbnail_manifest_key(
        path_str,
        source_modified,
        &persisted_adjustments,
        camera_defaults,
        render_profile,
        &lut_request,
    );
    thumbnail_cache_identity(&key).ok()
}

fn thumbnail_identity_recheck(
    path_str: &str,
    camera_defaults: &CameraDefaults,
    render_profile: &ThumbnailRenderProfile,
) -> Option<ThumbnailCacheIdentity> {
    thumbnail_identity_recheck_with(path_str, camera_defaults, render_profile, |sidecar_path| {
        crate::exif_processing::load_sidecar(sidecar_path).adjustments
    })
}

fn generate_cached_thumbnail(
    path_str: &str,
    thumb_cache_dir: &Path,
    gpu_context: Option<&GpuContext>,
    preloaded_image: Option<ThumbnailPreloadedImage>,
    force_regenerate: bool,
    app_handle: &AppHandle,
    settings: &AppSettings,
) -> Result<CachedThumbnailResolution> {
    let (source_path, sidecar_path) = parse_virtual_path(path_str);
    ensure!(
        !is_cloud_placeholder(&source_path),
        "Source image is not locally available"
    );

    let metadata = if is_cloud_placeholder(&sidecar_path) {
        enqueue_metadata(
            app_handle,
            path_str.to_string(),
            source_path.clone(),
            sidecar_path,
        );
        ImageMetadata::default()
    } else {
        crate::exif_processing::load_sidecar(&sidecar_path)
    };
    let is_raw = is_raw_file(&source_path);
    let tm_override = crate::image_processing::resolve_tonemapper_override(settings, is_raw);
    let is_edited =
        crate::image_processing::is_image_edited(&metadata.adjustments, is_raw, tm_override);
    let render_profile = thumbnail_render_profile(
        settings,
        is_raw,
        &metadata.adjustments,
        gpu_context.is_some(),
    );
    let resolved_lut = resolve_thumbnail_lut(&metadata.adjustments);
    let key = thumbnail_manifest_key_for_path(
        path_str,
        &metadata.adjustments,
        &render_profile,
        &resolved_lut.request,
    )
    .context("Could not build thumbnail manifest key")?;
    let identity = thumbnail_cache_identity(&key)?;
    let target_width = render_profile.target_width;
    let identity_for_generate = identity.clone();
    let camera_defaults_for_generate = key.camera_defaults.clone();
    let camera_defaults_for_recheck = key.camera_defaults.clone();
    let render_profile_for_recheck = key.render_profile.clone();
    drop(key);
    let persisted_adjustments = metadata.adjustments;
    let hit = resolve_thumbnail_cache_with(
        thumb_cache_dir,
        &identity,
        force_regenerate,
        || {
            let (image, render, actual_render_path, actual_lut_outcome) = generate_thumbnail_data(
                path_str,
                gpu_context,
                preloaded_image,
                app_handle,
                settings,
                &persisted_adjustments,
                &camera_defaults_for_generate,
                &resolved_lut,
            )?;
            let fingerprint = thumbnail_render_fingerprint(
                &identity_for_generate,
                &render.effective_adjustments,
                render.source_kind,
                actual_render_path,
                actual_lut_outcome,
            )?;
            Ok((fingerprint, encode_thumbnail(&image, target_width)?))
        },
        || {
            thumbnail_identity_recheck(
                path_str,
                &camera_defaults_for_recheck,
                &render_profile_for_recheck,
            )
        },
    )?;

    Ok(CachedThumbnailResolution {
        hit,
        rating: metadata.rating,
        is_edited,
    })
}

fn generate_single_thumbnail_and_cache(
    path_str: &str,
    thumb_cache_dir: &Path,
    gpu_context: Option<&GpuContext>,
    preloaded_image: Option<ThumbnailPreloadedImage>,
    force_regenerate: bool,
    app_handle: &AppHandle,
    settings: &AppSettings,
) -> Option<(String, u8, bool)> {
    let resolution = generate_cached_thumbnail(
        path_str,
        thumb_cache_dir,
        gpu_context,
        preloaded_image,
        force_regenerate,
        app_handle,
        settings,
    )
    .and_then(|resolution| {
        adapt_cached_thumbnail_resolution(resolution, CachedThumbnailAdapterMode::Library)
    });
    match resolution {
        Ok(CachedThumbnailAdapterOutput::Library(path, rating, is_edited)) => {
            Some((path, rating, is_edited))
        }
        Err(error) => {
            log::warn!("Failed to generate thumbnail for '{}': {error}", path_str);
            None
        }
        Ok(CachedThumbnailAdapterOutput::DecodedImage(_)) => unreachable!(),
    }
}

pub fn start_thumbnail_workers(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<crate::AppState>();
    let manager = state.thumbnail_manager.clone();
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let thread_count = settings.thumbnail_worker_threads.unwrap_or(4).clamp(1, 16);

    for _ in 0..thread_count {
        let app_clone = app_handle.clone();
        let manager_clone = manager.clone();
        let worker_settings = settings.clone();

        std::thread::spawn(move || {
            loop {
                let path_to_process: String = {
                    let mut queue = manager_clone.queue.lock().unwrap();
                    while queue.is_empty() {
                        queue = manager_clone.cvar.wait(queue).unwrap();
                    }
                    let path = queue.pop_back().unwrap();

                    let mut processing = manager_clone.processing_now.lock().unwrap();
                    if processing.contains(&path) {
                        let state = app_clone.state::<crate::AppState>();
                        increment_thumbnail_progress(&state, &app_clone);
                        continue;
                    }
                    processing.insert(path.clone());
                    path
                };

                let state = app_clone.state::<crate::AppState>();
                let gpu_context =
                    crate::gpu_processing::get_or_init_gpu_context(&state, &app_clone).ok();

                if let Ok(cache_dir) = get_thumb_cache_dir(&app_clone) {
                    let result = generate_single_thumbnail_and_cache(
                        &path_to_process,
                        &cache_dir,
                        gpu_context.as_ref(),
                        None,
                        false,
                        &app_clone,
                        &worker_settings,
                    );

                    if let Some((thumbnail_path, rating, is_edited)) = result {
                        emit_thumbnail_generated(
                            &app_clone,
                            &path_to_process,
                            &thumbnail_path,
                            rating,
                            is_edited,
                        );
                    }
                    increment_thumbnail_progress(&state, &app_clone);
                }
                manager_clone
                    .processing_now
                    .lock()
                    .unwrap()
                    .remove(&path_to_process);
            }
        });
    }
}

#[tauri::command]
pub fn update_thumbnail_queue(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<crate::AppState>();

    let mut queue = state.thumbnail_manager.queue.lock().unwrap();

    if paths.is_empty() {
        queue.clear();
        let mut tracker = state.thumbnail_progress.lock().unwrap();
        tracker.total = 0;
        tracker.completed = 0;
        drop(tracker);

        let _ = app_handle.emit(
            "thumbnail-progress",
            serde_json::json!({ "current": 0, "total": 0 }),
        );
        state.thumbnail_manager.cvar.notify_all();
        return Ok(());
    }

    let mut unique_paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        if seen.insert(path.clone()) {
            unique_paths.push(path);
        }
    }

    queue.retain(|p| !seen.contains(p));

    while queue.len() + unique_paths.len() > 500 {
        queue.pop_front();
    }

    for path in unique_paths {
        queue.push_back(path);
    }

    let queue_len = queue.len();
    drop(queue);

    let mut tracker = state.thumbnail_progress.lock().unwrap();
    tracker.total = tracker.completed + queue_len;

    let current = tracker.completed;
    let total = tracker.total;
    drop(tracker);

    let _ = app_handle.emit(
        "thumbnail-progress",
        serde_json::json!({ "current": current, "total": total }),
    );

    state.thumbnail_manager.cvar.notify_all();
    Ok(())
}

pub fn add_to_thumbnail_queue(state: &AppState, count: usize, app_handle: &AppHandle) {
    let mut tracker = state.thumbnail_progress.lock().unwrap();
    tracker.total += count;
    let current = tracker.completed;
    let total = tracker.total;
    drop(tracker);

    let _ = app_handle.emit(
        "thumbnail-progress",
        serde_json::json!({ "current": current, "total": total }),
    );
}

pub fn increment_thumbnail_progress(state: &AppState, app_handle: &AppHandle) {
    let mut tracker = state.thumbnail_progress.lock().unwrap();
    tracker.completed += 1;
    let current = tracker.completed;
    let total = tracker.total;

    if current >= total {
        tracker.total = 0;
        tracker.completed = 0;
        drop(tracker);

        let _ = app_handle.emit(
            "thumbnail-progress",
            serde_json::json!({ "current": 0, "total": 0 }),
        );
        let _ = app_handle.emit("thumbnail-generation-complete", true);
    } else {
        drop(tracker);
        let _ = app_handle.emit(
            "thumbnail-progress",
            serde_json::json!({ "current": current, "total": total }),
        );
    }
}

fn emit_thumbnail_generated(
    app_handle: &AppHandle,
    path: &str,
    thumbnail_path: &str,
    rating: u8,
    is_edited: bool,
) {
    let _ = app_handle.emit(
        "thumbnail-generated",
        serde_json::json!({ "path": path, "thumbnailPath": thumbnail_path, "rating": rating, "is_edited": is_edited }),
    );
}

pub fn resolve_lens_params_in_adjustments(
    adjustments: &mut Value,
    exif_data: &Option<HashMap<String, String>>,
    lens_db: Option<&crate::lens_correction::LensDatabase>,
) {
    if let Some(map) = adjustments.as_object_mut() {
        let mode = map
            .get("lensCorrectionMode")
            .and_then(|v| v.as_str())
            .unwrap_or("manual");

        if mode == "auto" {
            if let Some(exif) = exif_data {
                let exif_maker = exif.get("Make").map(|s| s.as_str()).unwrap_or("");
                let exif_model = exif.get("LensModel").map(|s| s.as_str()).unwrap_or("");
                if let Some(db) = lens_db {
                    if let Some((detected_maker, detected_model)) =
                        crate::lens_correction::find_best_lens_match(db, exif_maker, exif_model)
                    {
                        map.insert(
                            "lensMaker".to_string(),
                            serde_json::to_value(&detected_maker).unwrap(),
                        );
                        map.insert(
                            "lensModel".to_string(),
                            serde_json::to_value(&detected_model).unwrap(),
                        );
                    } else {
                        map.remove("lensMaker");
                        map.remove("lensModel");
                    }
                }
            } else {
                map.remove("lensMaker");
                map.remove("lensModel");
            }
        }

        if let Some(db) = lens_db {
            let has_valid_lens = match (
                map.get("lensMaker").and_then(|v| v.as_str()),
                map.get("lensModel").and_then(|v| v.as_str()),
            ) {
                (Some(maker), Some(model)) if !maker.is_empty() && !model.is_empty() => {
                    let mut focal_length = 50.0;
                    let mut aperture = None;
                    let mut distance = None;

                    if let Some(exif) = exif_data {
                        if let Some(fl_str) = exif
                            .get("FocalLength")
                            .or(exif.get("FocalLengthIn35mmFilm"))
                            && let Ok(fl) = fl_str.replace(" mm", "").trim().parse::<f32>()
                        {
                            focal_length = fl;
                        }
                        if let Some(ap_str) = exif.get("ApertureValue").or(exif.get("FNumber"))
                            && let Ok(ap) = ap_str.replace("f/", "").trim().parse::<f32>()
                        {
                            aperture = Some(ap);
                        }
                        if let Some(dist_str) = exif.get("SubjectDistance")
                            && let Ok(dist) = dist_str.replace(" m", "").trim().parse::<f32>()
                        {
                            distance = Some(dist);
                        }
                    }

                    if let Some(params) = crate::lens_correction::resolve_lens_params(
                        db,
                        maker,
                        model,
                        focal_length,
                        aperture,
                        distance,
                    ) {
                        map.insert(
                            "lensDistortionParams".to_string(),
                            serde_json::to_value(params).unwrap(),
                        );
                        true
                    } else {
                        false
                    }
                }
                _ => false,
            };

            if !has_valid_lens {
                map.remove("lensDistortionParams");
            }
        }
    }
}

#[tauri::command]
pub fn get_supported_file_types() -> Result<serde_json::Value, String> {
    let raw_extensions: Vec<&str> = crate::formats::RAW_EXTENSIONS
        .iter()
        .map(|(ext, _)| *ext)
        .collect();
    let non_raw_extensions: Vec<&str> = crate::formats::NON_RAW_EXTENSIONS.to_vec();

    Ok(serde_json::json!({
        "raw": raw_extensions,
        "nonRaw": non_raw_extensions
    }))
}

#[tauri::command]
pub fn create_folder(path: String) -> Result<(), String> {
    let path_obj = Path::new(&path);
    if let (Some(parent), Some(new_folder_name_os)) = (path_obj.parent(), path_obj.file_name())
        && let Some(new_folder_name) = new_folder_name_os.to_str()
        && parent.exists()
    {
        for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
            if let Ok(entry) = entry
                && entry.file_name().to_string_lossy().to_lowercase()
                    == new_folder_name.to_lowercase()
            {
                return Err("A folder with that name already exists.".to_string());
            }
        }
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_folder(path: String, new_name: String, app_handle: AppHandle) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err("Path is not a directory.".to_string());
    }
    if let Some(parent) = p.parent() {
        for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
            if let Ok(entry) = entry
                && entry.file_name().to_string_lossy().to_lowercase() == new_name.to_lowercase()
                && entry.path() != p
            {
                return Err("A folder with that name already exists.".to_string());
            }
        }
        let new_path = parent.join(&new_name);
        fs::rename(p, &new_path).map_err(|e| e.to_string())?;

        let new_folder_str = new_path.to_string_lossy().into_owned();
        sync_album_path_changes(&app_handle, None, None, Some((&path, &new_folder_str)));

        Ok(())
    } else {
        Err("Could not determine parent directory.".to_string())
    }
}

#[tauri::command]
pub fn delete_folder(path: String, app_handle: AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        if let Err(trash_error) = trash::delete(&path) {
            log::warn!(
                "Failed to move folder to trash: {}. Falling back to permanent delete.",
                trash_error
            );
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }

    let mut deletions = HashSet::new();
    deletions.insert(path);
    sync_album_path_changes(&app_handle, None, Some(&deletions), None);

    Ok(())
}

#[tauri::command]
pub fn duplicate_file(
    path: String,
    target_album_id: Option<String>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (source_path, source_sidecar_path) = parse_virtual_path(&path);
    if !source_path.is_file() {
        return Err("Source path is not a file.".to_string());
    }

    let parent = source_path
        .parent()
        .ok_or("Could not get parent directory")?;
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Could not get file stem")?;
    let extension = source_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let mut counter = 1;
    let mut dest_path;
    loop {
        let new_stem = if counter == 1 {
            format!("{}_copy", stem)
        } else {
            format!("{}_copy_{}", stem, counter - 1)
        };
        dest_path = parent.join(format!("{}.{}", new_stem, extension));
        if !dest_path.exists() {
            break;
        }
        counter += 1;
    }

    fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;

    if source_sidecar_path.exists()
        && let Some(dest_str) = dest_path.to_str()
    {
        let (_, dest_sidecar_path) = parse_virtual_path(dest_str);
        fs::copy(&source_sidecar_path, &dest_sidecar_path).map_err(|e| e.to_string())?;
    }

    let mut source_rrexif_name = source_path.file_name().unwrap().to_os_string();
    source_rrexif_name.push(".rrexif");
    let source_rrexif = source_path.with_file_name(source_rrexif_name);

    if source_rrexif.exists() {
        let mut dest_rrexif_name = dest_path.file_name().unwrap().to_os_string();
        dest_rrexif_name.push(".rrexif");
        let dest_rrexif = dest_path.with_file_name(dest_rrexif_name);
        let _ = fs::copy(&source_rrexif, &dest_rrexif);
    }

    let dest_path_str = dest_path.to_string_lossy().into_owned();

    if let Some(album_id) = target_album_id {
        let _ = add_to_album(album_id, vec![dest_path_str.clone()], app_handle);
    }

    Ok(dest_path_str)
}

fn find_all_associated_files(source_image_path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut associated_files = vec![source_image_path.to_path_buf()];

    let mut rrexif_name = source_image_path
        .file_name()
        .unwrap_or_default()
        .to_os_string();
    rrexif_name.push(".rrexif");
    let rrexif_path = source_image_path.with_file_name(rrexif_name);

    if rrexif_path.exists() {
        associated_files.push(rrexif_path);
    }

    let parent_dir = source_image_path
        .parent()
        .ok_or("Could not determine parent directory")?;
    let source_filename = source_image_path
        .file_name()
        .ok_or("Could not get source filename")?
        .to_string_lossy();

    let primary_sidecar_name = format!("{}.rrdata", source_filename);
    let virtual_copy_prefix = format!("{}.", source_filename);

    if let Ok(entries) = fs::read_dir(parent_dir) {
        for entry in entries.filter_map(Result::ok) {
            let entry_path = entry.path();
            if !entry_path.is_file() {
                continue;
            }

            let entry_os_filename = entry.file_name();
            let entry_filename = entry_os_filename.to_string_lossy();

            if entry_filename == primary_sidecar_name
                || (entry_filename.starts_with(&virtual_copy_prefix)
                    && entry_filename.ends_with(".rrdata"))
            {
                associated_files.push(entry_path);
            }
        }
    }

    Ok(associated_files)
}

#[tauri::command]
pub fn copy_files(source_paths: Vec<String>, destination_folder: String) -> Result<(), String> {
    let dest_path = Path::new(&destination_folder);
    if !dest_path.is_dir() {
        return Err(format!(
            "Destination is not a folder: {}",
            destination_folder
        ));
    }

    let unique_source_images: HashSet<PathBuf> = source_paths
        .iter()
        .map(|p| parse_virtual_path(p).0)
        .collect();

    for source_image_path in unique_source_images {
        let all_files_to_copy = find_all_associated_files(&source_image_path)?;

        let source_parent = source_image_path
            .parent()
            .ok_or("Could not get parent directory")?;
        if source_parent == dest_path {
            let stem = source_image_path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("Could not get file stem")?;
            let extension = source_image_path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");

            let mut counter = 1;
            let new_base_path = loop {
                let new_stem = format!("{}_copy_{}", stem, counter);
                let temp_path = source_parent.join(format!("{}.{}", new_stem, extension));
                if !temp_path.exists() {
                    break temp_path;
                }
                counter += 1;
            };
            let new_filename = new_base_path.file_name().unwrap().to_string_lossy();

            for original_file in all_files_to_copy {
                let original_full_filename = original_file.file_name().unwrap().to_string_lossy();
                let source_base_filename = source_image_path.file_name().unwrap().to_string_lossy();
                let new_dest_filename =
                    original_full_filename.replacen(&*source_base_filename, &new_filename, 1);
                let final_dest_path = dest_path.join(new_dest_filename);

                fs::copy(&original_file, &final_dest_path).map_err(|e| e.to_string())?;
            }
        } else {
            for file_to_copy in all_files_to_copy {
                if let Some(file_name) = file_to_copy.file_name() {
                    let dest_file_path = dest_path.join(file_name);
                    fs::copy(&file_to_copy, &dest_file_path).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn move_files(
    source_paths: Vec<String>,
    destination_folder: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    let dest_path = Path::new(&destination_folder);
    if !dest_path.is_dir() {
        return Err(format!(
            "Destination is not a folder: {}",
            destination_folder
        ));
    }

    let unique_source_images: HashSet<PathBuf> = source_paths
        .iter()
        .map(|p| parse_virtual_path(p).0)
        .collect();

    let mut all_files_to_trash = Vec::new();
    let mut renames = HashMap::new();

    for source_image_path in unique_source_images {
        let source_parent = source_image_path
            .parent()
            .ok_or("Could not get parent directory")?;
        if source_parent == dest_path {
            return Err("Cannot move files into the same folder they are already in.".to_string());
        }

        let files_to_move = find_all_associated_files(&source_image_path)?;

        for file_to_move in &files_to_move {
            if let Some(file_name) = file_to_move.file_name() {
                let dest_file_path = dest_path.join(file_name);
                if dest_file_path.exists() {
                    return Err(format!(
                        "File already exists at destination: {}",
                        dest_file_path.display()
                    ));
                }
            }
        }

        for file_to_move in &files_to_move {
            if let Some(file_name) = file_to_move.file_name() {
                let dest_file_path = dest_path.join(file_name);
                fs::copy(file_to_move, &dest_file_path).map_err(|e| e.to_string())?;
            }
        }

        let dest_image_path = dest_path.join(source_image_path.file_name().unwrap());
        renames.insert(
            source_image_path.to_string_lossy().into_owned(),
            dest_image_path.to_string_lossy().into_owned(),
        );

        all_files_to_trash.extend(files_to_move);
    }

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    if !all_files_to_trash.is_empty()
        && let Err(trash_error) = trash::delete_all(&all_files_to_trash)
    {
        log::warn!(
            "Failed to move source files to trash: {}. Falling back to permanent delete.",
            trash_error
        );
        for path in all_files_to_trash {
            if path.is_file() {
                fs::remove_file(&path).map_err(|e| {
                    format!("Failed to delete source file {}: {}", path.display(), e)
                })?;
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    for path in all_files_to_trash {
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete source file {}: {}", path.display(), e))?;
        }
    }

    sync_album_path_changes(&app_handle, Some(&renames), None, None);

    Ok(())
}

#[tauri::command]
pub fn save_metadata_and_update_thumbnail(
    path: String,
    adjustments: Value,
    app_handle: AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let (source_path, sidecar_path) = parse_virtual_path(&path);

    let mut metadata = crate::exif_processing::load_sidecar(&sidecar_path);

    let mut final_adjustments = adjustments;
    {
        let lens_db_guard = state.lens_db.lock().unwrap();
        resolve_lens_params_in_adjustments(
            &mut final_adjustments,
            &metadata.exif,
            lens_db_guard.as_deref(),
        );
    }

    metadata.adjustments = final_adjustments;

    let json_string = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    std::fs::write(&sidecar_path, json_string).map_err(|e| e.to_string())?;

    if let Ok(settings) = load_settings(app_handle.clone())
        && settings.enable_xmp_sync.unwrap_or(false)
    {
        let create_if_missing = settings.create_xmp_if_missing.unwrap_or(false);
        sync_metadata_to_xmp(&source_path, &metadata, create_if_missing);
    }

    let loaded_image_lock = state.original_image.lock().unwrap();
    let preloaded_image_option = if let Some(loaded_image) = loaded_image_lock.as_ref() {
        if loaded_image.path == path {
            Some(ThumbnailPreloadedImage {
                image: Arc::clone(&loaded_image.image),
                source_kind: loaded_image.source_kind,
            })
        } else {
            None
        }
    } else {
        None
    };
    drop(loaded_image_lock);

    let gpu_context = gpu_processing::get_or_init_gpu_context(&state, &app_handle).ok();
    let app_handle_clone = app_handle.clone();
    let path_clone = path.clone();

    add_to_thumbnail_queue(&state, 1, &app_handle);

    thread::spawn(move || {
        let state = app_handle_clone.state::<AppState>();
        let settings = load_settings(app_handle_clone.clone()).unwrap_or_default();

        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle_clone) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!(
                    "Unable to initialize thumbnail cache directory for '{}': {}",
                    path_clone,
                    e
                );
                emit_thumbnail_cache_setup_error(&app_handle_clone, &path_clone, &e);
                increment_thumbnail_progress(&state, &app_handle_clone);
                return;
            }
        };

        let result = generate_single_thumbnail_and_cache(
            &path_clone,
            &thumb_cache_dir,
            gpu_context.as_ref(),
            preloaded_image_option,
            true,
            &app_handle_clone,
            &settings,
        );

        if let Some((thumbnail_path, rating, is_edited)) = result {
            emit_thumbnail_generated(
                &app_handle_clone,
                &path_clone,
                &thumbnail_path,
                rating,
                is_edited,
            );
        }

        increment_thumbnail_progress(&state, &app_handle_clone);
    });

    Ok(())
}

#[tauri::command]
pub async fn apply_adjustments_to_paths(
    paths: Vec<String>,
    adjustments: Value,
    app_handle: AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    add_to_thumbnail_queue(&state, paths.len(), &app_handle);

    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
        let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

        let lens_db = app_handle
            .state::<AppState>()
            .lens_db
            .lock()
            .unwrap()
            .clone();

        paths.par_iter().for_each(|path| {
            let (_, sidecar_path) = parse_virtual_path(path);

            let mut existing_metadata = crate::exif_processing::load_sidecar(&sidecar_path);

            let mut new_adjustments = existing_metadata.adjustments;
            if new_adjustments.is_null() {
                new_adjustments = serde_json::json!({});
            }

            if let (Some(new_map), Some(pasted_map)) =
                (new_adjustments.as_object_mut(), adjustments.as_object())
            {
                for (k, v) in pasted_map {
                    new_map.insert(k.clone(), v.clone());
                }
            }

            resolve_lens_params_in_adjustments(
                &mut new_adjustments,
                &existing_metadata.exif,
                lens_db.as_deref(),
            );

            existing_metadata.adjustments = new_adjustments;

            if let Ok(json_string) = serde_json::to_string_pretty(&existing_metadata) {
                let _ = std::fs::write(&sidecar_path, json_string);
            }

            if enable_xmp_sync {
                let source_path = parse_virtual_path(path).0;
                sync_metadata_to_xmp(&source_path, &existing_metadata, create_xmp_if_missing);
            }
        });

        let state = app_handle.state::<AppState>();
        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!("Unable to initialize thumbnail cache directory: {}", e);
                for path in &paths {
                    emit_thumbnail_cache_setup_error(&app_handle, path, &e);
                }
                for _ in 0..paths.len() {
                    increment_thumbnail_progress(&state, &app_handle);
                }
                return;
            }
        };

        let gpu_context = gpu_processing::get_or_init_gpu_context(&state, &app_handle).ok();

        paths.par_iter().for_each(|path_str| {
            let result = generate_single_thumbnail_and_cache(
                path_str,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                None,
                true,
                &app_handle,
                &settings,
            );

            if let Some((thumbnail_path, rating, is_edited)) = result {
                emit_thumbnail_generated(&app_handle, path_str, &thumbnail_path, rating, is_edited);
            }

            increment_thumbnail_progress(&state, &app_handle);
        });
    });

    Ok(())
}

#[tauri::command]
pub async fn reset_adjustments_for_paths(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    add_to_thumbnail_queue(&state, paths.len(), &app_handle);

    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
        let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

        paths.par_iter().for_each(|path| {
            let (_, sidecar_path) = parse_virtual_path(path);

            let mut existing_metadata = crate::exif_processing::load_sidecar(&sidecar_path);

            existing_metadata.adjustments = serde_json::json!({});

            if let Ok(json_string) = serde_json::to_string_pretty(&existing_metadata) {
                let _ = std::fs::write(&sidecar_path, json_string);
            }

            if enable_xmp_sync {
                let source_path = parse_virtual_path(path).0;
                sync_metadata_to_xmp(&source_path, &existing_metadata, create_xmp_if_missing);
            }
        });

        let state = app_handle.state::<AppState>();
        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!("Unable to initialize thumbnail cache directory: {}", e);
                for path in &paths {
                    emit_thumbnail_cache_setup_error(&app_handle, path, &e);
                }
                for _ in 0..paths.len() {
                    increment_thumbnail_progress(&state, &app_handle);
                }
                return;
            }
        };

        let gpu_context = gpu_processing::get_or_init_gpu_context(&state, &app_handle).ok();

        paths.par_iter().for_each(|path_str| {
            let result = generate_single_thumbnail_and_cache(
                path_str,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                None,
                true,
                &app_handle,
                &settings,
            );

            if let Some((thumbnail_path, rating, is_edited)) = result {
                emit_thumbnail_generated(&app_handle, path_str, &thumbnail_path, rating, is_edited);
            }

            increment_thumbnail_progress(&state, &app_handle);
        });
    });

    Ok(())
}

#[tauri::command]
pub async fn apply_auto_adjustments_to_paths(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    add_to_thumbnail_queue(&state, paths.len(), &app_handle);

    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
        let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

        let state = app_handle.state::<AppState>();
        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!("Unable to initialize thumbnail cache directory: {}", e);
                for path in &paths {
                    emit_thumbnail_cache_setup_error(&app_handle, path, &e);
                }
                for _ in 0..paths.len() {
                    increment_thumbnail_progress(&state, &app_handle);
                }
                return;
            }
        };

        let gpu_context = gpu_processing::get_or_init_gpu_context(&state, &app_handle).ok();

        paths.par_iter().for_each(|path| {
            let loaded_image: Option<LoadedBaseImage> = (|| -> Result<LoadedBaseImage, String> {
                let (source_path, sidecar_path) = parse_virtual_path(path);
                let source_path_str = source_path.to_string_lossy().to_string();

                let file_bytes = fs::read(&source_path).map_err(|e| e.to_string())?;
                let loaded = image_loader::load_base_image_with_metadata_from_bytes(
                    &file_bytes,
                    &source_path_str,
                    true,
                    &settings,
                    None,
                )
                .map_err(|e| e.to_string())?;

                let auto_results = perform_auto_analysis(&loaded.image);
                let auto_adjustments_json = auto_results_to_json(&auto_results);

                let mut existing_metadata = crate::exif_processing::load_sidecar(&sidecar_path);

                if existing_metadata.adjustments.is_null() {
                    existing_metadata.adjustments = serde_json::json!({});
                }

                if let (Some(existing_map), Some(auto_map)) = (
                    existing_metadata.adjustments.as_object_mut(),
                    auto_adjustments_json.as_object(),
                ) {
                    for (k, v) in auto_map {
                        if k == "sectionVisibility" {
                            if let Some(existing_vis_val) = existing_map.get_mut(k) {
                                if let (Some(existing_vis), Some(auto_vis)) =
                                    (existing_vis_val.as_object_mut(), v.as_object())
                                {
                                    for (vis_k, vis_v) in auto_vis {
                                        existing_vis.insert(vis_k.clone(), vis_v.clone());
                                    }
                                }
                            } else {
                                existing_map.insert(k.clone(), v.clone());
                            }
                        } else {
                            existing_map.insert(k.clone(), v.clone());
                        }
                    }
                }

                if let Ok(json_string) = serde_json::to_string_pretty(&existing_metadata) {
                    let _ = std::fs::write(&sidecar_path, json_string);
                }

                if enable_xmp_sync {
                    sync_metadata_to_xmp(&source_path, &existing_metadata, create_xmp_if_missing);
                }
                Ok(loaded)
            })()
            .map_err(|e| eprintln!("Failed to apply auto adjustments to {}: {}", path, e))
            .ok();

            let result = generate_single_thumbnail_and_cache(
                path,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                loaded_image.map(|loaded| ThumbnailPreloadedImage {
                    image: Arc::new(loaded.image),
                    source_kind: loaded.source_kind,
                }),
                true,
                &app_handle,
                &settings,
            );

            if let Some((thumbnail_path, rating, is_edited)) = result {
                emit_thumbnail_generated(&app_handle, path, &thumbnail_path, rating, is_edited);
            }

            increment_thumbnail_progress(&state, &app_handle);
        });
    });

    Ok(())
}

#[tauri::command]
pub fn set_color_label_for_paths(
    paths: Vec<String>,
    color: Option<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
    let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

    paths.par_iter().for_each(|path| {
        let (_, sidecar_path) = parse_virtual_path(path);

        let mut metadata = crate::exif_processing::load_sidecar(&sidecar_path);

        let mut tags = metadata.tags.unwrap_or_default();
        tags.retain(|tag| !tag.starts_with(COLOR_TAG_PREFIX));

        if let Some(c) = &color
            && !c.is_empty()
        {
            tags.push(format!("{}{}", COLOR_TAG_PREFIX, c));
        }

        if tags.is_empty() {
            metadata.tags = None;
        } else {
            metadata.tags = Some(tags);
        }

        if let Ok(json_string) = serde_json::to_string_pretty(&metadata) {
            let _ = std::fs::write(&sidecar_path, json_string);
        }

        if enable_xmp_sync {
            let source_path = parse_virtual_path(path).0;
            sync_metadata_to_xmp(&source_path, &metadata, create_xmp_if_missing);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn set_rating_for_paths(
    paths: Vec<String>,
    rating: u8,
    app_handle: AppHandle,
) -> Result<(), String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
    let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

    paths.par_iter().for_each(|path| {
        let (_, sidecar_path) = parse_virtual_path(path);

        let mut metadata = crate::exif_processing::load_sidecar(&sidecar_path);

        metadata.rating = rating;

        if let Ok(json_string) = serde_json::to_string_pretty(&metadata) {
            let _ = std::fs::write(&sidecar_path, json_string);
        }

        if enable_xmp_sync {
            let source_path = parse_virtual_path(path).0;
            sync_metadata_to_xmp(&source_path, &metadata, create_xmp_if_missing);
        }
    });

    Ok(())
}

const RAW_METADATA_EXTRACTION_LIMIT: usize = 2;
static RAW_METADATA_EXTRACTION_SEMAPHORE: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(RAW_METADATA_EXTRACTION_LIMIT)));

async fn metadata_result_for_path_blocking_with<F>(
    metadata: ImageMetadata,
    source_path: PathBuf,
    semaphore: Arc<Semaphore>,
    extractor: F,
) -> LoadMetadataResult
where
    F: FnOnce(ImageMetadata, &Path) -> LoadMetadataResult + Send + 'static,
{
    if !is_raw_file(&source_path) {
        return extractor(metadata, &source_path);
    }

    let fallback_metadata = metadata.clone();
    let permit = match semaphore.acquire_owned().await {
        Ok(permit) => permit,
        Err(error) => {
            log::error!("Failed to acquire RAW metadata extraction permit: {error}");
            return LoadMetadataResult {
                metadata: fallback_metadata,
                camera_defaults: CameraDefaults::default(),
            };
        }
    };

    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        extractor(metadata, &source_path)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            log::error!("RAW metadata extraction task failed: {error}");
            LoadMetadataResult {
                metadata: fallback_metadata,
                camera_defaults: CameraDefaults::default(),
            }
        }
    }
}

#[tauri::command]
pub async fn load_metadata(
    path: String,
    app_handle: AppHandle,
) -> Result<LoadMetadataResult, String> {
    let settings = load_settings(app_handle).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);

    let (source_path, sidecar_path) = parse_virtual_path(&path);
    let mut metadata = crate::exif_processing::load_sidecar(&sidecar_path);

    if enable_xmp_sync
        && sync_metadata_from_xmp(&source_path, &mut metadata)
        && let Ok(json) = serde_json::to_string_pretty(&metadata)
    {
        let _ = fs::write(&sidecar_path, json);
    }

    Ok(metadata_result_for_path_blocking_with(
        metadata,
        source_path,
        Arc::clone(&RAW_METADATA_EXTRACTION_SEMAPHORE),
        metadata_result_for_path,
    )
    .await)
}

fn get_presets_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let presets_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("presets");

    if !presets_dir.exists() {
        fs::create_dir_all(&presets_dir).map_err(|e| e.to_string())?;
    }

    Ok(presets_dir.join("presets.json"))
}

#[tauri::command]
pub fn load_presets(app_handle: AppHandle) -> Result<Vec<PresetItem>, String> {
    let path = get_presets_path(&app_handle)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_presets(presets: Vec<PresetItem>, app_handle: AppHandle) -> Result<(), String> {
    let path = get_presets_path(&app_handle)?;
    let json_string = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    fs::write(path, json_string).map_err(|e| e.to_string())
}

fn get_internal_library_root_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    #[cfg(not(target_os = "android"))]
    {
        let library_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("library");

        if !library_dir.exists() {
            fs::create_dir_all(&library_dir).map_err(|e| e.to_string())?;
        }
        Ok(library_dir)
    }
    #[cfg(target_os = "android")]
    {
        crate::android_integration::get_android_internal_library_root()
    }
}

#[tauri::command]
pub fn get_or_create_internal_library_root(app_handle: AppHandle) -> Result<String, String> {
    let library_root = get_internal_library_root_path(&app_handle)?;

    Ok(library_root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn handle_import_presets_from_file(
    file_path: String,
    app_handle: AppHandle,
) -> Result<Vec<PresetItem>, String> {
    let content =
        fs::read_to_string(file_path).map_err(|e| format!("Failed to read preset file: {}", e))?;
    let imported_preset_file: PresetFile = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse preset file: {}", e))?;

    let mut current_presets = load_presets(app_handle.clone())?;

    let mut current_names: HashSet<String> = current_presets
        .iter()
        .map(|item| match item {
            PresetItem::Preset(p) => p.name.clone(),
            PresetItem::Folder(f) => f.name.clone(),
        })
        .collect();

    for mut imported_item in imported_preset_file.presets {
        let (current_name, _new_id) = match &mut imported_item {
            PresetItem::Preset(p) => {
                p.id = Uuid::new_v4().to_string();
                (p.name.clone(), p.id.clone())
            }
            PresetItem::Folder(f) => {
                f.id = Uuid::new_v4().to_string();
                for child in &mut f.children {
                    child.id = Uuid::new_v4().to_string();
                }
                (f.name.clone(), f.id.clone())
            }
        };

        let mut new_name = current_name.clone();
        let mut counter = 1;
        while current_names.contains(&new_name) {
            new_name = format!("{} ({})", current_name, counter);
            counter += 1;
        }

        match &mut imported_item {
            PresetItem::Preset(p) => p.name = new_name.clone(),
            PresetItem::Folder(f) => f.name = new_name.clone(),
        }

        current_names.insert(new_name);
        current_presets.push(imported_item);
    }

    save_presets(current_presets.clone(), app_handle)?;
    Ok(current_presets)
}

#[tauri::command]
pub fn handle_import_legacy_presets_from_file(
    file_path: String,
    app_handle: AppHandle,
) -> Result<Vec<PresetItem>, String> {
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read legacy preset file: {}", e))?;

    let xmp_content = if file_path.to_lowercase().ends_with(".lrtemplate") {
        let re = Regex::new(r#"(?s)s.xmp = "(.*)""#).unwrap();
        if let Some(caps) = re.captures(&content) {
            caps.get(1)
                .map(|m| m.as_str().replace(r#"\""#, r#"""#))
                .unwrap_or(content)
        } else {
            content
        }
    } else {
        content
    };

    let converted_preset = preset_converter::convert_xmp_to_preset(&xmp_content)?;

    let mut current_presets = load_presets(app_handle.clone())?;

    let current_names: HashSet<String> = current_presets
        .iter()
        .flat_map(|item| match item {
            PresetItem::Preset(p) => vec![p.name.clone()],
            PresetItem::Folder(f) => {
                let mut names = vec![f.name.clone()];
                names.extend(f.children.iter().map(|c| c.name.clone()));
                names
            }
        })
        .collect();

    let mut new_name = converted_preset.name.clone();
    let mut counter = 1;
    while current_names.contains(&new_name) {
        new_name = format!("{} ({})", converted_preset.name, counter);
        counter += 1;
    }

    let mut final_preset = converted_preset;
    final_preset.name = new_name;

    current_presets.push(PresetItem::Preset(final_preset));

    save_presets(current_presets.clone(), app_handle)?;
    Ok(current_presets)
}

#[tauri::command]
pub fn handle_export_presets_to_file(
    presets_to_export: Vec<PresetItem>,
    file_path: String,
) -> Result<(), String> {
    let preset_file = ExportPresetFile {
        creator: "Anonymous",
        presets: &presets_to_export,
    };

    let json_string = serde_json::to_string_pretty(&preset_file)
        .map_err(|e| format!("Failed to serialize presets: {}", e))?;
    fs::write(file_path, json_string).map_err(|e| format!("Failed to write preset file: {}", e))
}

#[tauri::command]
pub fn save_community_preset(
    name: String,
    adjustments: Value,
    app_handle: AppHandle,
    include_masks: Option<bool>,
    include_crop_transform: Option<bool>,
    preset_type: Option<String>,
) -> Result<(), String> {
    let mut current_presets = load_presets(app_handle.clone())?;

    let community_folder_name = "Community";
    let community_folder_id = match current_presets.iter_mut().find(|item| {
        if let PresetItem::Folder(f) = item {
            f.name == community_folder_name
        } else {
            false
        }
    }) {
        Some(PresetItem::Folder(folder)) => folder.id.clone(),
        _ => {
            let new_folder_id = Uuid::new_v4().to_string();
            let new_folder = PresetItem::Folder(PresetFolder {
                id: new_folder_id.clone(),
                name: community_folder_name.to_string(),
                children: Vec::new(),
            });
            current_presets.insert(0, new_folder);
            new_folder_id
        }
    };

    let new_preset = Preset {
        id: Uuid::new_v4().to_string(),
        name,
        adjustments,
        include_masks,
        include_crop_transform,
        preset_type: preset_type.or(Some("style".to_string())),
    };

    if let Some(PresetItem::Folder(folder)) = current_presets.iter_mut().find(|item| {
        if let PresetItem::Folder(f) = item {
            f.id == community_folder_id
        } else {
            false
        }
    }) {
        folder.children.retain(|p| p.name != new_preset.name);
        folder.children.push(new_preset);
    }

    save_presets(current_presets, app_handle)
}

#[tauri::command]
pub fn clear_all_sidecars(root_path: String) -> Result<usize, String> {
    if !Path::new(&root_path).exists() {
        return Err(format!("Root path does not exist: {}", root_path));
    }

    let mut deleted_count = 0;
    let walker = WalkDir::new(root_path).into_iter();

    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file()
            && let Some(extension) = path.extension()
            && (extension == "rrdata" || extension == "rrexif")
        {
            if fs::remove_file(path).is_ok() {
                deleted_count += 1;
            } else {
                eprintln!("Failed to delete sidecar file: {:?}", path);
            }
        }
    }

    Ok(deleted_count)
}

#[tauri::command]
pub fn clear_thumbnail_cache(app_handle: AppHandle) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let thumb_cache_dir = cache_dir.join("thumbnails");

    if thumb_cache_dir.exists() {
        fs::remove_dir_all(&thumb_cache_dir)
            .map_err(|e| format!("Failed to remove thumbnail cache: {}", e))?;
    }

    fs::create_dir_all(&thumb_cache_dir)
        .map_err(|e| format!("Failed to recreate thumbnail cache directory: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn show_in_finder(path: String) -> Result<(), String> {
    let (source_path, _) = parse_virtual_path(&path);

    #[cfg(target_os = "windows")]
    {
        let source_path_str = source_path.to_string_lossy().to_string();
        Command::new("explorer")
            .args(["/select,", &source_path_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        let source_path_str = source_path.to_string_lossy().to_string();
        Command::new("open")
            .args(["-R", &source_path_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = source_path.parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            return Err("Could not get parent directory".into());
        }
    }

    #[cfg(target_os = "android")]
    {
        return Err("Show in File Manager is not natively supported via CLI on Android.".into());
    }

    #[cfg(target_os = "ios")]
    {
        return Err("Show in File Manager is not supported on iOS.".into());
    }

    Ok(())
}

#[tauri::command]
pub fn delete_files_from_disk(paths: Vec<String>, app_handle: AppHandle) -> Result<(), String> {
    let mut files_to_trash = HashSet::new();

    let mut deletions = HashSet::new();

    for path_str in paths {
        let (source_path, sidecar_path) = parse_virtual_path(&path_str);
        deletions.insert(path_str.clone());

        if path_str.contains("?vc=") {
            if sidecar_path.exists() {
                files_to_trash.insert(sidecar_path);
            }
        } else {
            if source_path.exists() {
                match find_all_associated_files(&source_path) {
                    Ok(associated_files) => {
                        for file in associated_files {
                            files_to_trash.insert(file);
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "Could not find associated files for {}: {}",
                            source_path.display(),
                            e
                        );
                    }
                }
            }
        }
    }

    if files_to_trash.is_empty() {
        return Ok(());
    }

    let final_paths_to_delete: Vec<PathBuf> = files_to_trash.into_iter().collect();
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    if let Err(trash_error) = trash::delete_all(&final_paths_to_delete) {
        log::warn!(
            "Failed to move files to trash: {}. Falling back to permanent delete.",
            trash_error
        );
        for path in final_paths_to_delete {
            if path.is_file() {
                fs::remove_file(&path)
                    .map_err(|e| format!("Failed to delete file {}: {}", path.display(), e))?;
            } else if path.is_dir() {
                fs::remove_dir_all(&path)
                    .map_err(|e| format!("Failed to delete directory {}: {}", path.display(), e))?;
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    for path in final_paths_to_delete {
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete file {}: {}", path.display(), e))?;
        } else if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|e| format!("Failed to delete directory {}: {}", path.display(), e))?;
        }
    }

    sync_album_path_changes(&app_handle, None, Some(&deletions), None);

    Ok(())
}

#[tauri::command]
pub fn delete_files_with_associated(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut stems_to_delete = HashSet::new();
    let mut parent_dirs = HashSet::new();
    let mut deletions = HashSet::new();

    for path_str in &paths {
        deletions.insert(path_str.clone());
        let (source_path, _) = parse_virtual_path(path_str);
        if let Some(file_name) = source_path.file_name().and_then(|s| s.to_str())
            && let Some(stem) = file_name.split('.').next()
        {
            stems_to_delete.insert(stem.to_string());
        }
        if let Some(parent) = source_path.parent() {
            parent_dirs.insert(parent.to_path_buf());
        }
    }

    if stems_to_delete.is_empty() {
        return Ok(());
    }

    let mut files_to_trash = HashSet::new();

    for parent_dir in parent_dirs {
        if let Ok(entries) = fs::read_dir(parent_dir) {
            for entry in entries.filter_map(Result::ok) {
                let entry_path = entry.path();
                if !entry_path.is_file() {
                    continue;
                }

                let entry_filename = entry.file_name();
                let entry_filename_str = entry_filename.to_string_lossy();

                if let Some(base_stem) = entry_filename_str.split('.').next()
                    && stems_to_delete.contains(base_stem)
                    && (is_supported_image_file(entry_filename_str.as_ref())
                        || entry_filename_str.ends_with(".rrdata")
                        || entry_filename_str.ends_with(".rrexif"))
                {
                    files_to_trash.insert(entry_path);
                }
            }
        }
    }

    if files_to_trash.is_empty() {
        return Ok(());
    }

    let final_paths_to_delete: Vec<PathBuf> = files_to_trash.into_iter().collect();
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    if let Err(trash_error) = trash::delete_all(&final_paths_to_delete) {
        log::warn!(
            "Failed to move files to trash: {}. Falling back to permanent delete.",
            trash_error
        );
        for path in final_paths_to_delete {
            if path.is_file() {
                fs::remove_file(&path)
                    .map_err(|e| format!("Failed to delete file {}: {}", path.display(), e))?;
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    for path in final_paths_to_delete {
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete file {}: {}", path.display(), e))?;
        }
    }

    sync_album_path_changes(&app_handle, None, Some(&deletions), None);

    Ok(())
}

pub fn get_thumb_cache_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let thumb_cache_dir = cache_dir.join("thumbnails");
    if !thumb_cache_dir.exists() {
        fs::create_dir_all(&thumb_cache_dir).map_err(|e| e.to_string())?;
    }
    Ok(thumb_cache_dir)
}

pub fn get_cached_or_generate_thumbnail_image(
    path_str: &str,
    app_handle: &AppHandle,
    gpu_context: Option<&GpuContext>,
) -> Result<DynamicImage> {
    let thumb_cache_dir = get_thumb_cache_dir(app_handle).map_err(|e| anyhow::anyhow!(e))?;
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let resolution = generate_cached_thumbnail(
        path_str,
        &thumb_cache_dir,
        gpu_context,
        None,
        false,
        app_handle,
        &settings,
    )?;
    match adapt_cached_thumbnail_resolution(resolution, CachedThumbnailAdapterMode::DecodedImage)? {
        CachedThumbnailAdapterOutput::DecodedImage(image) => Ok(image),
        CachedThumbnailAdapterOutput::Library(_, _, _) => unreachable!(),
    }
}

#[tauri::command]
pub async fn import_files(
    source_paths: Vec<String>,
    destination_folder: String,
    settings: ImportSettings,
    app_handle: AppHandle,
) -> Result<(), String> {
    let total_files = source_paths.len();
    let _ = app_handle.emit("import-start", serde_json::json!({ "total": total_files }));

    tauri::async_runtime::spawn_blocking(move || {
        for (i, source_path_str) in source_paths.iter().enumerate() {
            let _ = app_handle.emit(
                "import-progress",
                serde_json::json!({ "current": i, "total": total_files, "path": source_path_str }),
            );

            let import_result: Result<(), String> = (|| {
                #[cfg(target_os = "android")]
                if is_android_content_uri(source_path_str) {
                    let resolved_name = resolve_android_content_uri_name(source_path_str)?;
                    let source_bytes = read_android_content_uri(source_path_str)?;
                    let source_name_path = Path::new(&resolved_name);
                    let file_date = exif_processing::get_creation_date_from_bytes(
                        &resolved_name,
                        &source_bytes,
                    );

                    let mut final_dest_folder = PathBuf::from(&destination_folder);
                    if settings.organize_by_date {
                        let date_format_str = settings
                            .date_folder_format
                            .replace("YYYY", "%Y")
                            .replace("MM", "%m")
                            .replace("DD", "%d");
                        let subfolder = file_date.format(&date_format_str).to_string();
                        final_dest_folder.push(subfolder);
                    }

                    fs::create_dir_all(&final_dest_folder)
                        .map_err(|e| format!("Failed to create destination folder: {}", e))?;

                    let new_stem = generate_filename_from_template(
                        &settings.filename_template,
                        source_name_path,
                        i + 1,
                        total_files,
                        &file_date,
                    );
                    let extension = source_name_path
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    let new_filename = format!("{}.{}", new_stem, extension);
                    let dest_file_path = final_dest_folder.join(new_filename);

                    if dest_file_path.exists() {
                        return Err(format!(
                            "File already exists at destination: {}",
                            dest_file_path.display()
                        ));
                    }

                    fs::write(&dest_file_path, source_bytes).map_err(|e| e.to_string())?;

                    if settings.delete_after_import {
                        log::info!(
                            "Skipping delete_after_import for Android content URI source: {}",
                            source_path_str
                        );
                    }

                    return Ok(());
                }

                let (source_path, source_sidecar) = parse_virtual_path(source_path_str);
                if !source_path.exists() {
                    return Err(format!("Source file not found: {}", source_path_str));
                }

                let file_date = exif_processing::get_creation_date_from_path(&source_path);

                let mut final_dest_folder = PathBuf::from(&destination_folder);
                if settings.organize_by_date {
                    let date_format_str = settings
                        .date_folder_format
                        .replace("YYYY", "%Y")
                        .replace("MM", "%m")
                        .replace("DD", "%d");
                    let subfolder = file_date.format(&date_format_str).to_string();
                    final_dest_folder.push(subfolder);
                }

                fs::create_dir_all(&final_dest_folder)
                    .map_err(|e| format!("Failed to create destination folder: {}", e))?;

                let new_stem = generate_filename_from_template(
                    &settings.filename_template,
                    &source_path,
                    i + 1,
                    total_files,
                    &file_date,
                );
                let extension = source_path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let new_filename = format!("{}.{}", new_stem, extension);
                let dest_file_path = final_dest_folder.join(new_filename);

                if dest_file_path.exists() {
                    return Err(format!(
                        "File already exists at destination: {}",
                        dest_file_path.display()
                    ));
                }

                fs::copy(&source_path, &dest_file_path).map_err(|e| e.to_string())?;
                if source_sidecar.exists()
                    && let Some(dest_str) = dest_file_path.to_str()
                {
                    let (_, dest_sidecar) = parse_virtual_path(dest_str);
                    fs::copy(&source_sidecar, &dest_sidecar).map_err(|e| e.to_string())?;
                }

                let mut source_rrexif_name = source_path.file_name().unwrap().to_os_string();
                source_rrexif_name.push(".rrexif");
                let source_rrexif = source_path.with_file_name(source_rrexif_name);

                if source_rrexif.exists() {
                    let mut dest_rrexif_name = dest_file_path.file_name().unwrap().to_os_string();
                    dest_rrexif_name.push(".rrexif");
                    let dest_rrexif = dest_file_path.with_file_name(dest_rrexif_name);
                    let _ = fs::copy(&source_rrexif, &dest_rrexif);
                }

                if settings.delete_after_import {
                    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
                    {
                        if let Err(trash_error) = trash::delete(&source_path) {
                            log::warn!(
                                "Failed to trash source file {}: {}. Deleting permanently.",
                                source_path.display(),
                                trash_error
                            );
                            fs::remove_file(&source_path).map_err(|e| e.to_string())?;
                        }
                        if source_sidecar.exists()
                            && let Err(trash_error) = trash::delete(&source_sidecar)
                        {
                            log::warn!(
                                "Failed to trash source sidecar {}: {}. Deleting permanently.",
                                source_sidecar.display(),
                                trash_error
                            );
                            fs::remove_file(&source_sidecar).map_err(|e| e.to_string())?;
                        }
                    }

                    #[cfg(not(any(
                        target_os = "windows",
                        target_os = "macos",
                        target_os = "linux"
                    )))]
                    {
                        fs::remove_file(&source_path).map_err(|e| e.to_string())?;
                        if source_sidecar.exists() {
                            fs::remove_file(&source_sidecar).map_err(|e| e.to_string())?;
                        }
                        if source_rrexif.exists() {
                            let _ = fs::remove_file(&source_rrexif);
                        }
                    }
                }

                Ok(())
            })();

            if let Err(e) = import_result {
                eprintln!("Failed to import {}: {}", source_path_str, e);
                let _ = app_handle.emit("import-error", e);
                return;
            }
        }

        let _ = app_handle.emit(
            "import-progress",
            serde_json::json!({ "current": total_files, "total": total_files, "path": "" }),
        );
        let _ = app_handle.emit("import-complete", ());
    });

    Ok(())
}

pub fn generate_filename_from_template(
    template: &str,
    original_path: &std::path::Path,
    sequence: usize,
    total: usize,
    file_date: &DateTime<Utc>,
) -> String {
    let stem = original_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let sequence_str = format!(
        "{:0width$}",
        sequence,
        width = total.to_string().len().max(1)
    );
    let local_date = file_date.with_timezone(&chrono::Local);

    let mut result = template.to_string();
    result = result.replace("{original_filename}", stem);
    result = result.replace("{sequence}", &sequence_str);
    result = result.replace("{YYYY}", &local_date.format("%Y").to_string());
    result = result.replace("{MM}", &local_date.format("%m").to_string());
    result = result.replace("{DD}", &local_date.format("%d").to_string());
    result = result.replace("{hh}", &local_date.format("%H").to_string());
    result = result.replace("{mm}", &local_date.format("%M").to_string());

    result
}

#[tauri::command]
pub fn rename_files(
    paths: Vec<String>,
    name_template: String,
    app_handle: AppHandle,
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let mut operations: HashMap<PathBuf, PathBuf> = HashMap::new();
    let mut final_new_paths = Vec::with_capacity(paths.len());
    let mut renames = HashMap::new();

    for (i, path_str) in paths.iter().enumerate() {
        let (original_path, _) = parse_virtual_path(path_str);
        if !original_path.exists() {
            return Err(format!("File not found: {}", path_str));
        }

        let parent = original_path
            .parent()
            .ok_or("Could not get parent directory")?;
        let extension = original_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        let file_date = exif_processing::get_creation_date_from_path(&original_path);

        let new_stem = generate_filename_from_template(
            &name_template,
            &original_path,
            i + 1,
            paths.len(),
            &file_date,
        );
        let new_filename = format!("{}.{}", new_stem, extension);
        let new_path = parent.join(new_filename);

        if new_path.exists() && new_path != original_path {
            return Err(format!(
                "A file with the name {} already exists.",
                new_path.display()
            ));
        }

        operations.insert(original_path, new_path);
    }

    let mut sidecar_operations: HashMap<PathBuf, PathBuf> = HashMap::new();
    for (original_path, new_path) in &operations {
        let parent = original_path
            .parent()
            .ok_or("Could not get parent directory")?;
        let original_filename_str = original_path.file_name().unwrap().to_string_lossy();
        let new_filename_str = new_path.file_name().unwrap().to_string_lossy();

        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.filter_map(Result::ok) {
                let entry_path = entry.path();
                let entry_os_filename = entry.file_name();
                let entry_filename = entry_os_filename.to_string_lossy();

                if entry_filename.starts_with(&format!("{}.", original_filename_str))
                    && entry_filename.ends_with(".rrdata")
                {
                    let new_sidecar_filename =
                        entry_filename.replacen(&*original_filename_str, &new_filename_str, 1);
                    let new_sidecar_path = parent.join(new_sidecar_filename);
                    sidecar_operations.insert(entry_path, new_sidecar_path);
                } else if entry_filename == format!("{}.rrdata", original_filename_str) {
                    let mut new_sidecar_name = new_path.file_name().unwrap().to_os_string();
                    new_sidecar_name.push(".rrdata");
                    let new_sidecar_path = new_path.with_file_name(new_sidecar_name);

                    sidecar_operations.insert(entry_path, new_sidecar_path);
                }
            }
        }

        let mut old_rrexif_name = original_path.file_name().unwrap().to_os_string();
        old_rrexif_name.push(".rrexif");
        let old_rrexif = original_path.with_file_name(old_rrexif_name);

        if old_rrexif.exists() {
            let mut new_rrexif_name = new_path.file_name().unwrap().to_os_string();
            new_rrexif_name.push(".rrexif");
            let new_rrexif = new_path.with_file_name(new_rrexif_name);
            sidecar_operations.insert(old_rrexif, new_rrexif);
        }
    }
    operations.extend(sidecar_operations);

    for (old_path, new_path) in operations {
        fs::rename(&old_path, &new_path).map_err(|e| {
            format!(
                "Failed to rename {} to {}: {}",
                old_path.display(),
                new_path.display(),
                e
            )
        })?;

        let old_str = old_path.to_string_lossy().into_owned();
        let new_str = new_path.to_string_lossy().into_owned();

        renames.insert(old_str, new_str.clone());

        if is_supported_image_file(&new_path) {
            final_new_paths.push(new_str);
        }
    }

    sync_album_path_changes(&app_handle, Some(&renames), None, None);

    Ok(final_new_paths)
}

#[tauri::command]
pub fn create_virtual_copy(
    source_virtual_path: String,
    target_album_id: Option<String>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (source_path, source_sidecar_path) = parse_virtual_path(&source_virtual_path);

    let new_copy_id = Uuid::new_v4().to_string()[..6].to_string();
    let new_virtual_path = format!("{}?vc={}", source_path.to_string_lossy(), new_copy_id);
    let (_, new_sidecar_path) = parse_virtual_path(&new_virtual_path);

    if source_sidecar_path.exists() {
        fs::copy(&source_sidecar_path, &new_sidecar_path)
            .map_err(|e| format!("Failed to copy sidecar file: {}", e))?;
    } else {
        let default_metadata = ImageMetadata::default();
        let json_string =
            serde_json::to_string_pretty(&default_metadata).map_err(|e| e.to_string())?;
        fs::write(new_sidecar_path, json_string).map_err(|e| e.to_string())?;
    }

    if let Some(album_id) = target_album_id {
        let _ = add_to_album(album_id, vec![new_virtual_path.clone()], app_handle);
    }

    Ok(new_virtual_path)
}

pub fn extract_xmp_rating(content: &str) -> Option<u8> {
    if let Some(idx) = content.find("xmp:Rating=\"") {
        let start = idx + 12;
        let end = content[start..].find('"').map(|i| start + i)?;
        return content[start..end].parse().ok();
    }
    if let Some(idx) = content.find("<xmp:Rating>") {
        let start = idx + 12;
        let end = content[start..].find('<').map(|i| start + i)?;
        return content[start..end].parse().ok();
    }
    None
}

pub fn extract_xmp_label(content: &str) -> Option<String> {
    if let Some(idx) = content.find("xmp:Label=\"") {
        let start = idx + 11;
        let end = content[start..].find('"').map(|i| start + i)?;
        return Some(content[start..end].to_string());
    }
    if let Some(idx) = content.find("<xmp:Label>") {
        let start = idx + 11;
        let end = content[start..].find('<').map(|i| start + i)?;
        return Some(content[start..end].to_string());
    }
    None
}

pub fn extract_xmp_tags(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    if let Some(start_idx) = content.find("<dc:subject>")
        && let Some(end_idx) = content[start_idx..].find("</dc:subject>")
    {
        let subject_block = &content[start_idx..start_idx + end_idx];
        let mut current_idx = 0;
        while let Some(li_start) = subject_block[current_idx..].find("<rdf:li>") {
            let val_start = current_idx + li_start + 8;
            if let Some(li_end) = subject_block[val_start..].find("</rdf:li>") {
                tags.push(subject_block[val_start..val_start + li_end].to_string());
                current_idx = val_start + li_end + 9;
            } else {
                break;
            }
        }
    }
    tags
}

pub fn resolve_xmp_path(image_path: &Path) -> Option<PathBuf> {
    let xmp_path = image_path.with_extension("xmp");
    let xmp_path_upper = image_path.with_extension("XMP");
    if xmp_path.exists() {
        Some(xmp_path)
    } else if xmp_path_upper.exists() {
        Some(xmp_path_upper)
    } else {
        None
    }
}

pub fn sync_metadata_from_xmp(source_path: &Path, metadata: &mut ImageMetadata) -> bool {
    let actual_xmp = resolve_xmp_path(source_path);

    let mut changed = false;

    if let Some(xmp_file) = actual_xmp
        && let Ok(content) = fs::read_to_string(&xmp_file)
    {
        if metadata.rating == 0
            && let Some(rating) = extract_xmp_rating(&content)
            && rating != 0
        {
            metadata.rating = rating;
            if let Some(obj) = metadata.adjustments.as_object_mut() {
                obj.insert("rating".to_string(), serde_json::json!(rating));
            } else {
                metadata.adjustments = serde_json::json!({"rating": rating});
            }
            changed = true;
        }

        let xmp_label = extract_xmp_label(&content);
        let xmp_tags = extract_xmp_tags(&content);

        let mut current_tags = metadata.tags.clone().unwrap_or_default();
        let original_len = current_tags.len();
        let had_no_tags = metadata.tags.is_none();

        for tag in xmp_tags {
            if !current_tags.contains(&tag) {
                current_tags.push(tag);
            }
        }

        if let Some(label) = xmp_label {
            let label_tag = format!("{}{}", COLOR_TAG_PREFIX, label.to_lowercase());
            if !current_tags.contains(&label_tag) {
                current_tags.retain(|t| !t.starts_with(COLOR_TAG_PREFIX));
                current_tags.push(label_tag);
            }
        }

        if current_tags.len() != original_len || (had_no_tags && !current_tags.is_empty()) {
            metadata.tags = Some(current_tags);
            changed = true;
        }
    }
    changed
}

pub fn sync_metadata_to_xmp(source_path: &Path, metadata: &ImageMetadata, create_if_missing: bool) {
    let xmp_path = source_path.with_extension("xmp");
    let xmp_path_upper = source_path.with_extension("XMP");

    let mut actual_xmp = if xmp_path.exists() {
        Some(xmp_path.clone())
    } else if xmp_path_upper.exists() {
        Some(xmp_path_upper.clone())
    } else {
        None
    };

    if actual_xmp.is_none() {
        if !create_if_missing {
            return;
        }
        let skeleton = r#"<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="RapidRAW">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#;
        if let Err(e) = fs::write(&xmp_path, skeleton) {
            log::error!("Failed to create skeleton XMP: {}", e);
            return;
        }
        actual_xmp = Some(xmp_path);
    }

    if let Some(xmp_file) = actual_xmp
        && let Ok(mut content) = fs::read_to_string(&xmp_file)
    {
        let rating_str = metadata.rating.to_string();
        let re_rating_attr = Regex::new(r#"xmp:Rating\s*=\s*"[^"]*""#).unwrap();
        let re_rating_tag = Regex::new(r#"<xmp:Rating\s*>[^<]*</xmp:Rating>"#).unwrap();

        if re_rating_attr.is_match(&content) {
            content = re_rating_attr
                .replace(&content, format!("xmp:Rating=\"{}\"", rating_str))
                .to_string();
        } else if re_rating_tag.is_match(&content) {
            content = re_rating_tag
                .replace(&content, format!("<xmp:Rating>{}</xmp:Rating>", rating_str))
                .to_string();
        } else if let Some(last_index) = content.rfind("</rdf:Description>") {
            let (start, end) = content.split_at(last_index);
            content = format!("{} <xmp:Rating>{}</xmp:Rating>\n{}", start, rating_str, end);
        }

        let current_tags = metadata.tags.clone().unwrap_or_default();
        let mut label = None;
        let mut normal_tags = Vec::new();

        for t in current_tags {
            if let Some(color) = t.strip_prefix(COLOR_TAG_PREFIX) {
                let mut c = color.chars();
                let cap_color = match c.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                };
                label = Some(cap_color);
            } else {
                normal_tags.push(t);
            }
        }

        if let Some(lbl) = label {
            let re_label_attr = Regex::new(r#"xmp:Label\s*=\s*"[^"]*""#).unwrap();
            let re_label_tag = Regex::new(r#"<xmp:Label\s*>[^<]*</xmp:Label>"#).unwrap();

            if re_label_attr.is_match(&content) {
                content = re_label_attr
                    .replace(&content, format!("xmp:Label=\"{}\"", lbl))
                    .to_string();
            } else if re_label_tag.is_match(&content) {
                content = re_label_tag
                    .replace(&content, format!("<xmp:Label>{}</xmp:Label>", lbl))
                    .to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!("{} <xmp:Label>{}</xmp:Label>\n{}", start, lbl, end);
            }
        } else {
            let re_label_attr = Regex::new(r#"\s*xmp:Label\s*=\s*"[^"]*""#).unwrap();
            let re_label_tag = Regex::new(r#"\s*<xmp:Label\s*>[^<]*</xmp:Label>"#).unwrap();
            content = re_label_attr.replace_all(&content, "").to_string();
            content = re_label_tag.replace_all(&content, "").to_string();
        }

        let re_subject =
            Regex::new(r#"(?s)<dc:subject>\s*<rdf:Bag>.*?</rdf:Bag>\s*</dc:subject>"#).unwrap();
        if normal_tags.is_empty() {
            content = re_subject.replace_all(&content, "").to_string();
        } else {
            let mut bag = String::from("<dc:subject>\n    <rdf:Bag>\n");
            for t in normal_tags {
                bag.push_str(&format!("     <rdf:li>{}</rdf:li>\n", t));
            }
            bag.push_str("    </rdf:Bag>\n   </dc:subject>");

            if re_subject.is_match(&content) {
                content = re_subject.replace(&content, bag).to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!("{} {}\n  {}", start, bag, end);
            }
        }

        let _ = fs::write(&xmp_file, content);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        camera_defaults::{CameraDefaults, ImageSourceKind},
        image_loader::LoadedBaseImage,
    };
    use image::{Rgb, Rgb32FImage};
    use serde_json::json;
    use std::{
        collections::HashMap,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use tokio::sync::Semaphore;

    fn thumbnail_test_image() -> DynamicImage {
        DynamicImage::ImageRgb32F(Rgb32FImage::from_pixel(8, 6, Rgb([0.18, 0.25, 0.4])))
    }

    fn thumbnail_test_jpeg(color: [f32; 3]) -> Vec<u8> {
        let image = DynamicImage::ImageRgb32F(Rgb32FImage::from_pixel(8, 6, Rgb(color)));
        encode_thumbnail(&image, 8).unwrap()
    }

    fn thumbnail_test_cube(last_blue: f32) -> String {
        format!(
            "LUT_3D_SIZE 2\n\
             0 0 0\n\
             1 0 0\n\
             0 1 0\n\
             1 1 0\n\
             0 0 1\n\
             1 0 1\n\
             0 1 1\n\
             1 1 {last_blue}\n"
        )
    }

    fn thumbnail_test_loaded(source_kind: ImageSourceKind) -> LoadedBaseImage {
        LoadedBaseImage {
            image: thumbnail_test_image(),
            source_kind,
        }
    }

    fn thumbnail_test_defaults() -> CameraDefaults {
        CameraDefaults {
            crop: Some(Crop {
                x: 2.0,
                y: 2.0,
                width: 4.0,
                height: 2.0,
            }),
            aspect_ratio: Some(2.0),
            canvas_width: Some(8),
            canvas_height: Some(6),
        }
    }

    fn thumbnail_test_profile() -> ThumbnailRenderProfile {
        thumbnail_render_profile(&AppSettings::default(), true, &Value::Null, true)
    }

    fn thumbnail_test_key(path: &str) -> ThumbnailManifestKey {
        thumbnail_manifest_key(
            path,
            ThumbnailSourceTimestamp {
                seconds: 1_721_000_000,
                nanoseconds: 123_456_789,
            },
            &Value::Null,
            &thumbnail_test_defaults(),
            &thumbnail_test_profile(),
            &ThumbnailLutRequest::NotRequested,
        )
    }

    fn thumbnail_test_identity(key: &ThumbnailManifestKey) -> ThumbnailCacheIdentity {
        thumbnail_cache_identity(key).unwrap()
    }

    fn thumbnail_test_effective_adjustments() -> Value {
        json!({
            "crop": {
                "x": 2.0,
                "y": 2.0,
                "width": 4.0,
                "height": 2.0,
            },
            "aspectRatio": 2.0,
        })
    }

    fn thumbnail_test_fingerprint(key: &ThumbnailManifestKey) -> ThumbnailRenderFingerprint {
        let actual_lut_outcome = match &key.lut_request {
            ThumbnailLutRequest::NotRequested => ThumbnailLutOutcome::NotRequested,
            ThumbnailLutRequest::Available(identity) => {
                ThumbnailLutOutcome::Applied(identity.clone())
            }
            ThumbnailLutRequest::Unavailable => ThumbnailLutOutcome::Unavailable,
        };
        thumbnail_render_fingerprint(
            &thumbnail_test_identity(key),
            &thumbnail_test_effective_adjustments(),
            ImageSourceKind::DevelopedRaw,
            key.render_profile.dispatch,
            actual_lut_outcome,
        )
        .unwrap()
    }

    fn thumbnail_test_manifest(
        fingerprint: &ThumbnailRenderFingerprint,
        jpeg: &[u8],
    ) -> ThumbnailManifest {
        ThumbnailManifest {
            schema_version: THUMBNAIL_MANIFEST_SCHEMA_VERSION,
            fingerprint: fingerprint.clone(),
            jpeg_digest: thumbnail_jpeg_digest(jpeg),
            jpeg_byte_len: jpeg.len() as u64,
        }
    }

    #[test]
    fn thumbnail_null_developed_raw_uses_camera_crop() {
        let loaded = thumbnail_test_loaded(ImageSourceKind::DevelopedRaw);
        let render =
            prepare_thumbnail_render_input(&Value::Null, &thumbnail_test_defaults(), &loaded);

        assert!(render.persisted_is_null);
        assert_eq!(render.source_kind, ImageSourceKind::DevelopedRaw);
        assert_eq!(
            select_thumbnail_render_path(&render, true),
            ThumbnailRenderPath::DefaultCpu
        );

        let output = render_thumbnail_from_loaded(
            loaded,
            &render,
            true,
            &AppSettings {
                default_raw_tonemapper: Some("agx".to_string()),
                ..AppSettings::default()
            },
        )
        .unwrap();

        assert_eq!(output.dimensions(), (4, 2));
    }

    #[test]
    fn thumbnail_embedded_preview_stays_full_frame() {
        let loaded = thumbnail_test_loaded(ImageSourceKind::EmbeddedPreview);
        let mut expected = loaded.image.clone();
        crate::image_processing::apply_cpu_agx_tonemap(&mut expected);
        let render =
            prepare_thumbnail_render_input(&Value::Null, &thumbnail_test_defaults(), &loaded);

        assert!(render.persisted_is_null);
        assert_eq!(render.source_kind, ImageSourceKind::EmbeddedPreview);
        assert!(render.effective_adjustments.is_null());
        assert_eq!(
            select_thumbnail_render_path(&render, true),
            ThumbnailRenderPath::DefaultCpu
        );

        let output = render_thumbnail_from_loaded(
            loaded,
            &render,
            true,
            &AppSettings {
                default_raw_tonemapper: Some("agx".to_string()),
                ..AppSettings::default()
            },
        )
        .unwrap();

        assert_eq!(output.dimensions(), (8, 6));
        assert_eq!(output.to_rgb32f(), expected.to_rgb32f());
    }

    #[test]
    fn thumbnail_explicit_object_selects_gpu_dispatch() {
        let loaded = thumbnail_test_loaded(ImageSourceKind::DevelopedRaw);
        let render =
            prepare_thumbnail_render_input(&json!({}), &thumbnail_test_defaults(), &loaded);

        assert!(!render.persisted_is_null);
        assert_eq!(render.effective_adjustments, json!({}));
        assert_eq!(
            select_thumbnail_render_path(&render, true),
            ThumbnailRenderPath::ObjectGpu
        );
    }

    #[test]
    fn thumbnail_gpu_failure_reports_actual_fallback_path() {
        let fallback = thumbnail_test_image();
        let expected = fallback.to_rgb32f();

        let rendered = resolve_thumbnail_gpu_result::<&str>(
            Err("runtime GPU failure"),
            fallback,
            ThumbnailLutOutcome::NotRequested,
            ThumbnailLutOutcome::NotRequested,
        );

        assert_eq!(
            rendered.actual_render_path,
            ThumbnailRenderPath::ObjectFallback
        );
        assert_eq!(rendered.image.to_rgb32f(), expected);
    }

    #[test]
    fn thumbnail_gpu_limit_only_falls_back_above_max_dimension() {
        let max_dimension = 4_096;

        assert!(!thumbnail_gpu_input_exceeds_limit(
            max_dimension,
            max_dimension,
            max_dimension
        ));
        assert!(thumbnail_gpu_input_exceeds_limit(
            max_dimension + 1,
            1,
            max_dimension
        ));
        assert!(thumbnail_gpu_input_exceeds_limit(
            1,
            max_dimension + 1,
            max_dimension
        ));
    }

    #[test]
    fn thumbnail_preloaded_embedded_preview_preserves_authoritative_kind() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("preview-fallback.RAF");
        fs::write(&source, b"identity-only").unwrap();
        let source_for_extractor = source.clone();
        let extraction_count = Arc::new(AtomicUsize::new(0));
        let extraction_count_for_call = Arc::clone(&extraction_count);
        let defaults = thumbnail_test_defaults();
        let key = thumbnail_manifest_key_for_path_with(
            source.to_str().unwrap(),
            &Value::Null,
            &thumbnail_test_profile(),
            &ThumbnailLutRequest::NotRequested,
            move |path| {
                assert_eq!(path, source_for_extractor.as_path());
                extraction_count_for_call.fetch_add(1, Ordering::SeqCst);
                defaults
            },
        )
        .unwrap();
        let preloaded = ThumbnailPreloadedImage {
            image: Arc::new(thumbnail_test_image()),
            source_kind: ImageSourceKind::EmbeddedPreview,
        };
        let loaded = preloaded.into_loaded();
        let render = prepare_thumbnail_render_input(
            &key.persisted_adjustments,
            &key.camera_defaults,
            &loaded,
        );

        assert_eq!(extraction_count.load(Ordering::SeqCst), 1);
        assert_eq!(loaded.source_kind, ImageSourceKind::EmbeddedPreview);
        assert!(render.effective_adjustments.is_null());
    }

    #[test]
    fn thumbnail_preloaded_patches_composite_from_shared_arc() {
        let shared = Arc::new(thumbnail_test_image());
        let additional_owner = Arc::clone(&shared);
        let preloaded = ThumbnailPreloadedImage {
            image: shared,
            source_kind: ImageSourceKind::DevelopedRaw,
        };
        let adjustments = json!({ "aiPatches": [{}] });

        let loaded =
            composite_preloaded_thumbnail_with(preloaded, &adjustments, |base_image, _| {
                assert!(std::ptr::eq(base_image, additional_owner.as_ref()));
                Ok(base_image.clone())
            })
            .unwrap();

        assert_eq!(loaded.source_kind, ImageSourceKind::DevelopedRaw);
    }

    #[test]
    fn thumbnail_manifest_key_rejects_source_change_during_defaults_extraction() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("changing.RAF");
        fs::write(&source, b"before").unwrap();
        let changed_time = filetime::FileTime::from_unix_time(2_000_000_000, 987_654_321);

        let key = thumbnail_manifest_key_for_path_with(
            source.to_str().unwrap(),
            &Value::Null,
            &thumbnail_test_profile(),
            &ThumbnailLutRequest::NotRequested,
            |path| {
                fs::write(path, b"after").unwrap();
                filetime::set_file_mtime(path, changed_time).unwrap();
                thumbnail_test_defaults()
            },
        );

        assert!(key.is_none());
    }

    #[test]
    fn thumbnail_manifest_hashes_path_defaults_effective_crop_and_source() {
        let base_key = thumbnail_test_key("/photos/image.RAF?vc=one");
        let base_fingerprint = thumbnail_test_fingerprint(&base_key);
        let base_key_hash = thumbnail_manifest_key_hash(&base_key).unwrap();
        let base_final_hash = thumbnail_render_fingerprint_hash(&base_fingerprint).unwrap();

        let mut path_key = base_key.clone();
        path_key.virtual_path = "/photos/image.RAF?vc=two".to_string();
        assert_ne!(
            thumbnail_manifest_key_hash(&path_key).unwrap(),
            base_key_hash
        );
        let path_fingerprint = thumbnail_test_fingerprint(&path_key);
        assert_ne!(
            thumbnail_render_fingerprint_hash(&path_fingerprint).unwrap(),
            base_final_hash
        );

        let mut time_key = base_key.clone();
        time_key.source_modified.nanoseconds += 1;
        assert_ne!(
            thumbnail_manifest_key_hash(&time_key).unwrap(),
            base_key_hash
        );
        let time_fingerprint = thumbnail_test_fingerprint(&time_key);
        assert_ne!(
            thumbnail_render_fingerprint_hash(&time_fingerprint).unwrap(),
            base_final_hash
        );

        let mut defaults_key = base_key.clone();
        defaults_key.camera_defaults.crop.as_mut().unwrap().x += 1.0;
        assert_ne!(
            thumbnail_manifest_key_hash(&defaults_key).unwrap(),
            base_key_hash
        );
        let defaults_fingerprint = thumbnail_test_fingerprint(&defaults_key);
        assert_ne!(
            thumbnail_render_fingerprint_hash(&defaults_fingerprint).unwrap(),
            base_final_hash
        );

        let mut persisted_key = base_key.clone();
        persisted_key.persisted_adjustments = json!({});
        assert_ne!(
            thumbnail_manifest_key_hash(&persisted_key).unwrap(),
            base_key_hash
        );
        let persisted_fingerprint = thumbnail_test_fingerprint(&persisted_key);
        assert_ne!(
            thumbnail_render_fingerprint_hash(&persisted_fingerprint).unwrap(),
            base_final_hash
        );

        let mut changed_effective = thumbnail_test_effective_adjustments();
        changed_effective["crop"]["width"] = json!(3.0);
        let effective_fingerprint = thumbnail_render_fingerprint(
            &thumbnail_test_identity(&base_key),
            &changed_effective,
            ImageSourceKind::DevelopedRaw,
            base_key.render_profile.dispatch,
            ThumbnailLutOutcome::NotRequested,
        )
        .unwrap();
        assert_ne!(
            thumbnail_render_fingerprint_hash(&effective_fingerprint).unwrap(),
            base_final_hash
        );

        let mut source_fingerprint = base_fingerprint.clone();
        source_fingerprint.source_kind = ImageSourceKind::EmbeddedPreview;
        assert_ne!(
            thumbnail_render_fingerprint_hash(&source_fingerprint).unwrap(),
            base_final_hash
        );
    }

    #[test]
    fn thumbnail_manifest_hash_includes_render_profile() {
        let base_key = thumbnail_test_key("/photos/image.RAF");
        let base_fingerprint = thumbnail_test_fingerprint(&base_key);
        let base_key_hash = thumbnail_manifest_key_hash(&base_key).unwrap();
        let base_fingerprint_hash = thumbnail_render_fingerprint_hash(&base_fingerprint).unwrap();
        let mut changed_keys = Vec::new();

        let mut changed = base_key.clone();
        changed.render_profile.target_width += 1;
        changed_keys.push(changed);
        let mut changed = base_key.clone();
        changed.render_profile.default_tonemapper = "basic".to_string();
        changed_keys.push(changed);
        let mut changed = base_key.clone();
        changed.render_profile.tonemapper_override_enabled = true;
        changed_keys.push(changed);
        let mut changed = base_key.clone();
        changed.render_profile.raw_highlight_compression += 0.25;
        changed_keys.push(changed);
        let mut changed = base_key.clone();
        changed.render_profile.linear_raw_mode.push_str("-changed");
        changed_keys.push(changed);
        let mut changed = base_key.clone();
        changed.render_profile.raw_preprocessing_color_nr += 0.25;
        changed_keys.push(changed);
        let mut changed = base_key.clone();
        changed.render_profile.raw_preprocessing_sharpening += 0.25;
        changed_keys.push(changed);
        let mut changed = base_key.clone();
        changed.render_profile.apply_preprocessing_to_non_raws =
            !changed.render_profile.apply_preprocessing_to_non_raws;
        changed_keys.push(changed);
        let mut changed = base_key.clone();
        changed.render_profile.dispatch = ThumbnailRenderPath::ObjectFallback;
        changed_keys.push(changed);

        for changed_key in changed_keys {
            assert_ne!(
                thumbnail_manifest_key_hash(&changed_key).unwrap(),
                base_key_hash
            );
            let changed_fingerprint = thumbnail_test_fingerprint(&changed_key);
            assert_ne!(
                thumbnail_render_fingerprint_hash(&changed_fingerprint).unwrap(),
                base_fingerprint_hash
            );
        }
    }

    #[test]
    fn thumbnail_manifest_lookup_rejects_missing_malformed_and_mismatched_entries() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let manifest_path = thumbnail_manifest_path(temp.path(), &identity).unwrap();

        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());

        fs::write(&manifest_path, b"{").unwrap();
        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());

        let other_key = thumbnail_test_key("/photos/other.RAF");
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let key_mismatch = thumbnail_test_manifest(&thumbnail_test_fingerprint(&other_key), &jpeg);
        fs::write(&manifest_path, serde_json::to_vec(&key_mismatch).unwrap()).unwrap();
        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());

        let mut mismatched_fingerprint = fingerprint;
        mismatched_fingerprint.key_digest = thumbnail_test_identity(&other_key).key_digest;
        let fingerprint_mismatch = thumbnail_test_manifest(&mismatched_fingerprint, &jpeg);
        fs::write(
            &manifest_path,
            serde_json::to_vec(&fingerprint_mismatch).unwrap(),
        )
        .unwrap();
        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());
    }

    #[test]
    fn thumbnail_manifest_lookup_rejects_actual_render_path_mismatch() {
        let temp = tempfile::tempdir().unwrap();
        let mut key = thumbnail_test_key("/photos/image.RAF");
        key.render_profile.dispatch = ThumbnailRenderPath::ObjectGpu;
        let identity = thumbnail_test_identity(&key);
        let mut fingerprint = thumbnail_test_fingerprint(&key);
        fingerprint.actual_render_path = ThumbnailRenderPath::ObjectFallback;
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let manifest = thumbnail_test_manifest(&fingerprint, &jpeg);
        let jpeg_filename = thumbnail_jpeg_filename(&fingerprint, &manifest.jpeg_digest).unwrap();
        let manifest_path = thumbnail_manifest_path(temp.path(), &identity).unwrap();

        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        fs::write(temp.path().join(jpeg_filename), jpeg).unwrap();

        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());
    }

    #[test]
    fn thumbnail_manifest_lookup_rejects_invalid_digest_and_missing_jpeg() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let manifest_path = thumbnail_manifest_path(temp.path(), &identity).unwrap();
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let mut invalid = thumbnail_test_manifest(&fingerprint, &jpeg);
        invalid.jpeg_digest = "not-a-digest".to_string();
        fs::write(&manifest_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());

        let missing_jpeg = thumbnail_test_manifest(&fingerprint, &jpeg);
        fs::write(&manifest_path, serde_json::to_vec(&missing_jpeg).unwrap()).unwrap();
        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());
    }

    #[test]
    fn thumbnail_manifest_lookup_rejects_malformed_effective_adjustments_digest() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let mut fingerprint = thumbnail_test_fingerprint(&key);
        fingerprint.effective_adjustments_digest = "not-a-digest".to_string();
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let manifest = thumbnail_test_manifest(&fingerprint, &jpeg);
        let jpeg_filename =
            thumbnail_jpeg_filename(&manifest.fingerprint, &manifest.jpeg_digest).unwrap();
        let manifest_path = thumbnail_manifest_path(temp.path(), &identity).unwrap();

        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        fs::write(temp.path().join(jpeg_filename), jpeg).unwrap();

        assert_eq!(lookup_thumbnail_manifest(temp.path(), &identity), None);
    }

    #[test]
    fn thumbnail_manifest_lookup_rejects_oversized_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let manifest = thumbnail_test_manifest(&fingerprint, &jpeg);
        let jpeg_filename =
            thumbnail_jpeg_filename(&manifest.fingerprint, &manifest.jpeg_digest).unwrap();
        let manifest_path = thumbnail_manifest_path(temp.path(), &identity).unwrap();
        let mut manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        manifest_bytes.resize(THUMBNAIL_MANIFEST_MAX_BYTES as usize + 1, b' ');

        fs::write(&manifest_path, manifest_bytes).unwrap();
        fs::write(temp.path().join(jpeg_filename), jpeg).unwrap();

        assert_eq!(lookup_thumbnail_manifest(temp.path(), &identity), None);
    }

    #[test]
    fn thumbnail_manifest_lookup_rejects_mismatched_jpeg_length() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let mut manifest = thumbnail_test_manifest(&fingerprint, &jpeg);
        manifest.jpeg_byte_len += 1;
        let jpeg_filename =
            thumbnail_jpeg_filename(&manifest.fingerprint, &manifest.jpeg_digest).unwrap();
        let manifest_path = thumbnail_manifest_path(temp.path(), &identity).unwrap();

        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        fs::write(temp.path().join(jpeg_filename), jpeg).unwrap();

        assert_eq!(lookup_thumbnail_manifest(temp.path(), &identity), None);
    }

    #[test]
    fn thumbnail_manifest_lookup_rejects_digest_matching_non_jpeg() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let jpeg = b"digest-matching bytes that are not a JPEG";
        let manifest = thumbnail_test_manifest(&fingerprint, jpeg);
        let jpeg_filename = thumbnail_jpeg_filename(&fingerprint, &manifest.jpeg_digest).unwrap();
        let manifest_path = thumbnail_manifest_path(temp.path(), &identity).unwrap();

        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        fs::write(temp.path().join(jpeg_filename), jpeg).unwrap();

        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());
    }

    #[test]
    fn thumbnail_publication_makes_jpeg_available_before_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let manifest_path = thumbnail_manifest_path(temp.path(), &identity).unwrap();
        let jpeg_path = temp
            .path()
            .join(thumbnail_jpeg_filename(&fingerprint, &thumbnail_jpeg_digest(&jpeg)).unwrap());
        let identity_for_recheck = identity.clone();

        let hit = publish_thumbnail_cache_with_recheck(temp.path(), &fingerprint, &jpeg, || {
            assert!(jpeg_path.is_file());
            assert!(!manifest_path.exists());
            let staged_manifest_count = fs::read_dir(temp.path())
                .unwrap()
                .filter_map(std::result::Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path != &jpeg_path && path != &manifest_path)
                .count();
            assert_eq!(staged_manifest_count, 1);
            assert!(lookup_thumbnail_manifest(temp.path(), &identity_for_recheck).is_none());
            Some(identity_for_recheck.clone())
        })
        .unwrap();

        assert_eq!(hit.jpeg_path, jpeg_path);
        assert_eq!(hit.manifest_path, Some(manifest_path));
        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_some());
    }

    #[test]
    fn thumbnail_force_publication_uses_content_derived_paths() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let first = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let forced = thumbnail_test_jpeg([0.7, 0.4, 0.2]);
        let mut hits = Vec::new();

        for bytes in [&first, &forced] {
            let identity_for_recheck = identity.clone();
            hits.push(
                publish_thumbnail_cache_with_recheck(temp.path(), &fingerprint, bytes, move || {
                    Some(identity_for_recheck)
                })
                .unwrap(),
            );
        }

        assert_ne!(hits[0].jpeg_path, hits[1].jpeg_path);
        assert_eq!(fs::read(&hits[0].jpeg_path).unwrap(), first);
        assert_eq!(fs::read(&hits[1].jpeg_path).unwrap(), forced);
        assert_eq!(
            lookup_thumbnail_manifest(temp.path(), &identity),
            Some(hits[1].clone())
        );
    }

    #[test]
    fn thumbnail_failed_force_publication_preserves_live_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let first_jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let rejected_jpeg = thumbnail_test_jpeg([0.7, 0.4, 0.2]);
        let identity_for_initial_recheck = identity.clone();
        let live_hit = publish_thumbnail_cache_with_recheck(
            temp.path(),
            &fingerprint,
            &first_jpeg,
            move || Some(identity_for_initial_recheck),
        )
        .unwrap();
        let manifest_path = live_hit.manifest_path.clone().unwrap();
        let manifest_before = fs::read(&manifest_path).unwrap();
        let jpeg_before = fs::read(&live_hit.jpeg_path).unwrap();

        let rejected =
            publish_thumbnail_cache_with_recheck(temp.path(), &fingerprint, &rejected_jpeg, || {
                None
            });

        assert!(rejected.is_err());
        assert_eq!(fs::read(&manifest_path).unwrap(), manifest_before);
        assert_eq!(fs::read(&live_hit.jpeg_path).unwrap(), jpeg_before);
        assert_eq!(
            lookup_thumbnail_manifest(temp.path(), &identity),
            Some(live_hit)
        );
    }

    #[test]
    fn thumbnail_lookup_rejects_same_length_content_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let identity_for_recheck = identity.clone();
        let hit =
            publish_thumbnail_cache_with_recheck(temp.path(), &fingerprint, &jpeg, move || {
                Some(identity_for_recheck)
            })
            .unwrap();
        let mut corrupted = fs::read(&hit.jpeg_path).unwrap();
        let middle = corrupted.len() / 2;
        corrupted[middle] ^= 0x01;
        fs::write(&hit.jpeg_path, &corrupted).unwrap();

        assert_eq!(corrupted.len(), jpeg.len());
        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());
    }

    #[test]
    fn thumbnail_cache_regenerates_corrupt_content_addressed_jpeg() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let identity_for_initial_recheck = identity.clone();
        let initial_hit =
            publish_thumbnail_cache_with_recheck(temp.path(), &fingerprint, &jpeg, move || {
                Some(identity_for_initial_recheck)
            })
            .unwrap();
        let mut corrupted = jpeg.clone();
        let middle = corrupted.len() / 2;
        corrupted[middle] ^= 0x01;
        fs::write(&initial_hit.jpeg_path, corrupted).unwrap();

        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());

        let identity_for_recheck = identity.clone();
        let regenerated = resolve_thumbnail_cache_with(
            temp.path(),
            &identity,
            false,
            || Ok((fingerprint, jpeg.clone())),
            move || Some(identity_for_recheck),
        )
        .unwrap();

        assert_eq!(regenerated.jpeg_path, initial_hit.jpeg_path);
        assert_eq!(fs::read(&regenerated.jpeg_path).unwrap(), jpeg);
        assert_eq!(
            lookup_thumbnail_manifest(temp.path(), &identity),
            Some(regenerated)
        );
    }

    #[test]
    fn thumbnail_manifest_omits_large_adjustment_payload_but_key_digest_tracks_it() {
        let marker = format!(
            "large-ai-patch-marker-start{}large-ai-patch-marker-end",
            "x".repeat(2 * 1_024 * 1_024)
        );
        let mut key = thumbnail_test_key("/photos/image.RAF");
        key.persisted_adjustments = json!({
            "aiPatches": [{ "maskDataBase64": marker }],
        });
        let key_digest = thumbnail_manifest_key_hash(&key).unwrap();
        let mut changed_key = key.clone();
        changed_key.persisted_adjustments["aiPatches"][0]["maskDataBase64"] =
            json!(format!("{}-changed", marker));
        assert_ne!(
            thumbnail_manifest_key_hash(&changed_key).unwrap(),
            key_digest
        );
        let fingerprint = thumbnail_render_fingerprint(
            &thumbnail_test_identity(&key),
            &key.persisted_adjustments,
            ImageSourceKind::DevelopedRaw,
            key.render_profile.dispatch,
            ThumbnailLutOutcome::NotRequested,
        )
        .unwrap();
        let manifest = thumbnail_test_manifest(&fingerprint, &thumbnail_test_jpeg([0.1, 0.2, 0.3]));

        let serialized = serde_json::to_string(&manifest).unwrap();

        assert_eq!(serialized.matches(&marker).count(), 0);
        assert!(serialized.len() < 4 * 1_024);
    }

    #[test]
    fn thumbnail_manifest_key_changes_when_lut_bytes_change_at_same_path() {
        let temp = tempfile::tempdir().unwrap();
        let lut_path = temp.path().join("mutable.cube");
        let adjustments = json!({
            "lutPath": lut_path,
            "sectionVisibility": { "effects": true },
        });
        fs::write(&lut_path, thumbnail_test_cube(1.0)).unwrap();
        let first_request = resolve_thumbnail_lut_request(&adjustments);
        let first = thumbnail_manifest_key(
            "/photos/image.RAF",
            ThumbnailSourceTimestamp {
                seconds: 1_721_000_000,
                nanoseconds: 123_456_789,
            },
            &adjustments,
            &thumbnail_test_defaults(),
            &thumbnail_test_profile(),
            &first_request,
        );
        fs::write(&lut_path, thumbnail_test_cube(0.5)).unwrap();
        let second_request = resolve_thumbnail_lut_request(&adjustments);
        let second = thumbnail_manifest_key(
            "/photos/image.RAF",
            first.source_modified,
            &adjustments,
            &thumbnail_test_defaults(),
            &thumbnail_test_profile(),
            &second_request,
        );

        assert_ne!(
            thumbnail_manifest_key_hash(&first).unwrap(),
            thumbnail_manifest_key_hash(&second).unwrap()
        );
    }

    #[test]
    fn thumbnail_missing_or_malformed_lut_is_immediate_but_not_reusable() {
        let temp = tempfile::tempdir().unwrap();
        let malformed = temp.path().join("malformed.cube");
        fs::write(&malformed, "not a LUT").unwrap();
        let missing = temp.path().join("missing.cube");

        for lut_path in [missing, malformed] {
            let adjustments = json!({
                "lutPath": lut_path,
                "sectionVisibility": { "effects": true },
            });
            let mut key = thumbnail_test_key(lut_path.to_str().unwrap());
            key.persisted_adjustments = adjustments;
            key.render_profile.dispatch = ThumbnailRenderPath::ObjectGpu;
            key.lut_request = resolve_thumbnail_lut_request(&key.persisted_adjustments);
            let identity = thumbnail_test_identity(&key);
            let fingerprint = thumbnail_test_fingerprint(&key);
            let generation_count = Arc::new(AtomicUsize::new(0));

            for expected_count in 1..=2 {
                let fingerprint_for_generate = fingerprint.clone();
                let identity_for_recheck = identity.clone();
                let generation_count_for_call = Arc::clone(&generation_count);
                let hit = resolve_thumbnail_cache_with(
                    temp.path(),
                    &identity,
                    false,
                    move || {
                        generation_count_for_call.fetch_add(1, Ordering::SeqCst);
                        Ok((
                            fingerprint_for_generate,
                            thumbnail_test_jpeg([0.2, 0.3, 0.4]),
                        ))
                    },
                    move || Some(identity_for_recheck),
                )
                .unwrap();

                assert_eq!(hit.manifest_path, None);
                assert_eq!(generation_count.load(Ordering::SeqCst), expected_count);
            }
        }
    }

    #[test]
    fn thumbnail_publication_rejects_lut_change_during_sidecar_recheck() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("lut-recheck.RAF");
        let lut_path = temp.path().join("mutable.cube");
        fs::write(&source, b"source").unwrap();
        fs::write(&lut_path, thumbnail_test_cube(1.0)).unwrap();
        let adjustments = json!({
            "lutPath": lut_path,
            "sectionVisibility": { "effects": true },
        });
        let defaults = thumbnail_test_defaults();
        let profile = thumbnail_test_profile();
        let lut_request = resolve_thumbnail_lut_request(&adjustments);
        let key = thumbnail_manifest_key(
            source.to_str().unwrap(),
            thumbnail_source_timestamp(&source).unwrap(),
            &adjustments,
            &defaults,
            &profile,
            &lut_request,
        );
        let fingerprint = thumbnail_test_fingerprint(&key);
        let adjustments_for_recheck = adjustments.clone();

        let result = publish_thumbnail_cache_with_recheck(
            temp.path(),
            &fingerprint,
            &thumbnail_test_jpeg([0.1, 0.2, 0.3]),
            || {
                thumbnail_identity_recheck_with(
                    source.to_str().unwrap(),
                    &defaults,
                    &profile,
                    |_| {
                        fs::write(&lut_path, thumbnail_test_cube(0.5)).unwrap();
                        adjustments_for_recheck
                    },
                )
            },
        );

        assert!(result.is_err());
        assert!(lookup_thumbnail_manifest(temp.path(), &thumbnail_test_identity(&key)).is_none());
    }

    #[test]
    fn thumbnail_cleanup_retains_newest_eight_versions_per_virtual_path() {
        let temp = tempfile::tempdir().unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(2_000_000);
        let old_base = filetime::FileTime::from_unix_time(100_000, 0);
        let mut hits = Vec::new();

        for version in 0..10 {
            let mut key = thumbnail_test_key("/photos/autosaved.RAF");
            key.source_modified.seconds += version;
            let identity = thumbnail_test_identity(&key);
            let fingerprint = thumbnail_test_fingerprint(&key);
            let identity_for_recheck = identity.clone();
            let hit = publish_thumbnail_cache_with_recheck(
                temp.path(),
                &fingerprint,
                &thumbnail_test_jpeg([version as f32 / 20.0, 0.2, 0.3]),
                move || Some(identity_for_recheck),
            )
            .unwrap();
            let mtime =
                filetime::FileTime::from_unix_time(old_base.unix_seconds() + version as i64, 0);
            filetime::set_file_mtime(hit.manifest_path.as_ref().unwrap(), mtime).unwrap();
            filetime::set_file_mtime(&hit.jpeg_path, mtime).unwrap();
            hits.push(hit);
        }

        let removed = cleanup_stale_thumbnail_artifacts_with(
            temp.path(),
            now,
            Duration::from_secs(24 * 60 * 60),
            256,
            8,
        )
        .unwrap();

        assert_eq!(removed.len(), 4);
        for hit in &hits[..2] {
            assert!(!hit.manifest_path.as_ref().unwrap().exists());
            assert!(!hit.jpeg_path.exists());
        }
        for hit in &hits[2..] {
            assert!(hit.manifest_path.as_ref().unwrap().exists());
            assert!(hit.jpeg_path.exists());
        }
    }

    #[test]
    fn thumbnail_cleanup_production_entry_cap_is_256() {
        assert_eq!(THUMBNAIL_CACHE_CLEANUP_MAX_ENTRIES, 256);
    }

    #[test]
    fn thumbnail_cleanup_keeps_pair_when_jpeg_is_within_grace_period() {
        let temp = tempfile::tempdir().unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(2_000_000);
        let grace = Duration::from_secs(24 * 60 * 60);
        let key = thumbnail_test_key("/photos/in-flight.RAF");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let identity_for_recheck = identity.clone();
        let hit = publish_thumbnail_cache_with_recheck(
            temp.path(),
            &fingerprint,
            &thumbnail_test_jpeg([0.2, 0.3, 0.4]),
            move || Some(identity_for_recheck),
        )
        .unwrap();
        filetime::set_file_mtime(
            hit.manifest_path.as_ref().unwrap(),
            filetime::FileTime::from_unix_time(50_000, 0),
        )
        .unwrap();
        filetime::set_file_mtime(
            &hit.jpeg_path,
            filetime::FileTime::from_unix_time(1_999_999, 0),
        )
        .unwrap();

        let removed =
            cleanup_stale_thumbnail_artifacts_with(temp.path(), now, grace, 256, 0).unwrap();

        assert!(removed.is_empty());
        assert!(hit.manifest_path.unwrap().exists());
        assert!(hit.jpeg_path.exists());
    }

    #[test]
    fn thumbnail_cleanup_removes_only_aged_legacy_v1_jpegs() {
        let temp = tempfile::tempdir().unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(2_000_000);
        let grace = Duration::from_secs(24 * 60 * 60);
        let legacy_jpeg = temp.path().join(format!("{}.jpg", "a".repeat(64)));
        let legacy_transient = temp
            .path()
            .join(format!("{}.transient.jpg", "b".repeat(64)));
        let fresh_legacy = temp.path().join(format!("{}.jpg", "c".repeat(64)));
        let unrelated = temp.path().join("not-owned.jpg");
        for path in [&legacy_jpeg, &legacy_transient, &fresh_legacy, &unrelated] {
            fs::write(path, b"legacy").unwrap();
        }
        filetime::set_file_mtime(&legacy_jpeg, filetime::FileTime::from_unix_time(50_000, 0))
            .unwrap();
        filetime::set_file_mtime(
            &legacy_transient,
            filetime::FileTime::from_unix_time(60_000, 0),
        )
        .unwrap();
        filetime::set_file_mtime(
            &fresh_legacy,
            filetime::FileTime::from_unix_time(1_999_999, 0),
        )
        .unwrap();
        filetime::set_file_mtime(&unrelated, filetime::FileTime::from_unix_time(40_000, 0))
            .unwrap();

        let removed =
            cleanup_stale_thumbnail_artifacts_with(temp.path(), now, grace, 256, 8).unwrap();

        assert_eq!(removed, vec![legacy_jpeg.clone(), legacy_transient.clone()]);
        assert!(!legacy_jpeg.exists());
        assert!(!legacy_transient.exists());
        assert!(fresh_legacy.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn thumbnail_cleanup_honors_age_order_and_entry_cap() {
        let temp = tempfile::tempdir().unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(2_000_000);
        let grace = Duration::from_secs(24 * 60 * 60);
        let digest = "a".repeat(64);
        let oldest = temp
            .path()
            .join(format!("{}.{}.transient.jpg", digest, "1".repeat(64)));
        let same_time_first =
            temp.path()
                .join(format!("{}.{}.transient.jpg", digest, "2".repeat(64)));
        let same_time_second =
            temp.path()
                .join(format!("{}.{}.transient.jpg", digest, "3".repeat(64)));
        let fresh = temp
            .path()
            .join(format!("{}.{}.transient.jpg", digest, "4".repeat(64)));
        let unrelated = temp.path().join("do-not-delete.txt");
        for path in [
            &oldest,
            &same_time_first,
            &same_time_second,
            &fresh,
            &unrelated,
        ] {
            fs::write(path, b"orphan").unwrap();
        }
        filetime::set_file_mtime(&oldest, filetime::FileTime::from_unix_time(50_000, 0)).unwrap();
        for path in [&same_time_first, &same_time_second, &unrelated] {
            filetime::set_file_mtime(path, filetime::FileTime::from_unix_time(60_000, 0)).unwrap();
        }
        filetime::set_file_mtime(&fresh, filetime::FileTime::from_unix_time(1_999_999, 0)).unwrap();

        let removed =
            cleanup_stale_thumbnail_artifacts_with(temp.path(), now, grace, 2, 8).unwrap();

        assert_eq!(removed, vec![oldest.clone(), same_time_first.clone()]);
        assert!(!oldest.exists());
        assert!(!same_time_first.exists());
        assert!(same_time_second.exists());
        assert!(fresh.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn thumbnail_cleanup_does_not_split_pair_at_entry_cap() {
        let temp = tempfile::tempdir().unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(2_000_000);
        let mut hits = Vec::new();
        for version in 0..9 {
            let mut key = thumbnail_test_key("/photos/capped-autosave.RAF");
            key.source_modified.seconds += version;
            let identity = thumbnail_test_identity(&key);
            let fingerprint = thumbnail_test_fingerprint(&key);
            let identity_for_recheck = identity.clone();
            let hit = publish_thumbnail_cache_with_recheck(
                temp.path(),
                &fingerprint,
                &thumbnail_test_jpeg([version as f32 / 20.0, 0.3, 0.2]),
                move || Some(identity_for_recheck),
            )
            .unwrap();
            let mtime = filetime::FileTime::from_unix_time(50_000 + version as i64, 0);
            filetime::set_file_mtime(hit.manifest_path.as_ref().unwrap(), mtime).unwrap();
            filetime::set_file_mtime(&hit.jpeg_path, mtime).unwrap();
            hits.push(hit);
        }

        let removed = cleanup_stale_thumbnail_artifacts_with(
            temp.path(),
            now,
            Duration::from_secs(24 * 60 * 60),
            1,
            8,
        )
        .unwrap();

        assert!(removed.is_empty());
        assert!(hits[0].manifest_path.as_ref().unwrap().exists());
        assert!(hits[0].jpeg_path.exists());

        let removed = cleanup_stale_thumbnail_artifacts_with(
            temp.path(),
            now,
            Duration::from_secs(24 * 60 * 60),
            2,
            8,
        )
        .unwrap();
        assert_eq!(removed.len(), 2);
        assert!(!hits[0].manifest_path.as_ref().unwrap().exists());
        assert!(!hits[0].jpeg_path.exists());
    }

    #[test]
    fn thumbnail_cleanup_stops_pair_after_manifest_removal_failure() {
        let manifest_path = PathBuf::from("manifest.thumbnail-manifest.json");
        let jpeg_path = PathBuf::from("content.jpg");
        let unit = ThumbnailCleanupUnit {
            modified: UNIX_EPOCH,
            sort_name: "manifest.thumbnail-manifest.json".to_string(),
            paths: vec![manifest_path.clone(), jpeg_path.clone()],
        };
        let mut attempted = Vec::new();

        let removed = remove_thumbnail_cleanup_units_with(vec![unit], 2, |path| {
            attempted.push(path.to_path_buf());
            if path == manifest_path {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected manifest removal failure",
                ))
            } else {
                Ok(())
            }
        });

        assert!(removed.is_empty());
        assert_eq!(attempted, vec![manifest_path]);
    }

    #[test]
    fn thumbnail_publication_rejects_source_change_during_sidecar_recheck() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("changing-during-sidecar.RAF");
        fs::write(&source, b"before").unwrap();
        let initial_time = filetime::FileTime::from_unix_time(2_000_000_000, 123_456_789);
        filetime::set_file_mtime(&source, initial_time).unwrap();
        let adjustments = json!({ "exposure": 0.5 });
        let defaults = thumbnail_test_defaults();
        let profile = thumbnail_test_profile();
        let key = thumbnail_manifest_key(
            source.to_str().unwrap(),
            thumbnail_source_timestamp(&source).unwrap(),
            &adjustments,
            &defaults,
            &profile,
            &ThumbnailLutRequest::NotRequested,
        );
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let changed_time = filetime::FileTime::from_unix_time(2_000_000_001, 987_654_321);
        let source_for_recheck = source.clone();
        let adjustments_for_recheck = adjustments.clone();
        let path_str = source.to_str().unwrap();

        let result = publish_thumbnail_cache_with_recheck(
            temp.path(),
            &fingerprint,
            &thumbnail_test_jpeg([0.1, 0.2, 0.3]),
            || {
                thumbnail_identity_recheck_with(path_str, &defaults, &profile, |_| {
                    fs::write(&source_for_recheck, b"after").unwrap();
                    filetime::set_file_mtime(&source_for_recheck, changed_time).unwrap();
                    adjustments_for_recheck
                })
            },
        );

        assert!(result.is_err());
        assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());
    }

    #[test]
    fn thumbnail_runtime_fallback_is_immediate_but_not_reusable() {
        let temp = tempfile::tempdir().unwrap();
        let mut key = thumbnail_test_key("/photos/image.RAF");
        key.render_profile.dispatch = ThumbnailRenderPath::ObjectGpu;
        let identity = thumbnail_test_identity(&key);
        let mut fallback_fingerprint = thumbnail_test_fingerprint(&key);
        fallback_fingerprint.actual_render_path = ThumbnailRenderPath::ObjectFallback;
        let mut gpu_fingerprint = fallback_fingerprint.clone();
        gpu_fingerprint.actual_render_path = ThumbnailRenderPath::ObjectGpu;
        let fallback_jpeg = thumbnail_test_jpeg([0.2, 0.3, 0.4]);
        let gpu_jpeg_path = temp.path().join(
            thumbnail_jpeg_filename(&gpu_fingerprint, &thumbnail_jpeg_digest(&fallback_jpeg))
                .unwrap(),
        );
        let manifest_path = thumbnail_manifest_path(temp.path(), &identity).unwrap();
        let generation_count = Arc::new(AtomicUsize::new(0));

        for expected_generation_count in 1..=2 {
            let fingerprint_for_generate = fallback_fingerprint.clone();
            let identity_for_recheck = identity.clone();
            let generation_count_for_call = Arc::clone(&generation_count);
            let jpeg_for_generate = fallback_jpeg.clone();
            let resolution = resolve_thumbnail_cache_with(
                temp.path(),
                &identity,
                false,
                move || {
                    generation_count_for_call.fetch_add(1, Ordering::SeqCst);
                    Ok((fingerprint_for_generate, jpeg_for_generate))
                },
                move || Some(identity_for_recheck),
            )
            .unwrap();

            assert_eq!(resolution.manifest_path, None);
            assert_eq!(fs::read(&resolution.jpeg_path).unwrap(), fallback_jpeg);
            assert_ne!(resolution.jpeg_path, gpu_jpeg_path);
            assert!(!manifest_path.exists());
            assert!(!gpu_jpeg_path.exists());
            assert!(lookup_thumbnail_manifest(temp.path(), &identity).is_none());
            assert_eq!(
                generation_count.load(Ordering::SeqCst),
                expected_generation_count
            );
        }
    }

    #[test]
    fn thumbnail_transient_fallback_preserves_existing_gpu_cache() {
        let temp = tempfile::tempdir().unwrap();
        let mut key = thumbnail_test_key("/photos/image.RAF");
        key.render_profile.dispatch = ThumbnailRenderPath::ObjectGpu;
        let identity = thumbnail_test_identity(&key);
        let gpu_fingerprint = thumbnail_test_fingerprint(&key);
        let gpu_jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let identity_for_initial_recheck = identity.clone();
        let existing_hit = publish_thumbnail_cache_with_recheck(
            temp.path(),
            &gpu_fingerprint,
            &gpu_jpeg,
            move || Some(identity_for_initial_recheck),
        )
        .unwrap();
        let manifest_path = existing_hit.manifest_path.clone().unwrap();
        let manifest_bytes = fs::read(&manifest_path).unwrap();

        let mut fallback_fingerprint = gpu_fingerprint;
        fallback_fingerprint.actual_render_path = ThumbnailRenderPath::ObjectFallback;
        let fallback_jpeg = thumbnail_test_jpeg([0.7, 0.4, 0.2]);
        let identity_for_fallback_recheck = identity.clone();
        let fallback = resolve_thumbnail_cache_with(
            temp.path(),
            &identity,
            true,
            move || Ok((fallback_fingerprint, fallback_jpeg.clone())),
            move || Some(identity_for_fallback_recheck),
        )
        .unwrap();

        assert_eq!(fallback.manifest_path, None);
        assert_eq!(
            fs::read(fallback.jpeg_path).unwrap(),
            thumbnail_test_jpeg([0.7, 0.4, 0.2])
        );
        assert_eq!(fs::read(&existing_hit.jpeg_path).unwrap(), gpu_jpeg);
        assert_eq!(fs::read(&manifest_path).unwrap(), manifest_bytes);
        assert_eq!(
            lookup_thumbnail_manifest(temp.path(), &identity),
            Some(existing_hit)
        );
    }

    #[test]
    fn thumbnail_tagging_and_library_share_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let key = thumbnail_test_key("/photos/image.RAF?vc=shared");
        let identity = thumbnail_test_identity(&key);
        let fingerprint = thumbnail_test_fingerprint(&key);
        let jpeg = thumbnail_test_jpeg([0.1, 0.2, 0.3]);
        let generation_count = Arc::new(AtomicUsize::new(0));
        let generation_count_for_library = Arc::clone(&generation_count);
        let fingerprint_for_library = fingerprint.clone();
        let identity_for_recheck = identity.clone();
        let library_hit = resolve_thumbnail_cache_with(
            temp.path(),
            &identity,
            false,
            move || {
                generation_count_for_library.fetch_add(1, Ordering::SeqCst);
                Ok((fingerprint_for_library, jpeg))
            },
            move || Some(identity_for_recheck),
        )
        .unwrap();
        let manifest_path = library_hit.manifest_path.clone().unwrap();
        let jpeg_before = fs::read(&library_hit.jpeg_path).unwrap();
        let manifest_before = fs::read(&manifest_path).unwrap();
        let artifact_count = fs::read_dir(temp.path()).unwrap().count();
        let library = adapt_cached_thumbnail_resolution(
            CachedThumbnailResolution {
                hit: library_hit.clone(),
                rating: 4,
                is_edited: true,
            },
            CachedThumbnailAdapterMode::Library,
        )
        .unwrap();

        let tagging_hit = resolve_thumbnail_cache_with(
            temp.path(),
            &identity,
            false,
            || panic!("tagging must consume the library manifest hit"),
            || panic!("a manifest hit must not publish"),
        )
        .unwrap();
        let tagging = adapt_cached_thumbnail_resolution(
            CachedThumbnailResolution {
                hit: tagging_hit.clone(),
                rating: 4,
                is_edited: true,
            },
            CachedThumbnailAdapterMode::DecodedImage,
        )
        .unwrap();

        assert_eq!(generation_count.load(Ordering::SeqCst), 1);
        match library {
            CachedThumbnailAdapterOutput::Library(path, rating, is_edited) => {
                assert_eq!(path, library_hit.jpeg_path.to_string_lossy());
                assert_eq!((rating, is_edited), (4, true));
            }
            CachedThumbnailAdapterOutput::DecodedImage(_) => panic!("expected library output"),
        }
        match tagging {
            CachedThumbnailAdapterOutput::DecodedImage(image) => {
                assert_eq!(image.dimensions(), (8, 6));
            }
            CachedThumbnailAdapterOutput::Library(_, _, _) => panic!("expected decoded image"),
        }
        assert_eq!(library_hit, tagging_hit);
        assert_eq!(fs::read(&library_hit.jpeg_path).unwrap(), jpeg_before);
        assert_eq!(fs::read(&manifest_path).unwrap(), manifest_before);
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), artifact_count);
    }

    #[tokio::test]
    async fn non_raw_metadata_bypasses_raw_gate_and_runs_inline() {
        let metadata = ImageMetadata {
            version: 7,
            rating: 4,
            adjustments: json!({ "preserve": true }),
            tags: Some(vec!["keep-me".into()]),
            exif: Some(HashMap::from([("Model".into(), "GFX100RF".into())])),
        };
        let expected = serde_json::to_value(&metadata).unwrap();
        let semaphore = Arc::new(Semaphore::new(2));
        semaphore.close();
        let calling_thread = std::thread::current().id();
        let (thread_sender, thread_receiver) = std::sync::mpsc::channel();

        let result = metadata_result_for_path_blocking_with(
            metadata,
            PathBuf::from("image.jpg"),
            semaphore,
            move |metadata, source_path| {
                assert_eq!(source_path, Path::new("image.jpg"));
                thread_sender.send(std::thread::current().id()).unwrap();
                LoadMetadataResult {
                    metadata,
                    camera_defaults: CameraDefaults {
                        canvas_width: Some(321),
                        ..CameraDefaults::default()
                    },
                }
            },
        )
        .await;

        assert_eq!(serde_json::to_value(result.metadata).unwrap(), expected);
        assert_eq!(result.camera_defaults.canvas_width, Some(321));
        assert_eq!(thread_receiver.try_recv().unwrap(), calling_thread);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn raw_metadata_extraction_is_bounded_and_preserves_metadata() {
        let semaphore = Arc::new(Semaphore::new(2));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let mut expected = Vec::new();
        let mut tasks = Vec::new();

        for rating in 0_u8..6 {
            let metadata = ImageMetadata {
                version: 7,
                rating,
                adjustments: json!({ "slot": rating }),
                tags: Some(vec![format!("tag-{rating}")]),
                exif: Some(HashMap::from([("Model".into(), "GFX100RF".into())])),
            };
            expected.push(serde_json::to_value(&metadata).unwrap());

            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            let semaphore = Arc::clone(&semaphore);
            tasks.push(tokio::spawn(metadata_result_for_path_blocking_with(
                metadata,
                PathBuf::from(format!("missing-{rating}.RAF")),
                semaphore,
                move |metadata, _| {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(current, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(40));
                    active.fetch_sub(1, Ordering::SeqCst);
                    LoadMetadataResult {
                        metadata,
                        camera_defaults: CameraDefaults::default(),
                    }
                },
            )));
        }

        let mut actual = Vec::new();
        for task in tasks {
            actual.push(serde_json::to_value(task.await.unwrap().metadata).unwrap());
        }
        actual.sort_by_key(|value| value["rating"].as_u64());

        assert_eq!(actual, expected);
        let observed_max = max_active.load(Ordering::SeqCst);
        assert!(observed_max >= 1);
        assert!(observed_max <= 2);
    }

    #[tokio::test]
    async fn raw_metadata_join_failure_preserves_metadata_and_empty_defaults() {
        let metadata = ImageMetadata {
            version: 7,
            rating: 4,
            adjustments: json!({ "preserve": true }),
            tags: Some(vec!["keep-me".into()]),
            exif: Some(HashMap::from([("Model".into(), "GFX100RF".into())])),
        };
        let expected = serde_json::to_value(&metadata).unwrap();

        let result = metadata_result_for_path_blocking_with(
            metadata,
            PathBuf::from("missing.RAF"),
            Arc::new(Semaphore::new(2)),
            |_, _| panic!("synthetic extractor panic"),
        )
        .await;

        assert_eq!(serde_json::to_value(result.metadata).unwrap(), expected);
        assert_eq!(result.camera_defaults, CameraDefaults::default());
    }

    #[tokio::test]
    async fn raw_metadata_acquire_failure_preserves_metadata_and_empty_defaults() {
        let metadata = ImageMetadata {
            version: 7,
            rating: 4,
            adjustments: Value::Null,
            tags: Some(vec!["keep-me".into()]),
            exif: Some(HashMap::from([("Model".into(), "GFX100RF".into())])),
        };
        let expected = serde_json::to_value(&metadata).unwrap();
        let semaphore = Arc::new(Semaphore::new(2));
        semaphore.close();

        let result = metadata_result_for_path_blocking_with(
            metadata,
            PathBuf::from("missing.RAF"),
            semaphore,
            |_, _| panic!("a closed semaphore must not run the extractor"),
        )
        .await;

        assert_eq!(serde_json::to_value(result.metadata).unwrap(), expected);
        assert_eq!(result.camera_defaults, CameraDefaults::default());
    }
}
