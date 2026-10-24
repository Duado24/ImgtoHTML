
#!/usr/bin/env python3
"""ImgtoHTML v1.2.4: local OCR-first Canvas HTML draft generator.

v1.2.3 color extraction retained; v1.2.4 adds convert() as a
reusable entry point for a future local UI.

Outputs require manual verification.
"""

import argparse
import colorsys
import html
import io
import json
import re

from base64 import b64encode
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageOps
import pytesseract
from pytesseract import Output


# ============================================================
# COLORS
# ============================================================

def rgb_hex(color):
    return "#{:02x}{:02x}{:02x}".format(*color)


def luminance(color):
    values = [value / 255 for value in color]

    values = [
        x / 12.92
        if x <= 0.04045
        else ((x + 0.055) / 1.055) ** 2.4
        for x in values
    ]

    return (
        0.2126 * values[0]
        + 0.7152 * values[1]
        + 0.0722 * values[2]
    )


def contrast(a, b):
    low, high = sorted((luminance(a), luminance(b)))
    return (high + 0.05) / (low + 0.05)


def colors_from_image(image):
    """Existing fallback if word-box measurement fails."""

    thumbnail = image.copy()
    thumbnail.thumbnail((360, 360))

    frequencies = Counter(
        tuple((channel // 8) * 8 for channel in pixel)
        for pixel in thumbnail.convert("RGB").getdata()
    )

    background = frequencies.most_common(1)[0][0]

    candidates = [
        (color, count)
        for color, count in frequencies.items()
        if contrast(color, background) >= 2
        and count >= 2
    ]

    if candidates:
        foreground = max(
            candidates,
            key=lambda item: item[1]
        )[0]
    else:
        foreground = (
            (255, 255, 255)
            if luminance(background) < 0.18
            else (0, 0, 0)
        )

    return background, foreground


def pixels(image):
    """Read pixel colors across supported Pillow versions."""

    if hasattr(image, "get_flattened_data"):
        return image.get_flattened_data()

    return image.getdata()


def colors_from_words(image, boxes, min_contrast=3):
    """Estimate background and foreground using OCR word boxes.

    Returns:
        background
        foreground
        secondary_color_ratio

    This does not reproduce multiple text colors.
    """

    rgb = image.convert("RGB")

    background = Counter(
        pixels(rgb)
    ).most_common(1)[0][0]

    counts = Counter()

    for x, y, width, height in boxes:
        if width > 0 and height > 0:
            region = rgb.crop((
                x,
                y,
                x + width,
                y + height
            ))

            counts.update(pixels(region))

    text_pixels = {
        color: count
        for color, count in counts.items()
        if contrast(color, background) >= min_contrast
    }

    if not text_pixels:
        bg, fg = colors_from_image(image)
        return bg, fg, 0.0

    foreground = max(
        text_pixels,
        key=text_pixels.get
    )

    def distance(a, b):
        return sum(
            (p - q) ** 2
            for p, q in zip(a, b)
        ) ** 0.5

    other_counts = [
        count
        for color, count in text_pixels.items()
        if distance(color, foreground) > 80
    ]

    secondary_ratio = (
        max(other_counts, default=0)
        / text_pixels[foreground]
    )

    return background, foreground, secondary_ratio


def fix_contrast(
    foreground,
    background,
    minimum=4.5
):
    """Adjust lightness without changing HLS hue or saturation."""

    if contrast(foreground, background) >= minimum:
        return foreground

    h, old_l, s = colorsys.rgb_to_hls(
        *(value / 255 for value in foreground)
    )

    matches = []

    for step in range(1001):
        lightness = step / 1000

        candidate = tuple(
            round(255 * value)
            for value in colorsys.hls_to_rgb(
                h,
                lightness,
                s
            )
        )

        if contrast(candidate, background) >= minimum:
            matches.append((
                abs(lightness - old_l),
                candidate
            ))

    if not matches:
        return foreground

    return min(
        matches,
        key=lambda item: item[0]
    )[1]


# ============================================================
# PRIVACY
# ============================================================

HOME_PATHS = (
    re.compile(
        r"(?i)([A-Z]:\\Users\\)([^\\\s/>:]+)"
    ),
    re.compile(
        r"(?i)(/home/)([^/\s]+)"
    ),
    re.compile(
        r"(?i)(/Users/)([^/\s]+)"
    ),
)


def learned_usernames(lines):
    text = "\n".join(lines)

    names = {
        match.group(2)
        for pattern in HOME_PATHS
        for match in pattern.finditer(text)
    }

    return {
        name
        for name in names
        if name.casefold() not in {
            "username",
            ".",
            ".."
        }
    }


def sanitize_text(text, names):
    """Mask home-path users and learned email-style identities."""

    for pattern in HOME_PATHS:
        text = pattern.sub(
            lambda match: match.group(1) + "username",
            text
        )

    for name in sorted(
        names,
        key=len,
        reverse=True
    ):
        text = re.sub(
            rf"(?<![\w.+-]){re.escape(name)}(?=@[\w.-]+)",
            "username",
            text,
            flags=re.IGNORECASE
        )

    return text


def sanitize_lines(lines):
    names = learned_usernames(lines)

    sanitized = [
        sanitize_text(line, names)
        for line in lines
    ]

    return sanitized, names


# ============================================================
# OCR
# ============================================================

def extract(image, return_boxes=False):
    """Extract text and approximately reconstruct whitespace.

    When return_boxes=True, also return OCR word boxes.
    """

    data = pytesseract.image_to_data(
        image,
        output_type=Output.DICT,
        config="--psm 6"
    )

    groups = defaultdict(list)
    uncertain = []

    for i, raw in enumerate(data["text"]):
        word = raw.strip()

        if not word:
            continue

        try:
            confidence = float(data["conf"][i])
        except (ValueError, TypeError):
            confidence = -1

        if 0 <= confidence < 70:
            uncertain.append({
                "text": word,
                "confidence": confidence
            })

        key = (
            data["block_num"][i],
            data["par_num"][i],
            data["line_num"][i]
        )

        groups[key].append((
            data["left"][i],
            data["top"][i],
            data["width"][i],
            data["height"][i],
            word
        ))

    rows = sorted(
        groups.values(),
        key=lambda group: (
            min(item[1] for item in group),
            min(item[0] for item in group)
        )
    )

    boxes = [
        (x, y, w, h)
        for row in rows
        for x, y, w, h, _ in row
    ]

    if not rows:
        if return_boxes:
            return [], uncertain, boxes

        return [], uncertain

    heights = sorted(
        word[3]
        for row in rows
        for word in row
    )

    char_widths = sorted(
        word[2] / max(1, len(word[4]))
        for row in rows
        for word in row
    )

    line_height = max(
        1,
        heights[len(heights) // 2] * 1.5
    )

    plain = sorted(
        word[2] / len(word[4])
        for row in rows
        for word in row
        if len(word[4]) >= 5
        and word[4].isalnum()
    )

    char_width = max(
        1,
        plain[len(plain) // 2]
        if plain
        else char_widths[len(char_widths) // 2]
    )

    left_origin = min(
        word[0]
        for row in rows
        for word in row
    )

    # v1.2.2 spacing calibration.
    gaps = sorted(
        (b[0] - (a[0] + a[2])) / char_width
        for row in rows
        for a, b in zip(
            sorted(row, key=lambda word: word[0]),
            sorted(row, key=lambda word: word[0])[1:]
        )
    )

    space_extra = (
        max(0, gaps[len(gaps) // 2] - 1)
        if len(gaps) >= 5
        else 0
    )

    lines = []
    previous_y = None

    for row in rows:
        row = sorted(
            row,
            key=lambda word: word[0]
        )

        y = min(word[1] for word in row)

        if previous_y is not None:
            missing = round(
                (y - previous_y) / line_height
            ) - 1

            blank_lines = max(
                0,
                min(12, missing)
            )

            lines.extend([""] * blank_lines)

        previous_y = y
        line = ""
        last_end = None

        for x, _, width, _, word in row:
            if last_end is None:
                line = " " * max(
                    0,
                    round(
                        (x - left_origin) / char_width
                    )
                )
            else:
                gap = (x - last_end) / char_width

                line += " " * max(
                    1,
                    round(gap - space_extra)
                )

            line += word
            last_end = x + width

        lines.append(line)

    if return_boxes:
        return lines, uncertain, boxes

    return lines, uncertain


# ============================================================
# CANVAS HTML
# ============================================================

def render(
    lines,
    kind,
    label,
    background,
    foreground,
    caption=None
):
    escaped_text = html.escape(
        "\n".join(lines)
    )

    bg = rgb_hex(background)
    fg = rgb_hex(foreground)

    white_space = (
        "pre"
        if kind in ("terminal", "code")
        else "pre-wrap"
    )

    caption_html = ""

    if caption:
        caption_html = (
            '<p style="margin:10px 0 0;'
            'color:#202124;'
            'font:14px/1.5 Arial,sans-serif;">'
            + html.escape(caption)
            + "</p>"
        )

    return f'''<div role="figure"
     aria-label="{html.escape(label, quote=True)}"
     style="max-width:100%;min-width:0;margin:0;color:{fg};">

  <div style="max-width:100%;min-width:0;overflow-x:auto;
              background-color:{bg};border:1px solid {fg};
              border-radius:6px;">

    <pre style="margin:0;padding:12px;background-color:{bg};
                color:{fg};border:0;border-radius:0;min-width:0;
                white-space:{white_space};overflow-wrap:normal;
                font:14px/1.5 Consolas,'Courier New',monospace;"><code
       style="padding:0;background-color:transparent;color:{fg};
              border:0;font:inherit;
              white-space:inherit;">{escaped_text}</code></pre>

  </div>

  {caption_html}

</div>'''


# ============================================================
# PUBLIC CONVERSION API — NEW IN v1.2.4
# ============================================================

def convert(
    image_path,
    out=Path("out"),
    kind="terminal",
    label=None,
    caption=None,
    transcript=None
):
    """Convert one local screenshot to Canvas HTML draft files.

    Designed for direct use by a future local Python UI.

    Args:
        image_path: Path to an existing screenshot.
        out: Output directory.
        kind: terminal, code, diagram, or interface.
        label: Optional accessible description.
        caption: Optional visible caption.
        transcript: Optional corrected UTF-8 transcript path.

    Returns:
        Dictionary containing:
            html_file
            transcript_file
            review_file
            preview_file
            html
            review
            ocr_line_count
            low_confidence_count

    File paths are pathlib.Path objects.

    Raises:
        ValueError for an invalid screenshot type.
        FileNotFoundError for missing input files.
        PIL or Tesseract exceptions on processing failures.
    """

    valid_kinds = {
        "terminal",
        "code",
        "diagram",
        "interface"
    }

    if kind not in valid_kinds:
        raise ValueError(
            f"Unknown type {kind!r}. "
            f"Expected one of {sorted(valid_kinds)}"
        )

    image_path = Path(image_path)
    out = Path(out)

    if transcript is not None:
        transcript = Path(transcript)

    if not image_path.is_file():
        raise FileNotFoundError(
            f"Image not found: {image_path}"
        )

    if (
        transcript is not None
        and not transcript.is_file()
    ):
        raise FileNotFoundError(
            f"Transcript not found: {transcript}"
        )

    # --------------------------------------------------------
    # READ IMAGE
    # --------------------------------------------------------

    with Image.open(image_path) as source:
        animated = bool(
            getattr(source, "is_animated", False)
            and getattr(source, "n_frames", 1) > 1
        )

        if animated:
            source.seek(source.n_frames - 1)

        image = ImageOps.exif_transpose(
            source.convert("RGB")
        )

    # --------------------------------------------------------
    # OCR
    # --------------------------------------------------------

    # OCR always runs to provide word boxes for color analysis,
    # even when a corrected transcript is supplied.

    ocr_lines, ocr_uncertain, boxes = extract(
        image,
        return_boxes=True
    )

    if transcript is not None:
        lines = transcript.read_text(
            encoding="utf-8"
        ).split("\n")

        uncertain = []
    else:
        lines = ocr_lines
        uncertain = ocr_uncertain

    # --------------------------------------------------------
    # PRIVACY
    # --------------------------------------------------------

    lines, known_names = sanitize_lines(lines)

    for item in uncertain:
        item["text"] = sanitize_text(
            item["text"],
            known_names
        )

    # --------------------------------------------------------
    # COLORS
    # --------------------------------------------------------

    original_bg, original_fg, secondary_ratio = (
        colors_from_words(image, boxes)
    )

    foreground = fix_contrast(
        original_fg,
        original_bg
    )

    color_warning = (
        kind == "code"
        or secondary_ratio >= 0.3
    )

    color_changes = []

    if foreground != original_fg:
        color_changes.append({
            "element": "text",
            "original": rgb_hex(original_fg),
            "adjusted": rgb_hex(foreground),
            "contrast_after": round(
                contrast(foreground, original_bg),
                2
            )
        })

    # --------------------------------------------------------
    # ACCESSIBILITY METADATA
    # --------------------------------------------------------

    if animated and caption is None:
        caption = (
            "Animated in the original. "
            "This reconstruction shows the final frame."
        )

    if label is None:
        label = (
            f"{kind.capitalize()} screenshot "
            f"showing the content of {image_path.stem}"
        )

    # --------------------------------------------------------
    # RENDER
    # --------------------------------------------------------

    fragment = render(
        lines,
        kind,
        label,
        original_bg,
        foreground,
        caption
    )

    # --------------------------------------------------------
    # OUTPUT PATHS
    # --------------------------------------------------------

    stem = re.sub(
        r"[^\w.-]+",
        "_",
        image_path.stem
    )

    out.mkdir(
        parents=True,
        exist_ok=True
    )

    html_file = out / (
        f"Media_{stem}{image_path.suffix.lower()}.html"
    )

    transcript_file = out / (
        f"{stem}_transcript.txt"
    )

    review_file = out / (
        f"{stem}_review.json"
    )

    preview_file = out / "preview.html"

    # --------------------------------------------------------
    # REVIEW REPORT
    # --------------------------------------------------------

    report = {
        "type": kind,

        "low_confidence_words": uncertain,

        "original_colors": {
            "background": rgb_hex(original_bg),
            "foreground": rgb_hex(original_fg)
        },

        "contrast_changes": color_changes,

        "second_color_ratio": round(
            secondary_ratio,
            2
        ),

        "check_colors_by_hand": color_warning,

        "contrast_ratio": round(
            contrast(foreground, original_bg),
            2
        ),

        "privacy": {
            "home_path_masking": True,
            "learned_email_identity_masking": True,
            "generic_email_replacement": False,
            "manual_review_required": True
        },

        "limitations": [
            "OCR requires character-by-character review",
            "Whitespace reconstruction is approximate",
            "Text color is measured inside OCR word boxes; "
            "multi-colored text uses the most common color",
            "Diagram geometry is not reconstructed",
            "UI controls are not reconstructed",
            "Animated GIFs use their final frame",
            "Username masking is pattern-based and incomplete"
        ]
    }

    # --------------------------------------------------------
    # WRITE OUTPUT FILES
    # --------------------------------------------------------

    html_file.write_text(
        fragment,
        encoding="utf-8"
    )

    transcript_file.write_text(
        "\n".join(lines),
        encoding="utf-8"
    )

    review_file.write_text(
        json.dumps(report, indent=2),
        encoding="utf-8"
    )

    # --------------------------------------------------------
    # COMPARISON PREVIEW
    # --------------------------------------------------------

    # The original screenshot appears in the local preview
    # only, not in the Canvas HTML fragment.

    buffer = io.BytesIO()

    image.save(
        buffer,
        format="PNG"
    )

    embedded = b64encode(
        buffer.getvalue()
    ).decode("ascii")

    preview = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>ImgtoHTML comparison</title>

<style>
body {{
    font-family:Arial,sans-serif;
    margin:12px;
}}

main {{
    display:grid;
    grid-template-columns:repeat(2,minmax(0,1fr));
    gap:16px;
}}

section {{
    min-width:0;
}}

img {{
    max-width:100%;
    height:auto;
}}

@media(max-width:700px) {{
    main {{
        grid-template-columns:1fr;
    }}
}}
</style>
</head>

<body>
<h1>Screenshot versus HTML draft</h1>

<main>
<section>
    <h2>Original</h2>
    <img
        alt="Original screenshot for comparison"
        src="data:image/png;base64,{embedded}">
</section>

<section>
    <h2>Reconstruction</h2>
    {fragment}
</section>
</main>
</body>
</html>'''

    preview_file.write_text(
        preview,
        encoding="utf-8"
    )

    # --------------------------------------------------------
    # RETURN RESULTS TO CALLER
    # --------------------------------------------------------

    return {
        "html_file": html_file,
        "transcript_file": transcript_file,
        "review_file": review_file,
        "preview_file": preview_file,
        "html": fragment,
        "review": report,
        "ocr_line_count": len(lines),
        "low_confidence_count": len(uncertain)
    }


# ============================================================
# COMMAND-LINE INTERFACE
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description=__doc__
    )

    parser.add_argument(
        "image",
        type=Path,
        help="Screenshot or GIF file"
    )

    parser.add_argument(
        "--out",
        type=Path,
        default=Path("out")
    )

    parser.add_argument(
        "--type",
        choices=[
            "terminal",
            "code",
            "diagram",
            "interface"
        ],
        default="terminal"
    )

    parser.add_argument("--label", default=None)
    parser.add_argument("--caption", default=None)
    parser.add_argument("--transcript", type=Path)

    args = parser.parse_args()

    result = convert(
        args.image,
        out=args.out,
        kind=args.type,
        label=args.label,
        caption=args.caption,
        transcript=args.transcript
    )

    report = result["review"]

    print(
        "OCR lines:",
        result["ocr_line_count"]
    )

    print(
        "Low-confidence words:",
        result["low_confidence_count"]
    )

    print(
        "Background:",
        report["original_colors"]["background"]
    )

    print(
        "Original foreground:",
        report["original_colors"]["foreground"]
    )

    rendered_foreground = (
        report["contrast_changes"][0]["adjusted"]
        if report["contrast_changes"]
        else report["original_colors"]["foreground"]
    )

    print(
        "Rendered foreground:",
        rendered_foreground
    )

    if report["check_colors_by_hand"]:
        print(
            "WARNING: screenshot may contain multiple "
            "text colors; check colors by hand."
        )

    print(
        "Output directory:",
        Path(args.out).resolve()
    )

    print("Manual verification required.")


if __name__ == "__main__":
    main()
