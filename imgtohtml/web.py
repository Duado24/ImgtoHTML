#!/usr/bin/env python3
"""ImgtoHTML local web interface.

Start it with:
    python -m imgtohtml.web

It serves one page on http://127.0.0.1:5000 (this computer only),
opens it in your browser, and calls convert() for each screenshot.
Nothing is uploaded anywhere: "upload" here means your browser
handing the file to this program on your own machine.
"""

from __future__ import annotations

import argparse
import tempfile
import threading
import webbrowser

from pathlib import Path

from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename


SUPPORTED_IMAGES = {
    ".png", ".jpg", ".jpeg", ".gif",
    ".webp", ".bmp", ".tif", ".tiff"
}

KINDS = ("terminal", "code", "diagram", "interface")

MAX_UPLOAD_MB = 25


class RequestError(ValueError):
    """A problem with what the user submitted (shown to them as-is)."""


def validate_form(form, files):
    """Check the submitted form. Returns cleaned values or raises
    RequestError with a message meant for the user."""

    image = files.get("image")

    if image is None or not image.filename:
        raise RequestError("Choose a screenshot to convert.")

    suffix = Path(image.filename).suffix.lower()

    if suffix not in SUPPORTED_IMAGES:
        raise RequestError(
            "Unsupported image format. "
            "Use PNG, JPG, GIF, WEBP, BMP, or TIFF."
        )

    kind = form.get("kind", "terminal")

    if kind not in KINDS:
        raise RequestError("Choose a supported screenshot type.")

    label = form.get("label", "").strip()

    if not label:
        raise RequestError(
            "Enter a screen-reader label: one sentence describing "
            "what the screenshot shows."
        )

    return {
        "image": image,
        "filename": secure_filename(image.filename) or f"screenshot{suffix}",
        "kind": kind,
        "label": label,
        "caption": form.get("caption", "").strip() or None,
        "transcript": form.get("transcript", ""),
    }


def summarize(result):
    """Turn convert()'s result into what the page displays."""

    report = result["review"]
    colors = report["original_colors"]
    changes = report["contrast_changes"]

    issues = []

    if report.get("check_colors_by_hand"):
        issues.append({
            "level": "warn",
            "text": "Several text colors in the original; "
                    "the HTML uses one. Check colors by hand."
        })

    if changes:
        issues.append({
            "level": "info",
            "text": f"Text color adjusted from {changes[0]['original']} "
                    f"to {changes[0]['adjusted']} for contrast."
        })

    words = [w["text"] for w in report.get("low_confidence_words", [])]

    if words:
        issues.append({
            "level": "error",
            "text": f"{len(words)} low-confidence words — check these first.",
            "words": words
        })

    return {
        "html": result["html"],
        "transcript": result["transcript_file"].read_text(encoding="utf-8"),
        "html_file": str(result["html_file"]),
        "stats": {
            "lines": result["ocr_line_count"],
            "low_confidence": result["low_confidence_count"],
            "contrast": report["contrast_ratio"],
            "background": colors["background"],
            "foreground": (
                changes[0]["adjusted"] if changes else colors["foreground"]
            ),
        },
        "issues": issues,
    }


def create_app(out_dir=None, converter=None):
    """Build the Flask app.

    out_dir:   where convert() writes its files.
    converter: the convert() function (tests pass a fake one).
    """

    if converter is None:
        from imgtohtml.screenshot_to_canvas import convert as converter

    out_dir = Path(out_dir or Path.cwd() / "out").expanduser().resolve()

    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
    app.config["OUT_DIR"] = out_dir

    @app.get("/")
    def index():
        return render_template(
            "index.html",
            kinds=KINDS,
            out_dir=str(out_dir),
            max_mb=MAX_UPLOAD_MB,
        )

    @app.post("/api/convert")
    def api_convert():
        try:
            form = validate_form(request.form, request.files)
        except RequestError as exc:
            return jsonify(error=str(exc)), 400

        with tempfile.TemporaryDirectory() as tmp:
            # convert() names its output after the image file,
            # so keep the original (made-safe) file name.
            image_path = Path(tmp) / form["filename"]
            form["image"].save(image_path)

            transcript_path = None

            if form["transcript"].strip():
                transcript_path = Path(tmp) / "corrected_transcript.txt"
                transcript_path.write_text(
                    form["transcript"].replace("\r\n", "\n"),
                    encoding="utf-8"
                )

            try:
                result = converter(
                    image_path,
                    out=out_dir,
                    kind=form["kind"],
                    label=form["label"],
                    caption=form["caption"],
                    transcript=transcript_path,
                )
            except Exception as exc:  # shown to the user, not hidden
                return jsonify(
                    error=f"Conversion failed: {type(exc).__name__}: {exc}"
                ), 500

            return jsonify(summarize(result))

    @app.errorhandler(413)
    def too_large(_):
        return jsonify(
            error=f"That file is larger than {MAX_UPLOAD_MB} MB."
        ), 413

    return app


def main():
    parser = argparse.ArgumentParser(description="ImgtoHTML local web interface")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--out", type=Path, default=Path.cwd() / "out",
                        help="folder for the generated files (default: ./out)")
    parser.add_argument("--no-browser", action="store_true",
                        help="don't open the browser automatically")
    args = parser.parse_args()

    app = create_app(out_dir=args.out)
    url = f"http://127.0.0.1:{args.port}"

    print(f"ImgtoHTML running at {url}  (this computer only)")
    print(f"Output folder: {app.config['OUT_DIR']}")
    print("Press Ctrl+C to stop.")

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    # 127.0.0.1 = reachable only from this computer.
    app.run(host="127.0.0.1", port=args.port, debug=False)


if __name__ == "__main__":
    main()