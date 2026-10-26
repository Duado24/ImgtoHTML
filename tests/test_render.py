import unittest
from html.parser import HTMLParser

from imgtohtml.screenshot_to_canvas import render


class LineCollector(HTMLParser):
    """Collect the text of each line <div> (the divs nested two deep)."""

    def __init__(self):
        super().__init__()
        self.depth = 0
        self.lines = []
        self.styles = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag == "div":
            self.depth += 1
            if self.depth == 3:
                self.current = ""
                self.styles.append(dict(attrs).get("style", ""))

    def handle_endtag(self, tag):
        if tag == "div":
            if self.depth == 3:
                self.lines.append(self.current)
                self.current = None
            self.depth -= 1

    def handle_data(self, data):
        if self.current is not None:
            self.current += data


def lines_of(fragment):
    parser = LineCollector()
    parser.feed(fragment)
    return parser.lines, parser.styles


SAMPLE = [
    "Welcome to VitalLink! Let's get you signed up.",
    "",
    "    indented <tag> & \"quotes\"",
    "",
    "Thank you for signing up!",
]


def make(kind="terminal", caption=None):
    return render(SAMPLE, kind, "A label", (0x18,) * 3, (0xcc,) * 3, caption)


class RenderTests(unittest.TestCase):

    def test_one_div_per_line_text_intact(self):
        lines, _ = lines_of(make())
        self.assertEqual(lines, SAMPLE)

    def test_no_pre_block_for_canvas_to_split(self):
        self.assertNotIn("<pre", make())

    def test_blank_lines_kept_as_empty_lines(self):
        self.assertEqual(make().count("<br></div>"), 2)

    def test_html_characters_escaped(self):
        self.assertIn("&lt;tag&gt; &amp;", make())

    def test_terminal_wraps_with_hanging_indent(self):
        _, styles = lines_of(make("terminal"))
        self.assertTrue(all("pre-wrap" in s and "text-indent:-2ch" in s for s in styles))
        self.assertNotIn("overflow-x:auto", make("terminal"))

    def test_code_never_wraps_and_scrolls_in_its_box(self):
        _, styles = lines_of(make("code"))
        self.assertTrue(all("white-space:pre;" in s for s in styles))
        self.assertIn("overflow-x:auto", make("code"))

    def test_caption_outside_the_text_box(self):
        fragment = make(caption="Animated in the original.")
        self.assertIn("Animated in the original.</p>", fragment)
        self.assertLess(fragment.index("Thank you"), fragment.index("<p "))


if __name__ == "__main__":
    unittest.main()