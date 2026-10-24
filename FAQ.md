# AutoCanv FAQ — v1.1

**Does the script require an AI API?**

No. OCR runs locally with Tesseract and Pillow.

**Does it preserve every character from a screenshot?**

Not automatically. OCR can misread characters and infer incorrect spaces or blank lines. The transcript must be verified against the source.

**Does it preserve screenshot colors?**

It estimates dominant foreground and background colors. It does not yet reproduce multiple syntax colors or all interface colors.

**What happens when contrast is too low?**

The script adjusts estimated foreground lightness toward the nearest passing value while holding hue and saturation constant. Changes are listed in the JSON report.

**Are usernames protected?**

Common home-directory paths and email-style identities are masked. Other personal information can remain. Manual privacy review is mandatory.

**Does it support animated GIFs?**

It processes the last frame and adds a caption explaining that limitation. Earlier frames are not transcribed.

**Does it reconstruct diagrams?**

No. The diagram mode currently extracts readable text only. Shapes, arrows, and relationships require separate reconstruction.

**Does it reconstruct application interfaces?**

No. It extracts text but does not recreate actual interface controls or layouts.

**Does code wrap on phones?**

Terminal and code text retain line structure and scroll horizontally inside their own panel.

**Has the script passed its Canvas regression suite?**

No. Local syntax and OCR tests have been completed, but the approved GIF baseline and actual Canvas rendering have not been verified.

**Does ImgtoHTML preserve spaces and indentation exactly?**

Not automatically. Version 1.2.1 estimates character width from longer alphanumeric words and uses actual gaps between OCR word boxes to reconstruct spaces. This reduces unwanted double spaces in ordinary text while retaining wider gaps and leading indentation where detectable.

The algorithm cannot reliably distinguish every intentional space from OCR geometry. All code, commands, and instructional text must be checked against the original screenshot before publication.

**Has the approved 4.2 GIF been verified?**

No. The approved output regression has not been executed against version 1.2.1. This version is not approved for production use.