#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class OverlaySettings:
    x: int = 58
    y: int = 0
    width: int | None = None
    height: int | None = None
    scale_divisor: float = 2.0
    loop: int = 0


def render_overlay_gif(
    input_gif: Path,
    overlay_image: Path,
    output_gif: Path,
    settings: OverlaySettings = OverlaySettings(),
) -> Path:
    if settings.scale_divisor <= 0:
        raise ValueError("scale_divisor must be greater than 0")

    if not input_gif.is_file():
        raise FileNotFoundError(f"Input GIF not found: {input_gif}")

    if not overlay_image.is_file():
        raise FileNotFoundError(f"Overlay image not found: {overlay_image}")

    if settings.width is not None and settings.width <= 0:
        raise ValueError("width must be greater than 0")

    if settings.height is not None and settings.height <= 0:
        raise ValueError("height must be greater than 0")

    scale_width = (
        str(settings.width)
        if settings.width is not None
        else f"trunc(iw/{settings.scale_divisor})"
    )
    scale_height = (
        str(settings.height)
        if settings.height is not None
        else f"trunc(ih/{settings.scale_divisor})"
    )

    filter_graph = (
        f"[1:v]scale={scale_width}:{scale_height}[overlay];"
        f"[0:v][overlay]overlay={settings.x}:{settings.y},split[gif][palette_src];"
        f"[palette_src]palettegen[palette];"
        f"[gif][palette]paletteuse"
    )

    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_gif),
        "-i",
        str(overlay_image),
        "-filter_complex",
        filter_graph,
        "-loop",
        str(settings.loop),
        str(output_gif),
    ]

    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        message = exc.stderr.strip() or exc.stdout.strip() or str(exc)
        raise RuntimeError(f"ffmpeg failed: {message}") from exc

    return output_gif


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Overlay a static image over the word 'woman' in the base animated GIF "
            "and render a new GIF."
        )
    )
    parser.add_argument("input_gif", type=Path, help="Base input GIF")
    parser.add_argument("overlay_image", type=Path, help="Overlay image, such as a WebP")
    parser.add_argument(
        "output_gif",
        type=Path,
        nargs="?",
        help="Output GIF path. Defaults to <input>_overlay_woman.gif",
    )
    parser.add_argument("--x", type=int, default=58, help="Overlay X position")
    parser.add_argument("--y", type=int, default=0, help="Overlay Y position")
    parser.add_argument("--width", type=int, help="Overlay width in pixels")
    parser.add_argument("--height", type=int, help="Overlay height in pixels")
    parser.add_argument(
        "--scale-divisor",
        type=float,
        default=2.0,
        help="Divide the overlay image dimensions by this value",
    )
    parser.add_argument(
        "--loop",
        type=int,
        default=0,
        help="GIF loop count. Use 0 for infinite looping",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_gif = args.output_gif or args.input_gif.with_name(
        f"{args.input_gif.stem}_overlay_woman.gif"
    )

    settings = OverlaySettings(
        x=args.x,
        y=args.y,
        width=args.width,
        height=args.height,
        scale_divisor=args.scale_divisor,
        loop=args.loop,
    )
    render_overlay_gif(args.input_gif, args.overlay_image, output_gif, settings)
    print(f"Created GIF: {output_gif}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
