#!/usr/bin/env python3
"""
icc_to_cube.py — Convert an ICC DeviceLink profile to a .cube 3D LUT.

Dependencies:
    pip install pillow numpy

Optional (for richer LUT output):
    pip install colour-science

Usage:
    python icc_to_cube.py input.icc output.cube [--grid-size 32]
"""

import argparse
import sys
import numpy as np

try:
    from PIL import Image, ImageCms
except ImportError:
    sys.exit("pillow is required: pip install pillow")


# ─── Grid ────────────────────────────────────────────────────────────────────

def build_grid(grid_size: int) -> np.ndarray:
    """
    Return (grid_size^3, 3) float32 array of evenly spaced RGB triplets [0..1].
    .cube format iterates Blue fastest, then Green, then Red.
    """
    v = np.linspace(0.0, 1.0, grid_size, dtype=np.float32)
    r, g, b = np.meshgrid(v, v, v, indexing='ij')
    # Reorder to B-fastest (cube convention)
    return np.stack([r.ravel(), g.ravel(), b.ravel()], axis=-1)


# ─── ICC Transform ───────────────────────────────────────────────────────────

def apply_icc_devicelink(icc_path: str, rgb: np.ndarray) -> np.ndarray:
    """
    Apply an ICC DeviceLink profile to (N, 3) float32 RGB [0..1].
    Uses Pillow's lcms2 wrapper.
    Returns (N, 3) float32 [0..1].
    """
    try:
        in_profile = ImageCms.getOpenProfile(icc_path)
        # sRGB as a proxy output profile — lcms2 uses the DeviceLink transform internally
        out_profile = ImageCms.createProfile("sRGB")
        transform = ImageCms.buildTransform(
            in_profile, out_profile, "RGB", "RGB",
            renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
        )
    except Exception as e:
        raise RuntimeError(
            f"Could not build ICC transform from '{icc_path}': {e}\n"
            "Make sure the file is a valid RGB→RGB DeviceLink ICC profile."
        ) from e

    n = rgb.shape[0]
    u8 = (rgb * 255.0).clip(0, 255).round().astype(np.uint8)
    # Pack as a single-row image so lcms2 processes all points in one call
    img = Image.fromarray(u8.reshape(1, n, 3), mode="RGB")
    out_img = ImageCms.applyTransform(img, transform)
    return np.asarray(out_img, dtype=np.float32).reshape(n, 3) / 255.0


# ─── .cube Writer ────────────────────────────────────────────────────────────

def write_cube(path: str, lut: np.ndarray, grid_size: int, title: str = "") -> None:
    """
    Write (grid_size^3, 3) float array as a standard .cube file.
    Column order: R G B, Blue-fastest (CUBE spec §3).
    """
    with open(path, "w") as f:
        if title:
            f.write(f'TITLE "{title}"\n')
        f.write(f"LUT_3D_SIZE {grid_size}\n")
        f.write("DOMAIN_MIN 0.0 0.0 0.0\n")
        f.write("DOMAIN_MAX 1.0 1.0 1.0\n\n")
        for row in lut:
            f.write(f"{row[0]:.6f} {row[1]:.6f} {row[2]:.6f}\n")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert an ICC DeviceLink profile to a .cube 3D LUT."
    )
    parser.add_argument("input",  help="Path to the ICC DeviceLink profile (.icc / .icm)")
    parser.add_argument("output", help="Path for the output .cube file")
    parser.add_argument(
        "--grid-size", type=int, default=32,
        help="LUT grid resolution (default: 32). Common: 17, 32, 33, 64.",
    )
    args = parser.parse_args()

    grid_size = args.grid_size
    if grid_size < 2 or grid_size > 256:
        sys.exit("--grid-size must be between 2 and 256")

    total = grid_size ** 3
    print(f"Grid      : {grid_size}³ = {total} points")
    print(f"ICC input : {args.input}")
    print(f"Output    : {args.output}")

    grid = build_grid(grid_size)

    print("Applying DeviceLink transform…")
    try:
        transformed = apply_icc_devicelink(args.input, grid)
    except RuntimeError as e:
        sys.exit(str(e))

    print("Writing .cube…")
    import os
    title = os.path.splitext(os.path.basename(args.input))[0]
    write_cube(args.output, transformed, grid_size, title=title)

    print(f"Done — {args.output}")


if __name__ == "__main__":
    main()
