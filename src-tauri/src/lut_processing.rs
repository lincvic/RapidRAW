#[cfg(target_os = "android")]
use crate::android_integration::{
    get_android_cached_lut_path, is_android_content_uri, read_android_content_uri_bounded,
    resolve_android_content_uri_name,
};
use anyhow::anyhow;
use image::{DynamicImage, GenericImageView, ImageReader, Limits, Rgb, Rgb32FImage};
use serde::Serialize;
use std::fs::{copy, create_dir_all, read_dir};
use std::io::{BufRead, BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose};
use mozjpeg_rs::{Encoder, Preset};
use tauri::{AppHandle, Manager, State};

use crate::AppState;
use crate::android_integration::read_to_limit_plus_one;
use crate::cache_utils::calculate_transform_hash;
use crate::image_processing::{
    RenderRequest, get_all_adjustments_from_json, process_and_get_dynamic_image,
    resolve_tonemapper_override_from_handle,
};

const MAX_LUT_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
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

#[derive(Debug)]
pub(crate) struct LutSnapshot {
    pub(crate) content_blake3: String,
    pub(crate) lut: Lut,
}

#[derive(Debug, Clone, Serialize)]
pub struct LutEntry {
    pub name: String,
    pub path: String,
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

pub fn get_luts_dir(app_data_dir: &Path) -> anyhow::Result<PathBuf> {
    let luts_dir = app_data_dir.join("luts");
    if !luts_dir.exists() {
        create_dir_all(&luts_dir)?;
    }
    Ok(luts_dir)
}

pub fn list_luts_in_dir(dir: &Path) -> anyhow::Result<Vec<LutEntry>> {
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
        if extension == "cube" || extension == "3dl" {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("LUT")
                .to_string();
            entries.push(LutEntry {
                name,
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

fn unique_lut_destination(dir: &Path, stem: &str, extension: &str) -> PathBuf {
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
        let destination = unique_lut_destination(dir, stem, &extension);
        if let Err(error) = copy(source_path, &destination) {
            log::error!("Failed to copy LUT '{}': {}", source, error);
        }
    }
    list_luts_in_dir(dir)
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
    let bytes = read_android_content_uri_bounded(source, MAX_LUT_SNAPSHOT_BYTES)
        .map_err(|e| anyhow!("Failed to read content URI: {}", e))?;
    validate_lut_snapshot_size(bytes.len() as u64)?;

    let cache_path = get_android_cached_lut_path(source, &extension)?;
    let cache_dir = cache_path
        .parent()
        .ok_or_else(|| anyhow!("Invalid cache path"))?
        .to_path_buf();
    let destination = unique_lut_destination(&cache_dir, &stem, &extension);
    std::fs::write(&destination, &bytes)?;
    Ok(())
}

fn validate_lut_snapshot_size(byte_len: u64) -> anyhow::Result<()> {
    if byte_len > MAX_LUT_SNAPSHOT_BYTES as u64 {
        return Err(anyhow!(
            "LUT snapshot is {} bytes; the maximum allowed size is 32 MiB ({} bytes)",
            byte_len,
            MAX_LUT_SNAPSHOT_BYTES
        ));
    }
    Ok(())
}

fn checked_lut_counts(edge: u32, format: &str) -> anyhow::Result<(usize, usize)> {
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
    let entries = edge
        .checked_mul(edge)
        .and_then(|count| count.checked_mul(edge))
        .ok_or_else(|| anyhow!("{} LUT entry count overflowed", format))?;
    let values = entries
        .checked_mul(LUT_CHANNELS)
        .ok_or_else(|| anyhow!("{} LUT value count overflowed", format))?;
    Ok((entries, values))
}

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
    let mut size: Option<u32> = None;
    let mut expected_values: Option<usize> = None;
    let mut data: Vec<f32> = Vec::new();
    let mut line_num = 0;

    for line in reader.lines() {
        line_num += 1;
        let line = line?;
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

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
            if size.is_some() {
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
            let (_, parsed_values) = checked_lut_counts(parsed_size, ".cube")?;
            size = Some(parsed_size);
            expected_values = Some(parsed_values);
            continue;
        }

        if let Some(maximum_values) = expected_values {
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
            if data.len() == maximum_values {
                return Err(anyhow!(
                    ".cube LUT contains more data than declared for edge {}",
                    size.unwrap_or_default()
                ));
            }
            reserve_lut_triplet(&mut data, maximum_values, ".cube")?;
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

    let lut_size = size.ok_or(anyhow!("LUT_3D_SIZE not found in .cube file"))?;
    let expected_len = expected_values
        .ok_or_else(|| anyhow!("LUT_3D_SIZE did not produce a valid .cube table size"))?;
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
        let mut parts = trimmed.split_whitespace();
        let (Some(red_token), Some(green_token), Some(blue_token)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if parts.next().is_none() {
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
    }

    let total_values = data.len();
    if total_values == 0 {
        return Err(anyhow!("No data found in 3DL file"));
    }
    let num_entries = total_values / 3;
    let size = (1..=MAX_LUT_EDGE)
        .find(|candidate| {
            let edge = *candidate as usize;
            edge * edge * edge == num_entries
        })
        .ok_or_else(|| {
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

    let total_pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| anyhow!("HALD image pixel count overflowed"))?;
    if total_pixels > MAX_LUT_ENTRIES as u64 {
        return Err(anyhow!(
            "HALD image has {} pixels; the maximum supported LUT edge is {} ({} pixels)",
            total_pixels,
            MAX_LUT_EDGE,
            MAX_LUT_ENTRIES
        ));
    }
    let total_pixels = usize::try_from(total_pixels)
        .map_err(|_| anyhow!("HALD image pixel count cannot be represented on this platform"))?;
    let size = (1..=MAX_LUT_EDGE)
        .find(|candidate| {
            let edge = *candidate as usize;
            edge * edge * edge == total_pixels
        })
        .ok_or_else(|| {
            anyhow!(
                "Invalid HALD image dimensions: total pixels ({}) is not a perfect cube.",
                total_pixels
            )
        })?;
    let (_, value_count) = checked_lut_counts(size, "HALD")?;

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

fn validate_lut_path(path_str: &str) -> anyhow::Result<()> {
    if path_str.starts_with(r"\\") || path_str.starts_with("//") {
        return Err(anyhow!("Network paths (UNC) are not allowed for LUTs"));
    }

    if path_str.contains("..") {
        return Err(anyhow!("Directory traversal (..) is not allowed"));
    }

    let path = std::path::Path::new(path_str);
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

    Ok(())
}

fn lut_extension(path_str: &str) -> String {
    #[cfg(target_os = "android")]
    if is_android_content_uri(path_str) {
        let resolved_name =
            resolve_android_content_uri_name(path_str).unwrap_or_else(|_| path_str.to_string());
        return Path::new(&resolved_name)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("cube")
            .to_lowercase();
    }

    Path::new(path_str)
        .extension()
        .and_then(|extension| extension.to_str())
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
        "cube" => parse_cube(BufReader::new(Cursor::new(bytes))),
        "3dl" => parse_3dl(BufReader::new(Cursor::new(bytes))),
        "png" | "jpg" | "jpeg" | "tiff" => {
            let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
            let mut limits = Limits::default();
            limits.max_image_width = Some(MAX_HALD_IMAGE_DIMENSION);
            limits.max_image_height = Some(MAX_HALD_IMAGE_DIMENSION);
            limits.max_alloc = Some(MAX_LUT_SNAPSHOT_BYTES as u64);
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

fn read_lut_reader_bounded(
    reader: impl std::io::Read,
    initial_capacity: usize,
) -> anyhow::Result<Vec<u8>> {
    let bytes = read_to_limit_plus_one(reader, MAX_LUT_SNAPSHOT_BYTES, initial_capacity)?;
    validate_lut_snapshot_size(bytes.len() as u64)?;
    Ok(bytes)
}

fn read_lut_file_bounded(path: &str) -> anyhow::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    let metadata_len = file.metadata()?.len();
    validate_lut_snapshot_size(metadata_len)?;

    let initial_capacity = usize::try_from(metadata_len)
        .map_err(|_| anyhow!("LUT file size cannot be represented on this platform"))?;
    read_lut_reader_bounded(file, initial_capacity)
}

pub(crate) fn load_lut_snapshot_with<F>(
    path_str: &str,
    read_bytes: F,
) -> anyhow::Result<LutSnapshot>
where
    F: FnOnce(&str) -> anyhow::Result<Vec<u8>>,
{
    validate_lut_path(path_str)?;
    let extension = lut_extension(path_str);
    validate_lut_extension(&extension)?;
    let bytes = read_bytes(path_str)?;
    validate_lut_snapshot_size(bytes.len() as u64)?;
    let content_blake3 = blake3::hash(&bytes).to_hex().to_string();
    let lut = parse_lut_bytes(&extension, &bytes)?;

    Ok(LutSnapshot {
        content_blake3,
        lut,
    })
}

pub(crate) fn load_lut_snapshot(path_str: &str) -> anyhow::Result<LutSnapshot> {
    load_lut_snapshot_with(path_str, |path| {
        #[cfg(target_os = "android")]
        if is_android_content_uri(path) {
            let bytes = read_android_content_uri_bounded(path, MAX_LUT_SNAPSHOT_BYTES)
                .map_err(|error| anyhow!("{}", error))?;
            validate_lut_snapshot_size(bytes.len() as u64)?;
            return Ok(bytes);
        }

        read_lut_file_bounded(path)
    })
}

pub fn parse_lut_file(path_str: &str) -> anyhow::Result<Lut> {
    Ok(load_lut_snapshot(path_str)?.lut)
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
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let luts_dir = get_luts_dir(&data_dir).map_err(|e| e.to_string())?;

    #[cfg(target_os = "android")]
    {
        combined_lut_list(&luts_dir).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        list_luts_in_dir(&luts_dir).map_err(|e| e.to_string())
    }
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
        if extension == "cube" || extension == "3dl" {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("LUT")
                .to_string();
            entries.push(LutEntry {
                name,
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

#[cfg(target_os = "android")]
fn combined_lut_list(luts_dir: &Path) -> anyhow::Result<Vec<LutEntry>> {
    let mut entries = list_luts_in_dir(luts_dir)?;
    if let Ok(cached) = list_luts_in_cache() {
        entries.extend(cached);
    }
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

    #[cfg(target_os = "android")]
    {
        combined_lut_list(&luts_dir).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        list_luts_in_dir(&luts_dir).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn remove_lut(app_handle: AppHandle, path: String) -> Result<Vec<LutEntry>, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let luts_dir = get_luts_dir(&data_dir).map_err(|e| e.to_string())?;
    let target_path = PathBuf::from(&path);

    #[cfg(target_os = "android")]
    {
        let cache_dir = get_lut_cache_dir().map_err(|e| e.to_string())?;
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

    #[cfg(target_os = "android")]
    {
        combined_lut_list(&luts_dir).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        list_luts_in_dir(&luts_dir).map_err(|e| e.to_string())
    }
}

fn render_lut_swatch(
    context: &crate::image_processing::GpuContext,
    state: &State<AppState>,
    base_image: &DynamicImage,
    transform_hash: u64,
    adjustments: crate::image_processing::AllAdjustments,
    lut_path: &str,
) -> Option<String> {
    let lut = get_or_load_lut(state, lut_path).ok()?;
    let processed = process_and_get_dynamic_image(
        context,
        state,
        base_image,
        transform_hash,
        RenderRequest {
            adjustments,
            mask_bitmaps: &[],
            lut: Some(lut),
            roi: None,
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
pub fn generate_lut_previews(
    lut_paths: Vec<String>,
    size: u32,
    state: State<AppState>,
    app_handle: AppHandle,
) -> Result<Vec<LutPreview>, String> {
    let context = crate::image_processing::get_or_init_gpu_context(&state, &app_handle)?;
    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded for LUT previews")?;
    let is_raw = loaded_image.is_raw;

    let base_json = serde_json::json!({});
    let (base_image, _scale, _offset) =
        crate::generate_transformed_preview(&state, &loaded_image, &base_json, size)?;

    let tm_override = resolve_tonemapper_override_from_handle(&app_handle, is_raw);
    let lut_json = serde_json::json!({
        "lutPath": "preview",
        "lutIntensity": 100,
        "sectionVisibility": { "effects": true }
    });
    let adjustments = get_all_adjustments_from_json(&lut_json, is_raw, tm_override);
    let transform_hash = calculate_transform_hash(&base_json);

    let previews = lut_paths
        .into_iter()
        .map(|path| {
            let thumb = render_lut_swatch(
                &context,
                &state,
                &base_image,
                transform_hash,
                adjustments,
                &path,
            );
            LutPreview { path, thumb }
        })
        .collect();

    Ok(previews)
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
    use std::io::{self, Read};
    use std::sync::Mutex;

    const EXPECTED_MAX_LUT_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
    const EXPECTED_MAX_LUT_EDGE: u32 = 65;
    static LARGE_READER_TEST_LOCK: Mutex<()> = Mutex::new(());

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
        std::panic::catch_unwind(|| parse_cube(BufReader::new(Cursor::new(bytes))))
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

    #[test]
    fn lut_snapshot_hashes_and_parses_the_same_byte_read() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("mutable.cube");
        let first_bytes = test_cube(1.0);
        let replacement_bytes = test_cube(0.5);
        fs::write(&path, &first_bytes).unwrap();
        let expected_digest = blake3::hash(&first_bytes).to_hex().to_string();

        let snapshot = load_lut_snapshot_with(path.to_str().unwrap(), |path| {
            let bytes = fs::read(path)?;
            fs::write(path, &replacement_bytes)?;
            Ok(bytes)
        })
        .unwrap();

        assert_eq!(snapshot.content_blake3, expected_digest);
        assert_eq!(snapshot.lut.data.last().copied(), Some(1.0));
        assert_eq!(fs::read(path).unwrap(), replacement_bytes);
    }

    #[test]
    fn injected_lut_snapshot_reader_rejects_bytes_above_limit() {
        let _large_test_guard = LARGE_READER_TEST_LOCK.lock().unwrap();
        let bytes = read_to_limit_plus_one(
            SyntheticReader::new(EXPECTED_MAX_LUT_SNAPSHOT_BYTES + 1),
            EXPECTED_MAX_LUT_SNAPSHOT_BYTES,
            0,
        )
        .unwrap();

        let error = load_lut_snapshot_with("oversized.cube", |_| Ok(bytes)).unwrap_err();

        assert!(
            error.to_string().contains("32 MiB"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn desktop_lut_snapshot_rejects_oversized_sparse_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("oversized.cube");
        let file = fs::File::create(&path).unwrap();
        file.set_len((EXPECTED_MAX_LUT_SNAPSHOT_BYTES + 1) as u64)
            .unwrap();
        drop(file);

        let error = load_lut_snapshot(path.to_str().unwrap()).unwrap_err();

        assert!(
            error.to_string().contains("32 MiB"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn bounded_lut_reader_accepts_exact_snapshot_limit() {
        let _large_test_guard = LARGE_READER_TEST_LOCK.lock().unwrap();
        let mut reader = SyntheticReader::new(EXPECTED_MAX_LUT_SNAPSHOT_BYTES);

        let bytes = read_lut_reader_bounded(&mut reader, 0).unwrap();

        assert_eq!(bytes.len(), EXPECTED_MAX_LUT_SNAPSHOT_BYTES);
        assert_eq!(reader.bytes_read, EXPECTED_MAX_LUT_SNAPSHOT_BYTES);
        assert!(reader.largest_request <= 8192);
    }

    #[test]
    fn bounded_lut_reader_rejects_limit_plus_one_after_metadata_growth() {
        let _large_test_guard = LARGE_READER_TEST_LOCK.lock().unwrap();
        let mut reader = SyntheticReader::new(EXPECTED_MAX_LUT_SNAPSHOT_BYTES + 1);

        let error = read_lut_reader_bounded(&mut reader, 1).unwrap_err();

        assert!(
            error.to_string().contains("32 MiB"),
            "unexpected error: {error:#}"
        );
        assert_eq!(reader.bytes_read, EXPECTED_MAX_LUT_SNAPSHOT_BYTES + 1);
        assert!(reader.largest_request <= 8192);
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

        let error = parse_cube(BufReader::new(Cursor::new(bytes))).unwrap_err();

        assert!(
            error.to_string().contains("more than 3 values"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn cube_rejects_identical_repeated_size_directive() {
        let bytes = b"LUT_3D_SIZE 1\nLUT_3D_SIZE 1\n0 0 0\n";

        let error = parse_cube(BufReader::new(Cursor::new(bytes))).unwrap_err();

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

        let error = parse_cube(BufReader::new(Cursor::new(bytes))).unwrap_err();

        assert!(
            error.to_string().contains("may only appear once"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn cube_accepts_inline_comment_after_data_values() {
        let bytes = b"LUT_3D_SIZE 1\n0 0 0 # black point\n";

        let lut = parse_cube(BufReader::new(Cursor::new(bytes))).unwrap();

        assert_eq!(lut.size, 1);
        assert_eq!(lut.data, vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn cube_accepts_maximum_supported_edge() {
        let bytes = constant_lut_rows(EXPECTED_MAX_LUT_EDGE, true);

        let lut = load_lut_snapshot_with("maximum.cube", |_| Ok(bytes))
            .unwrap()
            .lut;

        assert_eq!(lut.size, EXPECTED_MAX_LUT_EDGE);
        assert_eq!(lut.data.len(), (EXPECTED_MAX_LUT_EDGE as usize).pow(3) * 3);
    }

    #[test]
    fn three_dl_accepts_maximum_supported_edge() {
        let bytes = constant_lut_rows(EXPECTED_MAX_LUT_EDGE, false);

        let lut = load_lut_snapshot_with("maximum.3dl", |_| Ok(bytes))
            .unwrap()
            .lut;

        assert_eq!(lut.size, EXPECTED_MAX_LUT_EDGE);
        assert_eq!(lut.data.len(), (EXPECTED_MAX_LUT_EDGE as usize).pow(3) * 3);
    }

    #[test]
    fn three_dl_rejects_entries_above_supported_maximum() {
        let mut bytes = constant_lut_rows(EXPECTED_MAX_LUT_EDGE, false);
        bytes.extend_from_slice(b"0 0 0\n");

        let error = parse_3dl(BufReader::new(Cursor::new(bytes))).unwrap_err();

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

        let lut = parse_3dl(BufReader::new(Cursor::new(bytes))).unwrap();

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
}
