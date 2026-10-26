import unittest

from PIL import Image, ImageDraw

from imgtohtml.screenshot_to_canvas import colors_from_words, rgb_hex


def screenshot(background, text_color, decoration=None):
    """A small fake screenshot: a block of 'text' and an optional
    colored ring (like a red highlight circle) outside the text box."""
    image = Image.new("RGB", (200, 60), background)
    draw = ImageDraw.Draw(image)

    # The "letters": solid text color with a blurred-edge border.
    draw.rectangle((20, 20, 99, 39), fill=text_color)
    edge = tuple((a + b) // 2 for a, b in zip(text_color, background))
    draw.rectangle((19, 19, 100, 40), outline=edge)

    if decoration:
        # Lots of decoration pixels, but outside the word box.
        draw.ellipse((110, 2, 196, 58), outline=decoration, width=6)

    box = (19, 19, 82, 22)  # x, y, width, height of the OCR word box
    return image, [box]


class ColorTests(unittest.TestCase):

    def test_dark_terminal_exact_text_color(self):
        image, boxes = screenshot((0x18, 0x18, 0x18), (0xcc, 0xcc, 0xcc))
        bg, fg, _ = colors_from_words(image, boxes)
        self.assertEqual(rgb_hex(bg), "#181818")
        self.assertEqual(rgb_hex(fg), "#cccccc")

    def test_red_circle_is_ignored(self):
        image, boxes = screenshot(
            (0xff, 0xff, 0xff), (0x00, 0x80, 0x00), decoration=(0xe0, 0x00, 0x00)
        )
        bg, fg, _ = colors_from_words(image, boxes)
        self.assertEqual(rgb_hex(fg), "#008000")

    def test_no_rounding(self):
        image, boxes = screenshot((0x1e, 0x1e, 0x1e), (0xd4, 0xd4, 0xd4))
        _, fg, _ = colors_from_words(image, boxes)
        self.assertEqual(rgb_hex(fg), "#d4d4d4")

    def test_no_words_falls_back(self):
        image, _ = screenshot((0x18, 0x18, 0x18), (0xcc, 0xcc, 0xcc))
        bg, fg, _ = colors_from_words(image, [])
        self.assertEqual(rgb_hex(bg), "#181818")  # still finds a background

    def test_one_color_text_no_second_color(self):
        image, boxes = screenshot((0x18, 0x18, 0x18), (0xcc, 0xcc, 0xcc))
        _, _, second = colors_from_words(image, boxes)
        self.assertLess(second, 0.3)

    def test_mixed_colors_detected(self):
        image = Image.new("RGB", (200, 40), (0xff, 0xff, 0xff))
        draw = ImageDraw.Draw(image)
        for i, color in enumerate([(0xaf, 0x00, 0xdb), (0x00, 0x80, 0x00),
                                   (0xa3, 0x15, 0x15), (0x00, 0x00, 0xff)]):
            draw.rectangle((10 + 45 * i, 10, 50 + 45 * i, 29), fill=color)
        _, _, second = colors_from_words(image, [(10, 10, 180, 20)])
        self.assertGreaterEqual(second, 0.3)


if __name__ == "__main__":
    unittest.main()