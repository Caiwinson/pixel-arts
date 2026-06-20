// Replaces hexStringToCanvas() in src/web/services/image.ts
// Now also replaces applyPlotOverlay() — overlay is baked into the binary
// at compile time and composited in Rust before the single PNG encode.

use std::env;
use std::io;
use std::process;
use std::sync::OnceLock;

// ---- Baked-in overlay ----
// plot.png bytes are embedded at compile time. The file on disk
// (static/plot.png) is the source of truth — this binary just carries
// its own copy so it has no runtime file dependency.
//
static OVERLAY_PNG_BYTES: &[u8] = include_bytes!("../assets/plot.png");

struct OverlayImage {
    width: usize,
    height: usize,
    // RGBA, 4 bytes per pixel
    pixels: Vec<u8>,
}

static OVERLAY: OnceLock<OverlayImage> = OnceLock::new();

fn get_overlay() -> &'static OverlayImage {
    OVERLAY.get_or_init(|| {
        let decoder = png::Decoder::new(OVERLAY_PNG_BYTES);
        let mut reader = decoder.read_info().unwrap_or_else(|e| {
            eprintln!("Failed to read overlay PNG header: {}", e);
            process::exit(1);
        });

        let mut buf = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap_or_else(|e| {
            eprintln!("Failed to decode overlay PNG: {}", e);
            process::exit(1);
        });

        let width = info.width as usize;
        let height = info.height as usize;

        // Normalize to RGBA8 regardless of the source PNG's color type,
        // so the compositing code below can assume 4 bytes/pixel.
        let pixels = match info.color_type {
            png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
            png::ColorType::Rgb => {
                let src = &buf[..info.buffer_size()];
                let mut out = Vec::with_capacity(width * height * 4);
                for chunk in src.chunks_exact(3) {
                    out.extend_from_slice(chunk);
                    out.push(255); // fully opaque
                }
                out
            }
            png::ColorType::GrayscaleAlpha => {
                let src = &buf[..info.buffer_size()];
                let mut out = Vec::with_capacity(width * height * 4);
                for chunk in src.chunks_exact(2) {
                    let g = chunk[0];
                    out.extend_from_slice(&[g, g, g, chunk[1]]);
                }
                out
            }
            png::ColorType::Grayscale => {
                let src = &buf[..info.buffer_size()];
                let mut out = Vec::with_capacity(width * height * 4);
                for &g in src {
                    out.extend_from_slice(&[g, g, g, 255]);
                }
                out
            }
            other => {
                eprintln!("Unsupported overlay PNG color type: {:?}", other);
                process::exit(1);
            }
        };

        OverlayImage {
            width,
            height,
            pixels,
        }
    })
}

