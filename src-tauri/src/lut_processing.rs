#[cfg(target_os = "android")]
use crate::android_integration::{
    get_android_cached_lut_path, is_android_content_uri, read_android_content_uri_bounded,
    resolve_android_content_uri_name,
};
use anyhow::anyhow;
use image::{DynamicImage, GenericImageView, ImageReader, Limits, Rgb, Rgb32FImage};
use serde::{Deserialize, Serialize};
use std::fs::{File, copy, create_dir_all, read_dir};
use std::io::{BufRead, Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose};
use mozjpeg_rs::{Encoder, Preset};
use tauri::{AppHandle, Manager, State};

use crate::AppState;
use crate::android_integration::read_to_limit_plus_one;
use crate::image_processing::{
    RenderRequest, get_all_adjustments_from_json, mark_baseline_exposure,
    process_and_get_dynamic_image, resolve_render_options_from_handle,
};

// LUT files are untrusted input: cap the bytes read into memory, the table
// edge (and so the parsed table size) and the size a HALD image may decode to.
const MAX_LUT_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_LUT_EDGE: u32 = 65;
const LUT_CHANNELS: usize = 3;
const MAX_LUT_ENTRIES: usize =
    (MAX_LUT_EDGE as usize) * (MAX_LUT_EDGE as usize) * (MAX_LUT_EDGE as usize);
const MAX_LUT_VALUES: usize = MAX_LUT_ENTRIES * LUT_CHANNELS;
// floor(sqrt(65^3)); valid square HALD images top out at 512x512 (edge 64).
const MAX_HALD_IMAGE_DIMENSION: u32 = 524;

