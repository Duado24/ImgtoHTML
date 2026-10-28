# ImgtoHTML — local screenshot to Canvas HTML

The main application is TypeScript in [web/](web/README.md). A small Node
server performs image decoding and OCR on this computer; the existing browser
UI displays the draft and offers downloads. The server binds only to
**127.0.0.1**. Conversion uses no external services, network models or CDNs.

Compare the original screenshot with the draft before publishing it in Canvas.
OCR, whitespace reconstruction and identity masking still require review.

## Install

Install **Node 20.19+ or 22.12+** (including newer even-numbered releases) and npm.
Install **Tesseract OCR with English language data**, and put tesseract on PATH.
For Ubuntu / WSL:

    sudo apt-get update
    sudo apt-get install tesseract-ocr tesseract-ocr-eng
    node --version
    tesseract --version
    tesseract --list-langs

On macOS, `brew install tesseract` supplies the CLI. On Windows, install a
Tesseract distribution and add its installation directory to PATH, or use WSL.
If the executable is absent, the app automatically uses Tesseract.js **on the
server**, with the English data installed by npm. Python is not required.

    cd web
    npm ci

Dependency installation needs network access. After installation, both OCR
engines and the application operate locally, including the first conversion.

## Run

**One step:** double-click `ImgtoHTML.bat` in Windows Explorer, or in WSL run

    bash web/start.sh        # or: cd web && npm run app

It starts the vision model server (Ollama, from `~/.local/ollama` or PATH) if
it isn't running, rebuilds the app when the code changed, starts it at
http://localhost:3000 and opens the browser. Ctrl+C (or closing the window)
stops what it started. Without Ollama or the model it runs OCR only and says
so. `NO_BROWSER=1` skips the browser; `IMGTOHTML_VISION=off` skips the model.

The vision model is downloaded once (about 6 GB):

    ~/.local/ollama/bin/ollama pull qwen3-vl:8b-instruct-q4_K_M

For development, start the server and Vite together:

    cd web
    npm run dev

Open **http://127.0.0.1:5173**. Vite forwards /api requests to the local Node
server on port 3000. Both listeners bind to 127.0.0.1.

For normal use, build once and serve the client and API together:

    cd web
    npm run build
    npm start

Open **http://127.0.0.1:3000**. Stop with Ctrl+C. Do not run dev and start
at the same time: they use the same API port.

Upload PNG, JPEG, GIF, WebP, BMP or TIFF, up to **25 MB**. GIFs use the final
composited frame. Blank label/caption fields use the converter's defaults.
Edit the transcript and re-convert when needed; OCR still runs to measure
colors. This migration preserves the existing UI design, color logic and
Canvas renderer.

## Output

The UI offers four downloads, preserving the source extension in the HTML name:

    Media_example.gif.html
    example_transcript.txt
    example_review.json
    example_preview.html

Only Media_*.html is the Canvas fragment: inline styles, one div per text
line, and no style/script/pre elements. The comparison page embeds the original
image beside the reconstruction and uses its own local style block. Original
image pixels are not privacy-masked; the transcript, reconstructed text and
review words use the existing home-path and learned-email masking rules.

Jobs/results are held in memory, with bounded queuing and retention. Download
outputs you want to keep; restarting the server clears jobs. Files are not
automatically written to the legacy out/ directory.

## Test

    cd web
    npm test           # Vitest, including Fastify injection tests with mocked OCR
    npm run build      # client/server type checks and production builds
    npm run test:ocr   # optional real CLI + local Tesseract.js smoke test

The optional OCR test requires native Tesseract and English data. The regular
suite does not require the CLI. See [web/README.md](web/README.md) for the API,
architecture and parity coverage.

## Repository layout

    web/src/core/       Pure, browser-free conversion logic (unchanged)
    web/src/browser/    Client API calls
    web/src/main.ts     Existing UI
    web/server/         Fastify, image decoding, job queue and OCR adapters
    web/tests/          Core, image, OCR-interface, client and server tests
    imgtohtml/          Python v1.2.6 reference implementation (preserved)
    tests/             Python reference tests
    docs/              Historical Python documentation

The existing Ollama vision model also detects application layout before rendering.
OCR remains the text source; vision readings provide review alternatives. See
[web/README.md](web/README.md#vision-layout-reconstruction) for browser validation
and the VS Code regression workflow.

## Python reference

The Python implementation remains available for comparison; it is not the
main app. Its CLI, Flask UI (:5000), and Tkinter UI are unchanged:

    python -m pip install -r requirements.txt
    python -m imgtohtml.screenshot_to_canvas example.gif --type terminal
    python -m imgtohtml.web
    python -m imgtohtml.ui
    python -m unittest discover -v
