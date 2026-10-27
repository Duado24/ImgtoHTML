import io
import unittest

from pathlib import Path
from tempfile import TemporaryDirectory

from imgtohtml.web import create_app


class FakeConverter:
    """Stands in for convert(): records the call, writes a transcript."""

    def __init__(self):
        self.calls = []

    def __call__(self, image_path, out, kind, label, caption, transcript):
        self.calls.append({
            "image_name": Path(image_path).name,
            "image_bytes": Path(image_path).read_bytes(),
            "kind": kind,
            "label": label,
            "caption": caption,
            "transcript_text": (
                Path(transcript).read_text(encoding="utf-8")
                if transcript else None
            ),
        })
        out.mkdir(parents=True, exist_ok=True)
        transcript_file = out / "frame_transcript.txt"
        transcript_file.write_text("line one\n\nline three", encoding="utf-8")
        return {
            "html": '<div role="figure">example</div>',
            "html_file": out / "Media_frame.png.html",
            "transcript_file": transcript_file,
            "ocr_line_count": 3,
            "low_confidence_count": 1,
            "review": {
                "original_colors": {"background": "#181818", "foreground": "#cccccc"},
                "contrast_changes": [],
                "contrast_ratio": 11.06,
                "check_colors_by_hand": True,
                "low_confidence_words": [{"text": "csl04", "confidence": 41}],
            },
        }


class WebTests(unittest.TestCase):

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake = FakeConverter()
        app = create_app(out_dir=self.tmp.name, converter=self.fake)
        app.config["TESTING"] = True
        self.client = app.test_client()

    def post(self, filename="frame.png", **fields):
        data = {"kind": "terminal", "label": "Terminal output", **fields}
        if filename:
            data["image"] = (io.BytesIO(b"fake image bytes"), filename)
        return self.client.post("/api/convert", data=data,
                                content_type="multipart/form-data")

    def test_page_loads(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b"ImgtoHTML", page.data)

    def test_converts_and_returns_results(self):
        res = self.post()
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertIn("example", body["html"])
        self.assertEqual(body["transcript"], "line one\n\nline three")
        self.assertEqual(body["stats"]["lines"], 3)
        self.assertEqual(self.fake.calls[0]["image_bytes"], b"fake image bytes")

    def test_problems_listed_with_words(self):
        issues = self.post().get_json()["issues"]
        levels = [i["level"] for i in issues]
        self.assertIn("warn", levels)
        self.assertEqual(issues[-1]["words"], ["csl04"])

    def test_label_required(self):
        res = self.post(label="   ")
        self.assertEqual(res.status_code, 400)
        self.assertIn("screen-reader label", res.get_json()["error"])
        self.assertEqual(self.fake.calls, [])

    def test_missing_image(self):
        self.assertEqual(self.post(filename=None).status_code, 400)

    def test_unsupported_format(self):
        res = self.post(filename="notes.txt")
        self.assertEqual(res.status_code, 400)
        self.assertIn("Unsupported", res.get_json()["error"])

    def test_bad_type(self):
        self.assertEqual(self.post(kind="photo").status_code, 400)

    def test_edited_transcript_is_passed_on(self):
        self.post(transcript="fixed line\r\nsecond")
        self.assertEqual(self.fake.calls[0]["transcript_text"], "fixed line\nsecond")

    def test_blank_caption_means_not_given(self):
        self.post(caption="   ")
        self.assertIsNone(self.fake.calls[0]["caption"])

    def test_unsafe_file_name_cleaned(self):
        self.post(filename="../../etc/evil name.png")
        self.assertEqual(self.fake.calls[0]["image_name"], "etc_evil_name.png")

    def test_converter_errors_reported(self):
        def broken(*args, **kwargs):
            raise RuntimeError("Tesseract is not installed")
        app = create_app(out_dir=self.tmp.name, converter=broken)
        res = app.test_client().post(
            "/api/convert",
            data={"kind": "terminal", "label": "x",
                  "image": (io.BytesIO(b"x"), "a.png")},
            content_type="multipart/form-data")
        self.assertEqual(res.status_code, 500)
        self.assertIn("Tesseract is not installed", res.get_json()["error"])


if __name__ == "__main__":
    unittest.main()