#[derive(Debug, Clone)]
pub struct Lut {
    pub size: u32,
    pub data: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LutEntry {
    pub name: String,
    pub path: String,
    pub is_built_in: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LutPreviewRequest {
    pub path: String,
    pub is_built_in: bool,
}

#[derive(Serialize)]
pub struct LutParseResult {
    pub size: u32,
}

#[derive(Serialize)]
pub struct LutPreview {
    pub path: String,
    pub thumb: Option<String>,
}

fn strip_verbatim(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
}

fn film_luts_dir(app_handle: &AppHandle) -> Option<PathBuf> {
    app_handle
        .path()
        .resolve("resources/film_luts", tauri::path::BaseDirectory::Resource)
        .ok()
        .map(|p| strip_verbatim(&p))
}

pub fn get_luts_dir(app_data_dir: &Path) -> anyhow::Result<PathBuf> {
    let luts_dir = app_data_dir.join("luts");
    if !luts_dir.exists() {
        create_dir_all(&luts_dir)?;
    }
    Ok(luts_dir)
}

pub fn list_luts_in_dir(dir: &Path, is_built_in: bool) -> anyhow::Result<Vec<LutEntry>> {
    let mut entries: Vec<LutEntry> = Vec::new();
    if !dir.exists() {
        return Ok(entries);
    }
    for entry in read_dir(dir)? {
        let path = entry?.path();
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        let is_supported = matches!(
            extension.as_str(),
            "cube" | "3dl" | "png" | "jpg" | "jpeg" | "tiff"
        );

        if is_supported {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("LUT")
                .to_string();

            entries.push(LutEntry {
                name,
                path: strip_verbatim(&path).to_string_lossy().into_owned(),
                is_built_in,
            });
        }
    }
    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

pub fn unique_destination(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{}.{}", stem, extension));
    let mut suffix = 1;
    while candidate.exists() && suffix < 1000 {
        candidate = dir.join(format!("{} ({}).{}", stem, suffix, extension));
        suffix += 1;
    }
    candidate
}

pub fn import_luts_to_dir(dir: &Path, source_paths: &[String]) -> anyhow::Result<Vec<LutEntry>> {
    for source in source_paths {
        if let Err(error) = parse_lut_file(source) {
            log::warn!("Skipping invalid LUT '{}': {}", source, error);
            continue;
        }

        #[cfg(target_os = "android")]
        if is_android_content_uri(source) {
            if let Err(error) = import_android_lut(source) {
                log::error!("Failed to import LUT from '{}': {}", source, error);
            }
            continue;
        }

        let source_path = Path::new(source);
        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("LUT");
        let extension = source_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("cube")
            .to_lowercase();
        let destination = unique_destination(dir, stem, &extension);
        if let Err(error) = copy(source_path, &destination) {
            log::error!("Failed to copy LUT '{}': {}", source, error);
        }
    }
    list_luts_in_dir(dir, false)
}

#[cfg(target_os = "android")]
fn import_android_lut(source: &str) -> anyhow::Result<()> {
    let resolved_name = resolve_android_content_uri_name(source)
        .map_err(|e| anyhow!("Failed to resolve content URI: {}", e))?;
    let stem = Path::new(&resolved_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("LUT")
        .to_string();
    let extension = Path::new(&resolved_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("cube")
        .to_lowercase();
    let bytes = read_android_content_uri_bounded(source, MAX_LUT_FILE_BYTES)
        .map_err(|e| anyhow!("Failed to read content URI: {}", e))?;
    validate_lut_file_size(bytes.len() as u64)?;

    let cache_path = get_android_cached_lut_path(source, &extension)?;
    let cache_dir = cache_path
        .parent()
        .ok_or_else(|| anyhow!("Invalid cache path"))?
        .to_path_buf();
    let destination = unique_destination(&cache_dir, &stem, &extension);
    std::fs::write(&destination, &bytes)?;
    Ok(())
}

fn validate_lut_file_size(byte_len: u64) -> anyhow::Result<()> {
    if byte_len > MAX_LUT_FILE_BYTES as u64 {
        return Err(anyhow!(
            "LUT file is {} bytes; the maximum allowed size is 32 MiB ({} bytes)",
            byte_len,
            MAX_LUT_FILE_BYTES
        ));
    }
    Ok(())
}

/// Number of `f32` values in a LUT with this edge. Edges outside
/// `1..=MAX_LUT_EDGE` are rejected before any size arithmetic happens.
fn checked_lut_value_count(edge: u32, format: &str) -> anyhow::Result<usize> {
    if edge == 0 {
        return Err(anyhow!("{} LUT edge must be at least 1", format));
    }
    if edge > MAX_LUT_EDGE {
        return Err(anyhow!(
            "{} LUT edge {} is unsupported; the maximum supported edge is {}",
            format,
            edge,
            MAX_LUT_EDGE
        ));
    }

    let edge = usize::try_from(edge)
        .map_err(|_| anyhow!("{} LUT edge cannot be represented on this platform", format))?;
    edge.checked_mul(edge)
        .and_then(|count| count.checked_mul(edge))
        .and_then(|count| count.checked_mul(LUT_CHANNELS))
        .ok_or_else(|| anyhow!("{} LUT value count overflowed", format))
}

/// Edge of the supported LUT that has exactly `entries` RGB entries, if any.
fn supported_lut_edge(entries: usize) -> Option<u32> {
    (1..=MAX_LUT_EDGE).find(|&edge| {
        let edge = edge as usize;
        edge * edge * edge == entries
    })
}

/// Makes room for one more RGB triplet without letting the table grow past
/// `maximum_values`, using fallible allocation.
fn reserve_lut_triplet(
    data: &mut Vec<f32>,
    maximum_values: usize,
    format: &str,
) -> anyhow::Result<()> {
    let required = data
        .len()
        .checked_add(LUT_CHANNELS)
        .ok_or_else(|| anyhow!("{} LUT value count overflowed", format))?;
    if required > maximum_values {
        return Err(anyhow!("{} LUT contains more data than allowed", format));
    }

    if required > data.capacity() {
        let target_capacity = data
            .capacity()
            .checked_mul(2)
            .unwrap_or(maximum_values)
            .max(required)
            .min(maximum_values);
        data.try_reserve_exact(target_capacity - data.len())
            .map_err(|error| anyhow!("Failed to allocate {} LUT table: {}", format, error))?;
    }
    Ok(())
}

fn parse_cube(reader: impl BufRead) -> anyhow::Result<Lut> {
    // (edge, number of f32 values) from the LUT_3D_SIZE line.
    let mut declared: Option<(u32, usize)> = None;
    let mut data: Vec<f32> = Vec::new();
    let mut line_num = 0;

    for line in reader.lines() {
        line_num += 1;
        let line = line?;
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Walk the tokens lazily so a huge line cannot be expanded into an
        // even larger token list.
        let mut parts = trimmed.split_whitespace();
        let Some(first) = parts.next() else {
            continue;
        };

        if first.eq_ignore_ascii_case("TITLE")
            || first.eq_ignore_ascii_case("DOMAIN_MIN")
            || first.eq_ignore_ascii_case("DOMAIN_MAX")
        {
            continue;
        }

        if first.eq_ignore_ascii_case("LUT_3D_SIZE") {
            if declared.is_some() {
                return Err(anyhow!(
                    "LUT_3D_SIZE may only appear once in a .cube file (line {})",
                    line_num
                ));
            }
            let size_token = parts
                .next()
                .ok_or_else(|| anyhow!("Malformed LUT_3D_SIZE on line {}: '{}'", line_num, line))?;
            let parsed_size = size_token.parse().map_err(|e| {
                anyhow!(
                    "Failed to parse LUT_3D_SIZE on line {}: '{}'. Error: {}",
                    line_num,
                    line,
                    e
                )
            })?;
            let value_count = checked_lut_value_count(parsed_size, ".cube")?;
            declared = Some((parsed_size, value_count));
            continue;
        }

        if let Some((lut_size, expected_len)) = declared {
            let green_token = parts.next().ok_or_else(|| {
                anyhow!(
                    "Invalid data line on line {}: '{}'. Expected 3 float values",
                    line_num,
                    line
                )
            })?;
            let blue_token = parts.next().ok_or_else(|| {
                anyhow!(
                    "Invalid data line on line {}: '{}'. Expected 3 float values",
                    line_num,
                    line
                )
            })?;
            if let Some(extra) = parts.next()
                && !extra.starts_with('#')
            {
                return Err(anyhow!(
                    "Invalid data line on line {}: '{}'. Found more than 3 values",
                    line_num,
                    line
                ));
            }
            if data.len() == expected_len {
                return Err(anyhow!(
                    ".cube LUT contains more data than declared for edge {}",
                    lut_size
                ));
            }
            reserve_lut_triplet(&mut data, expected_len, ".cube")?;
            let r: f32 = first.parse().map_err(|e| {
                anyhow!(
                    "Failed to parse R value on line {}: '{}'. Error: {}",
                    line_num,
                    line,
                    e
                )
            })?;
            let g: f32 = green_token.parse().map_err(|e| {
                anyhow!(
                    "Failed to parse G value on line {}: '{}'. Error: {}",
                    line_num,
                    line,
                    e
                )
            })?;
            let b: f32 = blue_token.parse().map_err(|e| {
                anyhow!(
                    "Failed to parse B value on line {}: '{}'. Error: {}",
                    line_num,
                    line,
                    e
                )
            })?;
            data.push(r);
            data.push(g);
            data.push(b);
        }
    }

    let (lut_size, expected_len) =
        declared.ok_or_else(|| anyhow!("LUT_3D_SIZE not found in .cube file"))?;
    if data.len() != expected_len {
        return Err(anyhow!(
            "LUT data size mismatch. Expected {} float values (for size {}), but found {}. The file may be corrupt or incomplete.",
            expected_len,
            lut_size,
            data.len()
        ));
    }

    Ok(Lut {
        size: lut_size,
        data,
    })
}

fn parse_3dl(reader: impl BufRead) -> anyhow::Result<Lut> {
    let mut data: Vec<f32> = Vec::new();

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Only lines of exactly three values are table entries.
        let mut parts = trimmed.split_whitespace();
        let (Some(red_token), Some(green_token), Some(blue_token), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if data.len() == MAX_LUT_VALUES {
            return Err(anyhow!(
                "3DL LUT has more than {} entries; the maximum supported edge is {}",
                MAX_LUT_ENTRIES,
                MAX_LUT_EDGE
            ));
        }
        reserve_lut_triplet(&mut data, MAX_LUT_VALUES, "3DL")?;
        let r: f32 = red_token.parse()?;
        let g: f32 = green_token.parse()?;
        let b: f32 = blue_token.parse()?;
        data.push(r);
        data.push(g);
        data.push(b);
    }

    let total_values = data.len();
    if total_values == 0 {
        return Err(anyhow!("No data found in 3DL file"));
    }
    let num_entries = total_values / 3;
    let size = supported_lut_edge(num_entries).ok_or_else(|| {
        anyhow!(
            "Invalid 3DL LUT data size: the number of entries ({}) is not a perfect cube.",
            num_entries
        )
    })?;

    Ok(Lut { size, data })
}

fn parse_hald(image: DynamicImage) -> anyhow::Result<Lut> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err(anyhow!(
            "HALD image dimensions must be non-zero, found {}x{}",
            width,
            height
        ));
    }
    if width != height {
        return Err(anyhow!(
            "HALD image must be square, but dimensions are {}x{}",
            width,
            height
        ));
    }

    // Cannot overflow: both factors fit in 32 bits.
    let total_pixels = u64::from(width) * u64::from(height);
    if total_pixels > MAX_LUT_ENTRIES as u64 {
        return Err(anyhow!(
            "HALD image has {} pixels; the maximum supported LUT edge is {} ({} pixels)",
            total_pixels,
            MAX_LUT_EDGE,
            MAX_LUT_ENTRIES
        ));
    }
    let size = usize::try_from(total_pixels)
        .ok()
        .and_then(supported_lut_edge)
        .ok_or_else(|| {
            anyhow!(
                "Invalid HALD image dimensions: total pixels ({}) is not a perfect cube.",
                total_pixels
            )
        })?;
    let value_count = checked_lut_value_count(size, "HALD")?;

    let rgb_image = image.to_rgb8();
    let mut data = Vec::new();
    data.try_reserve_exact(value_count)
        .map_err(|error| anyhow!("Failed to allocate HALD LUT table: {}", error))?;

    for pixel in rgb_image.pixels() {
        data.push(pixel[0] as f32 / 255.0);
        data.push(pixel[1] as f32 / 255.0);
        data.push(pixel[2] as f32 / 255.0);
    }

    Ok(Lut { size, data })
}

fn lut_extension(path_str: &str) -> String {
    #[cfg(target_os = "android")]
    if is_android_content_uri(path_str) {
        let resolved_name =
            resolve_android_content_uri_name(path_str).unwrap_or_else(|_| path_str.to_string());
        return Path::new(&resolved_name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("cube")
            .to_lowercase();
    }

    Path::new(path_str)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn validate_lut_extension(extension: &str) -> anyhow::Result<()> {
    match extension {
        "cube" | "3dl" | "png" | "jpg" | "jpeg" | "tiff" => Ok(()),
        _ => Err(anyhow!("Unsupported LUT file format: {}", extension)),
    }
}

fn parse_lut_bytes(extension: &str, bytes: &[u8]) -> anyhow::Result<Lut> {
    match extension {
        "cube" => parse_cube(bytes),
        "3dl" => parse_3dl(bytes),
        "png" | "jpg" | "jpeg" | "tiff" => {
            let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
            let mut limits = Limits::default();
            limits.max_image_width = Some(MAX_HALD_IMAGE_DIMENSION);
            limits.max_image_height = Some(MAX_HALD_IMAGE_DIMENSION);
            limits.max_alloc = Some(MAX_LUT_FILE_BYTES as u64);
            reader.limits(limits);
            let image = reader.decode().map_err(|error| {
                anyhow!(
                    "Failed to decode HALD LUT; the maximum supported HALD dimension is {}x{} and decoder allocation is limited to 32 MiB: {}",
                    MAX_HALD_IMAGE_DIMENSION,
                    MAX_HALD_IMAGE_DIMENSION,
                    error
                )
            })?;
            parse_hald(image)
        }
        _ => Err(anyhow!("Unsupported LUT file format: {}", extension)),
    }
}

fn read_lut_reader_bounded(reader: impl Read, initial_capacity: usize) -> anyhow::Result<Vec<u8>> {
    let bytes = read_to_limit_plus_one(reader, MAX_LUT_FILE_BYTES, initial_capacity)?;
    validate_lut_file_size(bytes.len() as u64)?;
    Ok(bytes)
}

fn read_lut_file_bounded(path: &str) -> anyhow::Result<Vec<u8>> {
    let file = File::open(path)?;
    let metadata_len = file.metadata()?.len();
    // Fail fast on files that are already too large; the bounded read below
    // still catches files that grow, or report no size, after this check.
    validate_lut_file_size(metadata_len)?;

    let initial_capacity = usize::try_from(metadata_len)
        .map_err(|_| anyhow!("LUT file size cannot be represented on this platform"))?;
    read_lut_reader_bounded(file, initial_capacity)
}

fn read_lut_bytes_bounded(path_str: &str) -> anyhow::Result<Vec<u8>> {
    #[cfg(target_os = "android")]
    if is_android_content_uri(path_str) {
        return read_android_content_uri_bounded(path_str, MAX_LUT_FILE_BYTES)
            .map_err(|e| anyhow!("{}", e));
    }

    read_lut_file_bounded(path_str)
}

/// Validates `path_str`, reads it once through `read_bytes` and parses exactly
/// those bytes, so the size check and the parse always see the same data.
fn parse_lut_file_with<F>(path_str: &str, read_bytes: F) -> anyhow::Result<Lut>
where
    F: FnOnce(&str) -> anyhow::Result<Vec<u8>>,
{
    let normalized_path_str = path_str.strip_prefix(r"\\?\").unwrap_or(path_str);

    if normalized_path_str.starts_with(r"\\") || normalized_path_str.starts_with("//") {
        return Err(anyhow!("Network paths (UNC) are not allowed for LUTs"));
    }

    let path = std::path::Path::new(path_str);
    if path
        .components()
        .any(|component| component == std::path::Component::ParentDir)
    {
        return Err(anyhow!("Directory traversal (..) is not allowed"));
    }

    if let Some(std::path::Component::Prefix(prefix)) = path.components().next() {
        match prefix.kind() {
            std::path::Prefix::UNC(_, _)
            | std::path::Prefix::VerbatimUNC(_, _)
            | std::path::Prefix::DeviceNS(_) => {
                return Err(anyhow!("Device/UNC prefix paths are not allowed"));
            }
            _ => {}
        }
    }

    let extension = lut_extension(path_str);
    validate_lut_extension(&extension)?;
    let bytes = read_bytes(path_str)?;
    validate_lut_file_size(bytes.len() as u64)?;
    parse_lut_bytes(&extension, &bytes)
}

pub fn parse_lut_file(path_str: &str) -> anyhow::Result<Lut> {
    parse_lut_file_with(path_str, read_lut_bytes_bounded)
}

pub fn generate_identity_lut_image(size: u32) -> DynamicImage {
    let width = size;
    let height = size * size;
    let mut img = Rgb32FImage::new(width, height);

    for z in 0..size {
        for y in 0..size {
            for x in 0..size {
                let r = x as f32 / (size - 1) as f32;
                let g = y as f32 / (size - 1) as f32;
                let b = z as f32 / (size - 1) as f32;

                img.put_pixel(x, z * size + y, Rgb([r, g, b]));
            }
        }
    }

    DynamicImage::ImageRgb32F(img)
}

pub fn convert_image_to_cube_lut(image: &DynamicImage, size: u32) -> Result<Vec<u8>, String> {
    let f32_image = image.to_rgb32f();
    let mut out = String::new();

    out.push_str(&format!("LUT_3D_SIZE {}\n", size));
    out.push_str("DOMAIN_MIN 0.0 0.0 0.0\n");
    out.push_str("DOMAIN_MAX 1.0 1.0 1.0\n");

    for z in 0..size {
        for y in 0..size {
            for x in 0..size {
                let pixel = f32_image.get_pixel(x, z * size + y);
                out.push_str(&format!(
                    "{:.6} {:.6} {:.6}\n",
                    pixel[0].clamp(0.0, 1.0),
                    pixel[1].clamp(0.0, 1.0),
                    pixel[2].clamp(0.0, 1.0)
                ));
            }
        }
    }

    Ok(out.into_bytes())
}

pub fn get_or_load_lut(state: &State<AppState>, path: &str) -> Result<Arc<Lut>, String> {
    let mut cache = state.lut_cache.lock().unwrap();
    if let Some(lut) = cache.get(path) {
        return Ok(lut.clone());
    }

    let lut = parse_lut_file(path).map_err(|e| e.to_string())?;
    let arc_lut = Arc::new(lut);
    cache.insert(path.to_string(), arc_lut.clone());
    Ok(arc_lut)
}

#[tauri::command]
pub fn list_luts(app_handle: AppHandle) -> Result<Vec<LutEntry>, String> {
    let mut all_luts = Vec::new();

    if let Some(resource_path) = film_luts_dir(&app_handle)
        && let Ok(built_in) = list_luts_in_dir(&resource_path, true)
    {
        all_luts.extend(built_in);
    }

    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let luts_dir = get_luts_dir(&data_dir).map_err(|e| e.to_string())?;

    #[cfg(target_os = "android")]
    {
        if let Ok(user_luts) = list_luts_in_dir(&luts_dir, false) {
            all_luts.extend(user_luts);
        }
        if let Ok(cached) = list_luts_in_cache() {
            all_luts.extend(cached);
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        if let Ok(user_luts) = list_luts_in_dir(&luts_dir, false) {
            all_luts.extend(user_luts);
        }
    }

    Ok(all_luts)
}

#[cfg(target_os = "android")]
fn get_lut_cache_dir() -> anyhow::Result<PathBuf> {
    let cache_path = get_android_cached_lut_path("_", "tmp")?;
    cache_path
        .parent()
        .ok_or_else(|| anyhow!("Invalid cache path"))
        .map(|p| p.to_path_buf())
}

#[cfg(target_os = "android")]
fn list_luts_in_cache() -> anyhow::Result<Vec<LutEntry>> {
    let cache_dir = get_lut_cache_dir()?;

    if !cache_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<LutEntry> = Vec::new();
    for entry in read_dir(&cache_dir)? {
        let path = entry?.path();
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        let is_supported = matches!(
            extension.as_str(),
            "cube" | "3dl" | "png" | "jpg" | "jpeg" | "tiff"
        );

        if is_supported {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("LUT")
                .to_string();
            entries.push(LutEntry {
                name,
                path: strip_verbatim(&path).to_string_lossy().into_owned(),
                is_built_in: false,
            });
        }
    }
    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

#[tauri::command]
pub fn import_luts(
    app_handle: AppHandle,
    source_paths: Vec<String>,
) -> Result<Vec<LutEntry>, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let luts_dir = get_luts_dir(&data_dir).map_err(|e| e.to_string())?;
    import_luts_to_dir(&luts_dir, &source_paths).map_err(|e| e.to_string())?;

    list_luts(app_handle)
}

#[tauri::command]
pub fn remove_lut(app_handle: AppHandle, path: String) -> Result<Vec<LutEntry>, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let luts_dir = strip_verbatim(&get_luts_dir(&data_dir).map_err(|e| e.to_string())?);
    let target_path = strip_verbatim(Path::new(&path));

    if let Some(resource_path) = film_luts_dir(&app_handle)
        && target_path.starts_with(&resource_path)
    {
        return Err("Cannot delete built-in film emulations".to_string());
    }

    #[cfg(target_os = "android")]
    {
        let cache_dir = strip_verbatim(&get_lut_cache_dir().map_err(|e| e.to_string())?);
        if !target_path.starts_with(&luts_dir) && !target_path.starts_with(&cache_dir) {
            return Err(
                "Access denied: Cannot remove files outside the user LUT directory".to_string(),
            );
        }
    }
    #[cfg(not(target_os = "android"))]
    if !target_path.starts_with(&luts_dir) {
        return Err(
            "Access denied: Cannot remove files outside the user LUT directory".to_string(),
        );
    }

    if target_path.exists() {
        std::fs::remove_file(&target_path).map_err(|e| e.to_string())?;
    } else {
        return Err("LUT file not found".to_string());
    }

    list_luts(app_handle)
}

fn render_lut_swatch(
    context: &crate::image_processing::GpuContext,
    state: &State<AppState>,
    source: &crate::render_source::RenderSource,
    adjustments: crate::image_processing::AllAdjustments,
    lut_path: &str,
) -> Option<String> {
    let lut = get_or_load_lut(state, lut_path).ok()?;
    let processed = process_and_get_dynamic_image(
        context,
        state,
        source,
        RenderRequest {
            adjustments,
            mask_bitmaps: &[],
            mask_cache_key: None,
            lut: Some(lut),
            roi: None,
            hsl_probe: false,
            motion_blur: Default::default(),
        },
        "generate_lut_previews",
    )
    .ok()?;

    let rgb = processed.to_rgb8();
    let (width, height) = rgb.dimensions();
    let bytes = Encoder::new(Preset::BaselineFastest)
        .quality(80)
        .encode_rgb(&rgb.into_vec(), width, height)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(&bytes)
    ))
}

#[tauri::command]
pub async fn generate_lut_previews(
    luts: Vec<LutPreviewRequest>,
    size: u32,
    app_handle: AppHandle,
) -> Result<Vec<LutPreview>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let context = crate::image_processing::get_or_init_gpu_context(&state, &app_handle)?;
        let loaded_image = state
            .original_image
            .lock()
            .unwrap()
            .clone()
            .ok_or("No original image loaded for LUT previews")?;
        let is_raw = loaded_image.is_raw;

        let base_json = serde_json::json!({});
        let preview =
            crate::prepare_preview_source(&state, &context, &loaded_image, &base_json, size)?;
        let source = preview.render_source(&base_json);

        let render = resolve_render_options_from_handle(&app_handle, is_raw);

        let previews = luts
            .into_iter()
            .map(|request| {
                let mut swatch_lut_json = serde_json::json!({
                    "lutPath": "preview",
                    "lutIntensity": 100,
                    "lutIsSceneReferred": request.is_built_in,
                    "sectionVisibility": { "effects": true }
                });
                mark_baseline_exposure(&mut swatch_lut_json);
                let swatch_adjustments = get_all_adjustments_from_json(
                    &swatch_lut_json,
                    is_raw,
                    loaded_image.as_shot,
                    render,
                );

                let thumb =
                    render_lut_swatch(&context, &state, &source, swatch_adjustments, &request.path);
                LutPreview {
                    path: request.path,
                    thumb,
                }
            })
            .collect();

        Ok(previews)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn load_and_parse_lut(path: String, state: State<AppState>) -> Result<LutParseResult, String> {
    let lut = parse_lut_file(&path).map_err(|e| e.to_string())?;
    let lut_size = lut.size;

    let mut cache = state.lut_cache.lock().unwrap();
    cache.insert(path, Arc::new(lut));

    Ok(LutParseResult { size: lut_size })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io;
    use std::sync::{Mutex, MutexGuard};

    const EXPECTED_MAX_LUT_FILE_BYTES: usize = 32 * 1024 * 1024;
    const EXPECTED_MAX_LUT_EDGE: u32 = 65;
    // Serializes the tests that buffer a full 32 MiB so they do not all hold
    // that memory at the same time.
    static LARGE_READER_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn large_reader_test_guard() -> MutexGuard<'static, ()> {
        LARGE_READER_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct SyntheticReader {
        remaining: usize,
        bytes_read: usize,
        largest_request: usize,
    }

    impl SyntheticReader {
        fn new(byte_len: usize) -> Self {
            Self {
                remaining: byte_len,
                bytes_read: 0,
                largest_request: 0,
            }
        }
    }

    impl Read for SyntheticReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.largest_request = self.largest_request.max(buffer.len());
            let read_len = self.remaining.min(buffer.len());
            buffer[..read_len].fill(b'\n');
            self.remaining -= read_len;
            self.bytes_read += read_len;
            Ok(read_len)
        }
    }

    fn constant_lut_rows(edge: u32, include_cube_header: bool) -> Vec<u8> {
        let entries = usize::try_from(edge).unwrap().pow(3);
        let mut bytes = if include_cube_header {
            format!("LUT_3D_SIZE {edge}\n").into_bytes()
        } else {
            Vec::new()
        };
        bytes.reserve(entries * 6);
        for _ in 0..entries {
            bytes.extend_from_slice(b"0 0 0\n");
        }
        bytes
    }

    fn cube_declaration_error(declared_size: &str) -> String {
        let bytes = format!("LUT_3D_SIZE {declared_size}\n");
        std::panic::catch_unwind(|| parse_cube(bytes.as_bytes()))
            .expect("invalid LUT dimensions must return an error instead of panicking")
            .unwrap_err()
            .to_string()
    }

    fn test_cube(last_blue: f32) -> Vec<u8> {
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
        .into_bytes()
    }

    fn encoded_test_image(width: u32, height: u32, format: image::ImageFormat) -> Vec<u8> {
        let image = DynamicImage::new_rgb8(width, height);
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, format).unwrap();
        encoded.into_inner()
    }

    fn create_sparse_file(path: &Path, byte_len: usize) {
        let file = fs::File::create(path).unwrap();
        file.set_len(byte_len as u64).unwrap();
    }

    #[test]
    fn parse_lut_file_parses_the_bytes_from_its_single_read() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("mutable.cube");
        let first_bytes = test_cube(1.0);
        let replacement_bytes = test_cube(0.5);
        fs::write(&path, &first_bytes).unwrap();

        let lut = parse_lut_file_with(path.to_str().unwrap(), |path| {
            let bytes = read_lut_bytes_bounded(path)?;
            fs::write(path, &replacement_bytes)?;
            Ok(bytes)
        })
        .unwrap();

        assert_eq!(lut.data.last().copied(), Some(1.0));
        assert_eq!(fs::read(path).unwrap(), replacement_bytes);
    }

