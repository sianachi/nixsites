"""Pack Nix pose strips and render their actual playback order. Requires Pillow."""

import argparse
from itertools import groupby
import json
from math import ceil
from pathlib import Path

from PIL import Image, ImageDraw

AVATAR_SIZES = (56, 96)
LIGHT = "#f4f2ee"
DARK = "#23252e"
IDLE_PLAYBACK = (0, 0, 0, 0, 1, 2, 3, 4, 5)


def foreground_spans(projection, min_span):
    spans = []
    for occupied, group in groupby(enumerate(projection), key=lambda pair: pair[1]):
        run = list(group)
        if occupied and len(run) >= min_span:
            spans.append((run[0][0], run[-1][0] + 1))
    return spans


def read_strip(path, count):
    with Image.open(path) as source:
        strip = source.convert("RGBA")
    alpha = strip.getchannel("A")
    solid = alpha.point(lambda a: 255 if a >= 128 else 0)
    # shortcut: expects one horizontal span per pose, place detached parts by hand.
    columns, _ = solid.getprojection()
    spans = foreground_spans(columns, max(4, strip.width // (count * 12)))
    if len(spans) != count:
        raise ValueError(f"{path}: expected {count} separate poses, found {len(spans)}")

    # Almost transparent flecks can sit far beyond the generated silhouette.
    strip.putalpha(alpha.point(lambda a: a if a >= 8 else 0))
    cuts = [0] + [(end + start) // 2 for (_, end), (start, _) in zip(spans, spans[1:])]
    cuts.append(strip.width)
    boxes = []
    for left, right in zip(cuts, cuts[1:]):
        x0, y0, x1, y1 = solid.crop((left, 0, right, strip.height)).getbbox()
        if x0 == 0 or y0 == 0 or x1 == right - left or y1 == strip.height:
            raise ValueError(f"{path}: pose {len(boxes) + 1} touches a crop edge")
        boxes.append((left + x0, y0, left + x1, y1))

    neutral_width = boxes[0][2] - boxes[0][0]
    resting_y = max(boxes[0][3], boxes[-1][3])
    crops = []
    for x0, y0, x1, y1 in boxes:
        # A little source padding preserves antialiased edges before downsampling.
        box = (
            max(0, x0 - 3),
            max(0, y0 - 3),
            min(strip.width, x1 + 3),
            min(strip.height, y1 + 3),
        )
        crops.append((strip.crop(box), box[1] - resting_y))
    return neutral_width, crops


def fit_atlas(strips, cell_size):
    width, height = cell_size
    # Measure motion relative to each strip's opening width and resting baseline.
    extents = [
        (frame.width / neutral_width, -top / neutral_width, (top + frame.height) / neutral_width)
        for neutral_width, crops in strips
        for frame, top in crops
    ]
    widest, above, below = map(max, zip(*extents))
    target_width = min(width * 0.82, (width - 6) / widest, (height - 16) / (above + below))
    baseline = height - max(10, 3 + ceil(below * target_width))
    return target_width, baseline


def pack_strip(path, strip, cell_size, target_width, baseline):
    width, height = cell_size
    neutral_width, crops = strip
    scale = target_width / neutral_width
    frames = []
    for index, (frame, top) in enumerate(crops, start=1):
        frame = frame.resize(
            (max(1, round(frame.width * scale)), max(1, round(frame.height * scale))),
            Image.Resampling.LANCZOS,
        )
        x = (width - frame.width) // 2
        y = baseline + round(top * scale)
        if x < 2 or y < 2 or x + frame.width > width - 2 or y + frame.height > height - 2:
            raise ValueError(f"{path}: pose {index} does not fit the cell with padding")
        cell = Image.new("RGBA", cell_size)
        cell.alpha_composite(frame, (x, y))
        frames.append(cell)
    return frames


def place_avatar(canvas, frame, x, y, size):
    sprite = frame.copy()
    sprite.thumbnail((size, size), Image.Resampling.LANCZOS)
    canvas.paste(sprite, (x + (size - sprite.width) // 2, y + (size - sprite.height) // 2), sprite)


def write_previews(rows, prefix, frame_duration):
    contact = Image.new("RGB", (128 + 8 * 96, len(rows) * 96), LIGHT)
    contact_text = ImageDraw.Draw(contact)
    movie = []
    for index, (states, frames) in enumerate(rows):
        label = " / ".join(states).replace("-", " ").title()
        contact_text.multiline_text((8, index * 96 + 16), "\n".join(states), fill=DARK)
        for column, frame in enumerate(frames):
            place_avatar(contact, frame, 128 + column * 96, index * 96, 96)
        panels = []
        for frame in frames:
            panel = Image.new("RGB", (352, 154), LIGHT)
            draw = ImageDraw.Draw(panel)
            draw.rectangle((176, 30, 351, 153), fill=DARK)
            draw.text((8, 8), label, fill=DARK)
            for offset, ink in ((0, DARK), (176, LIGHT)):
                for x, size in zip((8, 72), AVATAR_SIZES):
                    place_avatar(panel, frame, offset + x, 32 + (96 - size) // 2, size)
                    draw.text((offset + x + 4, 133), f"{size} px", fill=ink)
            panels.append(panel)
        playback = IDLE_PLAYBACK if states == ["idle"] else range(len(panels))
        movie.extend(panels[frame] for frame in list(playback) * 2)
    contact.save(prefix.with_name(f"{prefix.name}-contact.png"))
    movie[0].save(
        prefix.with_name(f"{prefix.name}-preview.gif"),
        save_all=True,
        append_images=movie[1:],
        duration=frame_duration,
        loop=0,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug")
    parser.add_argument("strips", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--pilot", action="store_true", help="preview only idle.png")
    args = parser.parse_args()
    if not args.slug or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in args.slug):
        parser.error("slug must contain only lowercase letters, digits and hyphens")

    template = Path("packages/web-pets/src/pets/neko-atlas.json")
    metadata = json.loads(template.read_text())
    cell_size = (metadata["cellWidth"], metadata["cellHeight"])
    columns = metadata["columns"]
    counts = metadata["frameCounts"]
    state_rows = metadata["stateRows"]
    active_rows = sorted(set(state_rows.values()))
    if args.pilot:
        active_rows = [state_rows["idle"]]
    atlas = Image.new("RGBA", (metadata["imageWidth"], metadata["imageHeight"]))
    inputs = []
    for row in active_rows:
        states = [state for state, slot in state_rows.items() if slot == row]
        path = args.strips / f"{states[0]}.png"
        inputs.append((row, states, path, read_strip(path, counts[row])))
    target_width, baseline = fit_atlas([strip for _, _, _, strip in inputs], cell_size)
    previews = []
    for row, states, path, strip in inputs:
        frames = pack_strip(path, strip, cell_size, target_width, baseline)
        for column, frame in enumerate(frames):
            atlas.alpha_composite(frame, (column * cell_size[0], row * cell_size[1]))
        previews.append((states, frames))

    args.output.mkdir(parents=True, exist_ok=True)
    prefix = args.output / (f"{args.slug}-pilot" if args.pilot else args.slug)
    if not args.pilot:
        metadata["source"] = f"{args.slug}-atlas.webp"
        metadata["frameCounts"] = [count if row in active_rows else 0 for row, count in enumerate(counts)]
        atlas_path = args.output / metadata["source"]
        atlas.save(atlas_path, lossless=True)
        with Image.open(atlas_path) as exported:
            if (
                exported.size != atlas.size
                or exported.getchannel("A").tobytes() != atlas.getchannel("A").tobytes()
            ):
                raise ValueError(f"{atlas_path}: exported geometry or alpha differs from the packed atlas")
        (args.output / f"{args.slug}-atlas.json").write_text(json.dumps(metadata, indent=2) + "\n")
    write_previews(previews, prefix, metadata["frameDurationMs"])


if __name__ == "__main__":
    main()
