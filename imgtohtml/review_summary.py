def review_summary(result):
    """Generate a conservative summary of conversion results.

    Problems that need action come first, so they are visible
    without scrolling.
    """

    report = result.get("review", {})
    colors = report.get("original_colors", {})
    changes = report.get("contrast_changes", [])

    lines = ["STATUS: Draft; human verification required."]

    if report.get("check_colors_by_hand"):
        lines.append(
            "WARNING: Multiple or syntax text colors "
            "may be missing; check colors by hand."
        )

    words = [
        item.get("text", "")
        for item in report.get("low_confidence_words", [])
    ]

    if words:
        lines.append(
            f"Check these {len(words)} low-confidence words first: "
            + ", ".join(words)
        )

    rendered = (
        changes[0]["adjusted"]
        if changes
        else colors.get("foreground", "unknown")
    )

    lines.extend([
        f"OCR lines: {result.get('ocr_line_count', 'unknown')}",
        f"Background: {colors.get('background', 'unknown')}",
        f"Text color used: {rendered}"
        + (
            f" (adjusted from {colors.get('foreground')} for contrast)"
            if changes
            else ""
        ),
        "Check every character, space, path, "
        "username, and color against the image.",
        "Code, diagrams, and interface elements "
        "are not fully reconstructed.",
        "The comparison page is local; "
        "it is not a Canvas accessibility test.",
    ])

    return "\n".join(lines)