    #[test]
    fn parse_lut_file_rejects_injected_bytes_above_limit() {
        let _large_test_guard = large_reader_test_guard();
        let bytes = read_to_limit_plus_one(
            SyntheticReader::new(EXPECTED_MAX_LUT_FILE_BYTES + 1),
            EXPECTED_MAX_LUT_FILE_BYTES,
            0,
        )
        .unwrap();

        let error = parse_lut_file_with("oversized.cube", |_| Ok(bytes)).unwrap_err();

        assert!(
            error.to_string().contains("32 MiB"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn parse_lut_file_rejects_oversized_sparse_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("oversized.cube");
        create_sparse_file(&path, EXPECTED_MAX_LUT_FILE_BYTES + 1);

        let error = parse_lut_file(path.to_str().unwrap()).unwrap_err();

        assert!(
            error.to_string().contains("32 MiB"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn bounded_lut_reader_accepts_exact_file_limit() {
        let _large_test_guard = large_reader_test_guard();
        let mut reader = SyntheticReader::new(EXPECTED_MAX_LUT_FILE_BYTES);

        let bytes = read_lut_reader_bounded(&mut reader, 0).unwrap();

        assert_eq!(bytes.len(), EXPECTED_MAX_LUT_FILE_BYTES);
        assert_eq!(reader.bytes_read, EXPECTED_MAX_LUT_FILE_BYTES);
        assert!(reader.largest_request <= 8192);
    }

    #[test]
    fn bounded_lut_reader_rejects_limit_plus_one_after_metadata_growth() {
        let _large_test_guard = large_reader_test_guard();
        let mut reader = SyntheticReader::new(EXPECTED_MAX_LUT_FILE_BYTES + 1);

        let error = read_lut_reader_bounded(&mut reader, 1).unwrap_err();

        assert!(
            error.to_string().contains("32 MiB"),
            "unexpected error: {error:#}"
        );
        assert_eq!(reader.bytes_read, EXPECTED_MAX_LUT_FILE_BYTES + 1);
        assert!(reader.largest_request <= 8192);
    }

    #[test]
    fn parse_lut_file_rejects_unsupported_extension_before_reading() {
        let error = parse_lut_file_with("notes.txt", |_| {
            panic!("a file with an unsupported extension must not be read")
        })
        .unwrap_err();

        assert!(
            error.to_string().contains("Unsupported LUT file format"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn parse_lut_file_rejects_traversal_and_network_paths_before_reading() {
        let never_read =
            |_: &str| -> anyhow::Result<Vec<u8>> { panic!("a rejected LUT path must not be read") };

        let traversal = parse_lut_file_with("luts/../secret.cube", never_read).unwrap_err();
        let network = parse_lut_file_with("//server/share/look.cube", never_read).unwrap_err();

        assert!(
            traversal.to_string().contains("Directory traversal"),
            "unexpected error: {traversal:#}"
        );
        assert!(
            network.to_string().contains("Network paths"),
            "unexpected error: {network:#}"
        );
    }

    #[test]
    fn parse_lut_file_allows_double_dots_inside_file_names() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("warm..look.cube");
        fs::write(&path, test_cube(1.0)).unwrap();

        let lut = parse_lut_file(path.to_str().unwrap()).unwrap();

        assert_eq!(lut.size, 2);
    }

    #[test]
    fn bundled_film_luts_parse_within_limits() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/film_luts");
        let entries = list_luts_in_dir(&dir, true).unwrap();
        assert!(
            !entries.is_empty(),
            "no bundled LUTs found in {}",
            dir.display()
        );

        for entry in entries {
            assert!(entry.is_built_in);
            let lut = parse_lut_file(&entry.path).unwrap_or_else(|error| {
                panic!("bundled LUT '{}' failed to parse: {error:#}", entry.name)
            });
            let edge = lut.size as usize;
            assert!(lut.size <= EXPECTED_MAX_LUT_EDGE);
            assert_eq!(lut.data.len(), edge * edge * edge * 3);
        }
    }

    #[test]
    fn import_luts_to_dir_skips_oversized_files() {
        let source = tempfile::tempdir().unwrap();
        let library = tempfile::tempdir().unwrap();
        let valid = source.path().join("valid.cube");
        fs::write(&valid, test_cube(1.0)).unwrap();
        let oversized = source.path().join("oversized.cube");
        create_sparse_file(&oversized, EXPECTED_MAX_LUT_FILE_BYTES + 1);

        let entries = import_luts_to_dir(
            library.path(),
            &[
                valid.to_string_lossy().into_owned(),
                oversized.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();

        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["valid"]);
        assert!(entries.iter().all(|entry| !entry.is_built_in));
        assert!(!library.path().join("oversized.cube").exists());
    }

    #[test]
    fn cube_rejects_zero_declared_edge() {
        let error = cube_declaration_error("0");

        assert!(
            error.contains("must be at least 1"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn cube_rejects_declared_edge_above_supported_maximum() {
        let error = cube_declaration_error("66");

        assert!(
            error.contains("maximum supported edge is 65"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn cube_declared_edge_arithmetic_cannot_overflow() {
        let error = cube_declaration_error(&u32::MAX.to_string());

        assert!(
            error.contains("maximum supported edge is 65"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn cube_rejects_pathological_short_token_data_line() {
        let mut bytes = b"LUT_3D_SIZE 1\n".to_vec();
        for _ in 0..100_000 {
            bytes.extend_from_slice(b"0 ");
        }
        bytes.extend_from_slice(b"0\n");

        let error = parse_cube(bytes.as_slice()).unwrap_err();

        assert!(
            error.to_string().contains("more than 3 values"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn cube_rejects_data_beyond_declared_edge() {
        let bytes = b"LUT_3D_SIZE 1\n0 0 0\n1 1 1\n";

        let error = parse_cube(&bytes[..]).unwrap_err();

        assert!(
            error.to_string().contains("more data than declared"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn cube_rejects_identical_repeated_size_directive() {
        let bytes = b"LUT_3D_SIZE 1\nLUT_3D_SIZE 1\n0 0 0\n";

        let error = parse_cube(&bytes[..]).unwrap_err();

        assert!(
            error.to_string().contains("may only appear once"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn cube_rejects_conflicting_repeated_size_directive() {
        let mut bytes = b"LUT_3D_SIZE 1\nLUT_3D_SIZE 2\n".to_vec();
        for _ in 0..8 {
            bytes.extend_from_slice(b"0 0 0\n");
        }

        let error = parse_cube(bytes.as_slice()).unwrap_err();

        assert!(
            error.to_string().contains("may only appear once"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn cube_accepts_inline_comment_after_data_values() {
        let bytes = b"LUT_3D_SIZE 1\n0 0 0 # black point\n";

        let lut = parse_cube(&bytes[..]).unwrap();

        assert_eq!(lut.size, 1);
        assert_eq!(lut.data, vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn cube_accepts_maximum_supported_edge() {
        let bytes = constant_lut_rows(EXPECTED_MAX_LUT_EDGE, true);

        let lut = parse_lut_file_with("maximum.cube", |_| Ok(bytes)).unwrap();

        assert_eq!(lut.size, EXPECTED_MAX_LUT_EDGE);
        assert_eq!(lut.data.len(), (EXPECTED_MAX_LUT_EDGE as usize).pow(3) * 3);
    }

    #[test]
    fn three_dl_accepts_maximum_supported_edge() {
        let bytes = constant_lut_rows(EXPECTED_MAX_LUT_EDGE, false);

        let lut = parse_lut_file_with("maximum.3dl", |_| Ok(bytes)).unwrap();

        assert_eq!(lut.size, EXPECTED_MAX_LUT_EDGE);
        assert_eq!(lut.data.len(), (EXPECTED_MAX_LUT_EDGE as usize).pow(3) * 3);
    }

    #[test]
    fn three_dl_rejects_entries_above_supported_maximum() {
        let mut bytes = constant_lut_rows(EXPECTED_MAX_LUT_EDGE, false);
        bytes.extend_from_slice(b"0 0 0\n");

        let error = parse_3dl(bytes.as_slice()).unwrap_err();

        assert!(
            error.to_string().contains("maximum supported edge is 65"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn three_dl_ignores_wide_non_data_line() {
        let mut bytes = Vec::new();
        for _ in 0..100_000 {
            bytes.extend_from_slice(b"header ");
        }
        bytes.extend_from_slice(b"header\n0 0 0\n");

        let lut = parse_3dl(bytes.as_slice()).unwrap();

        assert_eq!(lut.size, 1);
        assert_eq!(lut.data, vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn hald_decode_rejects_oversized_compressed_images() {
        for (extension, format) in [
            ("png", image::ImageFormat::Png),
            ("jpg", image::ImageFormat::Jpeg),
            ("tiff", image::ImageFormat::Tiff),
        ] {
            let encoded = encoded_test_image(525, 525, format);
            let error = parse_lut_bytes(extension, &encoded).unwrap_err();

            assert!(
                error
                    .to_string()
                    .contains("maximum supported HALD dimension is 524x524"),
                "unexpected {extension} error: {error:#}"
            );
        }
    }

    #[test]
    fn hald_decode_accepts_valid_512_square() {
        let encoded = encoded_test_image(512, 512, image::ImageFormat::Png);

        let lut = parse_lut_bytes("png", &encoded).unwrap();

        assert_eq!(lut.size, 64);
        assert_eq!(lut.data.len(), 64_usize.pow(3) * 3);
    }

    #[test]
    fn hald_rejects_zero_dimensions() {
        let error = parse_hald(DynamicImage::new_rgb8(0, 0)).unwrap_err();

        assert!(
            error.to_string().contains("dimensions must be non-zero"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn hald_rejects_square_that_is_not_a_cube() {
        let error = parse_hald(DynamicImage::new_rgb8(100, 100)).unwrap_err();

        assert!(
            error.to_string().contains("not a perfect cube"),
            "unexpected error: {error:#}"
        );
    }
}
