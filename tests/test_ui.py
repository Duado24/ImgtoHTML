import queue
import sys
import types
import unittest

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from imgtohtml.ui import (
    ImgtoHTMLApp,
    validate_request,
    review_summary
)


class RequestTests(unittest.TestCase):

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

        self.photo = (
            Path(self.tmp.name) / "frame.png"
        )

        # Validation checks file existence and extension.
        # It does not attempt to decode the image.
        self.photo.write_bytes(
            b"placeholder"
        )

    def test_valid_arguments(self):
        data = validate_request(
            str(self.photo),
            self.tmp.name,
            "terminal",
            "Terminal displaying program output"
        )

        self.assertEqual(
            data["image_path"],
            self.photo
        )

        self.assertEqual(
            data["kind"],
            "terminal"
        )

        self.assertIsNone(
            data["transcript"]
        )

    def test_label_is_required(self):
        with self.assertRaisesRegex(
            ValueError,
            "description"
        ):
            validate_request(
                str(self.photo),
                self.tmp.name,
                "terminal",
                "   "
            )

    def test_missing_image_rejected(self):
        with self.assertRaisesRegex(
            ValueError,
            "existing screenshot"
        ):
            validate_request(
                str(self.photo) + "missing",
                self.tmp.name,
                "terminal",
                "Label"
            )

    def test_unsupported_extension_rejected(self):
        path = (
            Path(self.tmp.name) / "file.txt"
        )

        path.write_text(
            "sample"
        )

        with self.assertRaisesRegex(
            ValueError,
            "Unsupported"
        ):
            validate_request(
                str(path),
                self.tmp.name,
                "terminal",
                "Label"
            )

    def test_missing_transcript_rejected(self):
        with self.assertRaisesRegex(
            ValueError,
            "transcript"
        ):
            validate_request(
                str(self.photo),
                self.tmp.name,
                "terminal",
                "Label",
                transcript="missing.txt"
            )

    def test_transcript_is_forwarded(self):
        path = (
            Path(self.tmp.name) / "corrected.txt"
        )

        path.write_text(
            "print('hello')\n"
        )

        args = validate_request(
            str(self.photo),
            self.tmp.name,
            "code",
            "Python code sample",
            transcript=str(path)
        )

        self.assertEqual(
            args["transcript"],
            path
        )

    def test_invalid_type_rejected(self):
        with self.assertRaisesRegex(
            ValueError,
            "supported"
        ):
            validate_request(
                str(self.photo),
                self.tmp.name,
                "other",
                "Label"
            )

    def test_worker_calls_converter_without_network(self):
        # A mocked converter isolates this test
        # from Tesseract, the filesystem output,
        # and any display-server requirements.

        instance = object.__new__(
            ImgtoHTMLApp
        )

        instance.messages = queue.Queue()

        arguments = validate_request(
            str(self.photo),
            self.tmp.name,
            "terminal",
            "Terminal example"
        )

        fake_module = types.SimpleNamespace(
            convert=lambda **kwargs: {
                "html": "<div>example</div>",
                "html_file": (
                    Path(self.tmp.name)
                    / "Media_frame.png.html"
                )
            }
        )

        with patch.dict(
            sys.modules,
            {
                "imgtohtml.screenshot_to_canvas": fake_module
            }
        ):
            ImgtoHTMLApp._worker(
                instance,
                arguments
            )

        status, result = (
            instance.messages.get_nowait()
        )

        self.assertEqual(
            status,
            "success"
        )

        self.assertIn(
            "example",
            result["html"]
        )

    def test_summary_always_warns_about_review(self):
        report = {
            "review": {
                "original_colors": {
                    "background": "#181818",
                    "foreground": "#cccccc"
                },
                "check_colors_by_hand": True,
                "contrast_changes": []
            },
            "ocr_line_count": 4,
            "low_confidence_count": 1
        }

        summary = review_summary(
            report
        )

        self.assertIn(
            "human verification required",
            summary
        )

        self.assertIn(
            "Multiple or syntax",
            summary
        )

        self.assertIn(
            "#cccccc",
            summary
        )

    def test_summary_puts_problems_first(self):
        report = {
            "review": {
                "original_colors": {
                    "background": "#fefefe",
                    "foreground": "#7d7d7d"
                },
                "check_colors_by_hand": True,
                "contrast_changes": [{"adjusted": "#767676"}],
                "low_confidence_words": [
                    {"text": "GPI0"},
                    {"text": "csl04"}
                ]
            },
            "ocr_line_count": 15
        }

        lines = review_summary(report).splitlines()

        self.assertIn("WARNING", lines[1])
        self.assertIn("GPI0, csl04", lines[2])
        self.assertTrue(
            any("#767676 (adjusted from #7d7d7d" in line for line in lines)
        )


if __name__ == "__main__":
    unittest.main()