/// Alpha-blends the overlay onto `buffer` (RGB8, no alpha channel).
/// Mirrors ctx.drawImage(overlayImg, 0, 0) on top of a white-filled,
/// already-drawn base image — i.e. standard "source-over" compositing.
/// If the overlay is smaller than the base image, it's anchored at (0,0)
/// and any uncovered area is left untouched (matches canvas behaviour).
fn apply_plot_overlay(buffer: &mut [u8], dim: usize) {
    let overlay = get_overlay();

    let ow = overlay.width.min(dim);
    let oh = overlay.height.min(dim);

    for y in 0..oh {
        for x in 0..ow {
            let o_idx = (y * overlay.width + x) * 4;
            let a = overlay.pixels[o_idx + 3];

            if a == 0 {
                continue; // fully transparent, base pixel untouched
            }

            let or_ = overlay.pixels[o_idx] as u32;
            let og = overlay.pixels[o_idx + 1] as u32;
            let ob = overlay.pixels[o_idx + 2] as u32;
            let oa = a as u32;

            let b_idx = (y * dim + x) * 3;
            let br = buffer[b_idx] as u32;
            let bg = buffer[b_idx + 1] as u32;
            let bb = buffer[b_idx + 2] as u32;

            if oa == 255 {
                // Fully opaque — straight overwrite, skip the blend math.
                buffer[b_idx] = or_ as u8;
                buffer[b_idx + 1] = og as u8;
                buffer[b_idx + 2] = ob as u8;
                continue;
            }

            // Standard alpha blend: out = src*alpha + dst*(1-alpha)
            buffer[b_idx] = (((or_ * oa) + (br * (255 - oa))) / 255) as u8;
            buffer[b_idx + 1] = (((og * oa) + (bg * (255 - oa))) / 255) as u8;
            buffer[b_idx + 2] = (((ob * oa) + (bb * (255 - oa))) / 255) as u8;
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    // Usage: pixel-render <hex_code> <size> [plot]
    if args.len() < 3 || args.len() > 4 {
        eprintln!("Usage: pixel-render <hex_code> <size> [plot]");
        process::exit(1);
    }

    let hex_code = &args[1];
    let size: usize = args[2].parse().unwrap_or_else(|_| {
        eprintln!("Error: size must be a number, got '{}'", args[2]);
        process::exit(1);
    });

    if !matches!(size, 5 | 10 | 15 | 20 | 25) {
        eprintln!("Error: size must be 5, 10, 15, 20, or 25. Got {}", size);
        process::exit(1);
    }

    // Plot overlay only ever applies above the smallest canvas, matching
    // the existing `plot = plotArg && size > 5` rule in image.ts.
    let want_plot = args.get(3).map(|s| s == "plot").unwrap_or(false) && size > 5;

    if let Err(e) = render(hex_code, size, want_plot) {
        eprintln!("Render error: {}", e);
        process::exit(1);
    }
}

fn render(hex_code: &str, size: usize, want_plot: bool) -> Result<(), Box<dyn std::error::Error>> {
    let expected_len = size * size * 6;
    if hex_code.len() != expected_len {
        return Err(format!(
            "hex_code length {} doesn't match expected {} for size {}",
            hex_code.len(),
            expected_len,
            size
        )
        .into());
    }

    let scale = if size == 5 { 100 } else { 50 };
    let dim = size * scale;
    let mut pixels: Vec<u8> = vec![0xFF; dim * dim * 3];
    let hex_bytes = hex_code.as_bytes();

    for py in 0..size {
        for px in 0..size {
            let hex_offset = (py * size + px) * 6;

            let r = parse_hex_byte(hex_bytes[hex_offset], hex_bytes[hex_offset + 1])?;
            let g = parse_hex_byte(hex_bytes[hex_offset + 2], hex_bytes[hex_offset + 3])?;
            let b = parse_hex_byte(hex_bytes[hex_offset + 4], hex_bytes[hex_offset + 5])?;

            for oy in 0..scale {
                for ox in 0..scale {
                    let sx = px * scale + ox;
                    let sy = py * scale + oy;
                    let i = (sy * dim + sx) * 3;

                    pixels[i] = r;
                    pixels[i + 1] = g;
                    pixels[i + 2] = b;
                }
            }
        }
    }

    if want_plot {
        apply_plot_overlay(&mut pixels, dim);
    }

    let stdout = io::stdout();
    let writer = io::BufWriter::new(stdout.lock());
    let mut encoder = png::Encoder::new(writer, dim as u32, dim as u32);

    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Best);
    encoder.set_filter(png::FilterType::Sub);

    let mut png_writer = encoder.write_header()?;
    png_writer.write_image_data(&pixels)?;

    Ok(())
}

#[inline]
fn parse_hex_byte(hi: u8, lo: u8) -> Result<u8, String> {
    static HEX_TABLE: [u8; 256] = {
        let mut table = [255u8; 256];
        let mut i = 0u8;
        while i < 10 {
            table[(b'0' + i) as usize] = i;
            i += 1;
        }
        i = 0;
        while i < 6 {
            table[(b'a' + i) as usize] = 10 + i;
            i += 1;
        }
        i = 0;
        while i < 6 {
            table[(b'A' + i) as usize] = 10 + i;
            i += 1;
        }
        table
    };

    let high = HEX_TABLE[hi as usize];
    let low = HEX_TABLE[lo as usize];

    if high == 255 || low == 255 {
        return Err(format!(
            "Invalid hex characters: '{}' '{}'",
            hi as char, lo as char
        ));
    }

    Ok((high << 4) | low)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hex_byte_valid() {
        assert_eq!(parse_hex_byte(b'f', b'f').unwrap(), 255);
        assert_eq!(parse_hex_byte(b'0', b'0').unwrap(), 0);
        assert_eq!(parse_hex_byte(b'a', b'b').unwrap(), 0xAB);
        assert_eq!(parse_hex_byte(b'F', b'F').unwrap(), 255);
    }

    #[test]
    fn test_parse_hex_byte_invalid() {
        assert!(parse_hex_byte(b'z', b'0').is_err());
        assert!(parse_hex_byte(b'0', b'!').is_err());
    }

    #[test]
    fn test_render_produces_output() {
        let hex = "ff0000".repeat(25);
        assert!(render(&hex, 5, false).is_ok());
    }

    #[test]
    fn test_render_with_plot_produces_output() {
        let hex = "ff0000".repeat(100);
        assert!(render(&hex, 10, true).is_ok());
    }

    #[test]
    fn test_render_rejects_wrong_length() {
        assert!(render("ff0000", 5, false).is_err());
    }

    #[test]
    fn test_overlay_decodes_once() {
        // Calling get_overlay() multiple times should return the same
        // cached instance without re-decoding (OnceLock semantics).
        let first = get_overlay();
        let second = get_overlay();
        assert_eq!(first.width, second.width);
        assert_eq!(first.height, second.height);
    }
}