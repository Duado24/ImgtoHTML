
import unittest
from unittest.mock import patch

from screenshot_to_canvas import extract


def fake_ocr(words):
    """Simulate Tesseract word boxes.

    Each tuple contains:
        (text, left, top, width)
    """
    keys = (
        "text", "conf", "block_num", "par_num",
        "line_num", "left", "top", "width", "height"
    )

    data = {key: [] for key in keys}

    for word, x, y, width in words:
        values = {
            "text": word,
            "conf": "99",
            "block_num": 1,
            "par_num": 1,
            "line_num": 1 if y == 0 else 2,
            "left": x,
            "top": y,
            "width": width,
            "height": 12
        }

        for key in keys:
            data[key].append(values[key])

    return data


class SpacingTests(unittest.TestCase):

    def extract_with_data(self, words):
        data = fake_ocr(words)

        with patch(
            "screenshot_to_canvas.pytesseract.image_to_data",
            return_value=data
        ):
            lines, _ = extract(None)

        return lines

    def test_normal_sentence(self):
        lines = self.extract_with_data([
            ("Welcome", 0, 0, 56),
            ("to", 64, 0, 16),
            ("VitalLink", 88, 0, 72)
        ])

        self.assertEqual(
            lines,
            ["Welcome to VitalLink"]
        )

    def test_no_extra_space(self):
        lines = self.extract_with_data([
            ("signed", 0, 0, 48),
            ("up", 56, 0, 16)
        ])

        self.assertEqual(
            lines,
            ["signed up"]
        )

    def test_wide_gap_preserved(self):
        lines = self.extract_with_data([
            ("signed", 0, 0, 48),
            ("up", 80, 0, 16)
        ])

        self.assertEqual(
            lines,
            ["signed    up"]
        )

    def test_two_spaces_preserved(self):
        lines = self.extract_with_data([
            ("signed", 0, 0, 48),
            ("up", 64, 0, 16)
        ])

        self.assertEqual(
            lines,
            ["signed  up"]
        )

    def test_single_spaces_calibrated(self):
        lines = self.extract_with_data([
            ("print", 0, 0, 40),
            ("the", 51, 0, 24),
            ("total", 86, 0, 40),
            ("of", 137, 0, 16),
            ("all", 164, 0, 24),
            ("items", 199, 0, 40),
            ("x", 0, 20, 8),
            ("=", 19, 20, 8),
            ("1", 38, 20, 8),
            ("#", 65, 20, 8),
            ("note", 84, 20, 32)
        ])

        self.assertEqual(
            lines,
            [
                "print the total of all items",
                "x = 1  # note"
            ]
        )


if __name__ == "__main__":
    unittest.main()
