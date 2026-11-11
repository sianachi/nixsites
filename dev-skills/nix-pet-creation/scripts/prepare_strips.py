"""Extract named horizontal pose strips from a transparent or green-key sheet."""

import argparse
from pathlib import Path

from PIL import Image, ImageChops

from pack_atlas import foreground_spans


def remove_green_key(sheet):
    red, green, blue, alpha = sheet.split()
    other = ImageChops.lighter(red, blue)
    excess = ImageChops.subtract(green, other)
    corners = [(x, y) for x in (0, sheet.width - 1) for y in (0, sheet.height - 1)]
    if any(excess.getpixel(corner) < 120 for corner in corners):
        raise ValueError("green-key sheet needs a saturated green background at all four corners")
    # The warm character palette has no green key colour. Keep partial edge coverage.
    coverage = excess.point(lambda value: round(255 * min(1, max(0, (110 - value) / 86))))
    return Image.merge(
        "RGBA", (red, ImageChops.darker(green, other), blue, ImageChops.multiply(alpha, coverage))
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sheet", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("states", nargs="+", choices=[
        "idle", "speaking", "hover", "error", "listening", "working", "thinking"
    ])
    parser.add_argument("--green-key", action="store_true")
    args = parser.parse_args()
    if len(set(args.states)) != len(args.states):
        parser.error("each state must appear once")

    with Image.open(args.sheet) as image:
        sheet = image.convert("RGBA")
    if args.green_key:
        sheet = remove_green_key(sheet)
    solid = sheet.getchannel("A").point(lambda value: 255 if value >= 128 else 0)
    if solid.getbbox() == (0, 0, sheet.width, sheet.height):
        raise ValueError(f"{args.sheet}: artwork or background touches the sheet edges")
    _, rows = solid.getprojection()
    bands = foreground_spans(rows, max(4, sheet.height // (len(args.states) * 12)))
    if len(bands) != len(args.states):
        raise ValueError(f"{args.sheet}: expected {len(args.states)} bands, found {len(bands)}")

    cuts = [0] + [(end + start) // 2 for (_, end), (start, _) in zip(bands, bands[1:])]
    cuts.append(sheet.height)
    args.output.mkdir(parents=True, exist_ok=True)
    for state, top, bottom in zip(args.states, cuts, cuts[1:]):
        sheet.crop((0, top, sheet.width, bottom)).save(args.output / f"{state}.png")


if __name__ == "__main__":
    main()
