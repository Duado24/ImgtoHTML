#!/usr/bin/env python3
"""Local desktop interface for screenshot_to_canvas.convert().

Uses Python's standard-library Tkinter interface.
Image and OCR dependencies remain those of screenshot_to_canvas.py.
No cloud services or uploads.
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
import webbrowser

from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from tkinter.scrolledtext import ScrolledText

from .review_summary import review_summary


SUPPORTED_IMAGES = {
    ".png", ".jpg", ".jpeg", ".gif",
    ".webp", ".bmp", ".tif", ".tiff"
}

KINDS = (
    "terminal",
    "code",
    "diagram",
    "interface"
)


def validate_request(
    image,
    output,
    kind,
    label,
    caption="",
    transcript=""
):
    """Validate inputs and return convert() arguments."""

    image_path = Path(image.strip()).expanduser()
    output_text = output.strip()
    label_text = label.strip()
    transcript_text = transcript.strip()

    if not image.strip() or not image_path.is_file():
        raise ValueError(
            "Select an existing screenshot file."
        )

    if image_path.suffix.lower() not in SUPPORTED_IMAGES:
        raise ValueError(
            "Unsupported image format. "
            "Choose PNG, JPG, GIF, WEBP, BMP, or TIFF."
        )

    if not output_text:
        raise ValueError(
            "Select an output folder."
        )

    if kind not in KINDS:
        raise ValueError(
            "Choose a supported screenshot type."
        )

    if not label_text:
        raise ValueError(
            "Enter a meaningful description "
            "for screen-reader users."
        )

    if (
        transcript_text
        and not Path(transcript_text).expanduser().is_file()
    ):
        raise ValueError(
            "The corrected transcript file does not exist."
        )

    return {
        "image_path": image_path,
        "out": Path(output_text).expanduser(),
        "kind": kind,
        "label": label_text,
        "caption": caption.strip() or None,
        "transcript": (
            Path(transcript_text).expanduser()
            if transcript_text
            else None
        ),
    }


class ImgtoHTMLApp(tk.Tk):

    def __init__(self):
        super().__init__()

        self.title(
            "ImgtoHTML — Local Screenshot Converter"
        )

        self.geometry("1000x770")
        self.minsize(720, 590)

        self.image_var = tk.StringVar()

        self.output_var = tk.StringVar(
            value=str(Path.cwd() / "out")
        )

        self.kind_var = tk.StringVar(
            value="terminal"
        )

        self.label_var = tk.StringVar()
        self.caption_var = tk.StringVar()
        self.transcript_var = tk.StringVar()

        self.status_var = tk.StringVar(
            value=(
                "Select a screenshot and enter "
                "a descriptive label."
            )
        )

        self.result = None
        self.busy = False
        self.messages = queue.Queue()

        self._build()

        self.after(
            120,
            self._poll_messages
        )

        self.protocol(
            "WM_DELETE_WINDOW",
            self._close
        )

    def _build(self):
        """Build the interface."""

        container = ttk.Frame(
            self,
            padding=14
        )

        container.pack(
            fill="both",
            expand=True
        )

        container.columnconfigure(
            1,
            weight=1
        )

        container.rowconfigure(
            9,
            weight=1
        )

        # Header

        heading = ttk.Label(
            container,
            text="ImgtoHTML",
            font=(
                "TkDefaultFont",
                19,
                "bold"
            )
        )

        heading.grid(
            row=0,
            column=0,
            columnspan=3,
            sticky="w",
            pady=(0, 8)
        )

        note = ttk.Label(
            container,
            text=(
                "Runs locally. Outputs are drafts "
                "and require review before being "
                "pasted into Canvas."
            ),
            wraplength=920
        )

        note.grid(
            row=1,
            column=0,
            columnspan=3,
            sticky="w",
            pady=(0, 12)
        )

        # Screenshot selection

        self._file_field(
            container,
            2,
            "Screenshot",
            self.image_var,
            self._browse_image
        )

        # Output directory

        self._file_field(
            container,
            3,
            "Output folder",
            self.output_var,
            self._browse_output
        )

        # Screenshot type

        ttk.Label(
            container,
            text="Screenshot type"
        ).grid(
            row=4,
            column=0,
            sticky="w",
            pady=4
        )

        ttk.Combobox(
            container,
            textvariable=self.kind_var,
            values=KINDS,
            state="readonly",
            width=18
        ).grid(
            row=4,
            column=1,
            sticky="w",
            pady=4
        )

        # Accessible description

        ttk.Label(
            container,
            text="Screen-reader label"
        ).grid(
            row=5,
            column=0,
            sticky="w",
            pady=4
        )

        ttk.Entry(
            container,
            textvariable=self.label_var
        ).grid(
            row=5,
            column=1,
            columnspan=2,
            sticky="ew",
            pady=4
        )

        # Caption

        ttk.Label(
            container,
            text="Caption (optional)"
        ).grid(
            row=6,
            column=0,
            sticky="w",
            pady=4
        )

        ttk.Entry(
            container,
            textvariable=self.caption_var
        ).grid(
            row=6,
            column=1,
            columnspan=2,
            sticky="ew",
            pady=4
        )

        # Optional corrected transcript

        self._file_field(
            container,
            7,
            "Corrected transcript",
            self.transcript_var,
            self._browse_transcript
        )

        # Action buttons

        actions = ttk.Frame(
            container
        )

        actions.grid(
            row=8,
            column=0,
            columnspan=3,
            sticky="ew",
            pady=(12, 8)
        )

        self.convert_button = ttk.Button(
            actions,
            text="Convert screenshot",
            command=self._convert
        )

        self.convert_button.pack(
            side="left",
            padx=(0, 8)
        )

        self.preview_button = ttk.Button(
            actions,
            text="Open local comparison",
            command=self._open_preview,
            state="disabled"
        )

        self.preview_button.pack(
            side="left",
            padx=(0, 8)
        )

        self.copy_button = ttk.Button(
            actions,
            text="Copy Canvas HTML",
            command=self._copy_html,
            state="disabled"
        )

        self.copy_button.pack(
            side="left"
        )

        # Generated HTML and review panels

        outputs = ttk.PanedWindow(
            container,
            orient="vertical"
        )

        outputs.grid(
            row=9,
            column=0,
            columnspan=3,
            sticky="nsew"
        )

        source_frame = ttk.LabelFrame(
            outputs,
            text="Generated Canvas HTML (source)",
            padding=7
        )

        self.code = ScrolledText(
            source_frame,
            wrap="none",
            height=12,
            font=("Courier", 10)
        )

        self.code.pack(
            fill="both",
            expand=True
        )

        self.code.insert(
            "1.0",
            (
                "Generated HTML will appear "
                "here after conversion."
            )
        )

        self.code.configure(
            state="disabled"
        )

        outputs.add(
            source_frame,
            weight=3
        )

        review_frame = ttk.LabelFrame(
            outputs,
            text="Review summary",
            padding=7
        )

        self.review = ScrolledText(
            review_frame,
            wrap="word",
            height=8,
            font=("TkDefaultFont", 10)
        )

        self.review.pack(
            fill="both",
            expand=True
        )

        self.review.configure(
            state="disabled"
        )

        outputs.add(
            review_frame,
            weight=2
        )

        # Status

        ttk.Label(
            container,
            textvariable=self.status_var,
            wraplength=920
        ).grid(
            row=10,
            column=0,
            columnspan=3,
            sticky="w",
            pady=(8, 0)
        )

    def _file_field(
        self,
        parent,
        row,
        title,
        value,
        callback
    ):
        """Create a labeled file selection field."""

        ttk.Label(
            parent,
            text=title
        ).grid(
            row=row,
            column=0,
            sticky="w",
            pady=4,
            padx=(0, 12)
        )

        ttk.Entry(
            parent,
            textvariable=value
        ).grid(
            row=row,
            column=1,
            sticky="ew",
            pady=4
        )

        ttk.Button(
            parent,
            text="Browse",
            command=callback
        ).grid(
            row=row,
            column=2,
            sticky="e",
            pady=4,
            padx=(8, 0)
        )

    def _browse_image(self):
        """Select a screenshot."""

        selected = filedialog.askopenfilename(
            parent=self,
            filetypes=[
                (
                    "Screenshots",
                    "*.png *.jpg *.jpeg *.gif "
                    "*.webp *.bmp *.tif *.tiff"
                ),
                (
                    "All files",
                    "*"
                )
            ]
        )

        if selected:
            self.image_var.set(selected)

    def _browse_output(self):
        """Select the local output directory."""

        selected = filedialog.askdirectory(
            parent=self
        )

        if selected:
            self.output_var.set(selected)

    def _browse_transcript(self):
        """Select a corrected text transcript."""

        selected = filedialog.askopenfilename(
            parent=self,
            filetypes=[
                ("Text files", "*.txt"),
                ("All files", "*")
            ]
        )

        if selected:
            self.transcript_var.set(selected)

    def _set_text(self, widget, value):
        """Update a read-only text area."""

        widget.configure(
            state="normal"
        )

        widget.delete(
            "1.0",
            "end"
        )

        widget.insert(
            "1.0",
            value
        )

        widget.configure(
            state="disabled"
        )

    def _convert(self):
        """Start a conversion without freezing the interface."""

        if self.busy:
            return

        try:
            arguments = validate_request(
                self.image_var.get(),
                self.output_var.get(),
                self.kind_var.get(),
                self.label_var.get(),
                self.caption_var.get(),
                self.transcript_var.get()
            )

        except ValueError as exc:
            messagebox.showerror(
                "Invalid input",
                str(exc),
                parent=self
            )

            return

        self.result = None
        self.busy = True

        self.convert_button.configure(
            state="disabled"
        )

        self.preview_button.configure(
            state="disabled"
        )

        self.copy_button.configure(
            state="disabled"
        )

        self.status_var.set(
            "Processing locally. "
            "OCR and color analysis are running."
        )

        self._set_text(
            self.code,
            ""
        )

        self._set_text(
            self.review,
            ""
        )

        worker = threading.Thread(
            target=self._worker,
            args=(arguments,),
            daemon=True
        )

        worker.start()

    def _worker(self, arguments):
        """Run the existing converter on a worker thread."""

        try:
            from .screenshot_to_canvas import convert

            result = convert(
                **arguments
            )

            self.messages.put(
                ("success", result)
            )

        except Exception as exc:
            self.messages.put(
                (
                    "error",
                    f"{type(exc).__name__}: {exc}"
                )
            )

    def _poll_messages(self):
        """Process worker results on the Tkinter main thread."""

        try:
            while True:
                kind, payload = (
                    self.messages.get_nowait()
                )

                self.busy = False

                self.convert_button.configure(
                    state="normal"
                )

                if kind == "success":
                    self.result = payload

                    self._set_text(
                        self.code,
                        payload["html"]
                    )

                    self._set_text(
                        self.review,
                        review_summary(payload)
                    )

                    self.preview_button.configure(
                        state="normal"
                    )

                    self.copy_button.configure(
                        state="normal"
                    )

                    self.status_var.set(
                        "Draft generated: "
                        f"{payload['html_file']}"
                    )

                else:
                    self.status_var.set(
                        "Conversion failed; "
                        "no output approved."
                    )

                    messagebox.showerror(
                        "Conversion failed",
                        payload,
                        parent=self
                    )

        except queue.Empty:
            pass

        self.after(
            120,
            self._poll_messages
        )

    def _open_preview(self):
        """Open the locally generated comparison in a browser."""

        if not self.result:
            return

        preview = Path(
            self.result["preview_file"]
        ).resolve()

        if not preview.is_file():
            messagebox.showerror(
                "Missing preview",
                "Preview file was not found.",
                parent=self
            )

            return

        opened = webbrowser.open(
            preview.as_uri()
        )

        if not opened:
            messagebox.showwarning(
                "Preview browser",
                (
                    "Open this file locally:\n"
                    f"{preview}"
                ),
                parent=self
            )

    def _copy_html(self):
        """Copy generated Canvas HTML to the clipboard."""

        if not self.result:
            return

        self.clipboard_clear()

        self.clipboard_append(
            self.result["html"]
        )

        self.update_idletasks()

        self.status_var.set(
            "HTML copied. Verify it before "
            "publishing to Canvas."
        )

    def _close(self):
        """Avoid closing while a conversion is running."""

        if self.busy:
            messagebox.showwarning(
                "Conversion in progress",
                (
                    "Finish the current conversion "
                    "before closing."
                ),
                parent=self
            )

            return

        self.destroy()


def main():
    app = ImgtoHTMLApp()
    app.mainloop()


if __name__ == "__main__":
    main()