from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock, patch

import app as converter_app
from signature_probe import (
    SIGNATURE_MARKER,
    Box,
    analyze_pages,
    annotate_markdown,
    find_candidates,
    find_underscore_rules,
)


def chars(text: str, *, x0: float = 0, top: float = 10, width: float = 2, height: float = 3) -> list[dict[str, Any]]:
    return [
        {
            "text": char,
            "x0": x0 + index * width,
            "x1": x0 + (index + 1) * width,
            "top": top,
            "bottom": top + height,
        }
        for index, char in enumerate(text)
    ]


def word(text: str, **kwargs: Any) -> dict[str, Any]:
    return {"text": text, "chars": chars(text, **kwargs)}


def image(x0: float, top: float, x1: float, bottom: float) -> dict[str, float]:
    return {"x0": x0, "top": top, "x1": x1, "bottom": bottom}


class FakePage:
    def __init__(self, page_number: int, words: list[dict[str, Any]], images: list[dict[str, float]]) -> None:
        self.page_number = page_number
        self._words = words
        self.images = images

    def extract_words(self, **kwargs: Any) -> list[dict[str, Any]]:
        assert kwargs == {"keep_blank_chars": True, "return_chars": True}
        return self._words


class RuleDetectionTests(unittest.TestCase):
    def test_finds_only_long_consecutive_underscore_runs(self) -> None:
        words = [word("20_2_5"), word("_" * 11), word("prefix" + "_" * 12 + "suffix", x0=50)]

        rules = find_underscore_rules(words)

        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0], Box(x0=62, top=10, x1=86, bottom=13))

    def test_separates_multiple_runs_in_one_word(self) -> None:
        rules = find_underscore_rules([word("_" * 12 + " " + "_" * 13)])

        self.assertEqual(len(rules), 2)


class CandidateTests(unittest.TestCase):
    def test_reports_an_image_that_overlaps_a_rule(self) -> None:
        rule = Box(x0=20, top=50, x1=120, bottom=60)

        candidates = find_candidates(
            page_number=3,
            rules=[rule],
            images=[image(35, 20, 100, 58)],
        )

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].page, 3)
        self.assertEqual(candidates[0].image_horizontal_overlap_ratio, 1)
        self.assertEqual(candidates[0].rule_horizontal_overlap_ratio, 0.65)
        self.assertGreater(candidates[0].vertical_overlap_ratio, 0)

    def test_unsigned_rule_has_no_candidate(self) -> None:
        candidates = find_candidates(page_number=1, rules=[Box(0, 10, 40, 15)], images=[])

        self.assertEqual(candidates, [])

    def test_unrelated_logo_above_the_rule_has_no_candidate(self) -> None:
        candidates = find_candidates(
            page_number=1,
            rules=[Box(20, 50, 120, 60)],
            images=[image(35, 5, 100, 40)],
        )

        self.assertEqual(candidates, [])

    def test_small_horizontal_intersection_is_not_substantial(self) -> None:
        candidates = find_candidates(
            page_number=1,
            rules=[Box(20, 50, 120, 60)],
            images=[image(115, 40, 140, 55)],
        )

        self.assertEqual(candidates, [])

    def test_uses_one_best_image_per_rule(self) -> None:
        candidates = find_candidates(
            page_number=1,
            rules=[Box(20, 50, 120, 60)],
            images=[image(30, 55, 90, 70), image(25, 45, 115, 60)],
        )

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].image, Box(25, 45, 115, 60))


class AnalysisTests(unittest.TestCase):
    def test_aggregates_multiple_pages_and_signature_blocks(self) -> None:
        pages = [
            FakePage(1, [word("_" * 12, x0=20, top=50)], []),
            FakePage(
                2,
                [word("_" * 12, x0=20, top=50), word("_" * 16, x0=20, top=100)],
                [image(25, 45, 40, 53), image(25, 95, 45, 103)],
            ),
        ]

        result = analyze_pages(pages)

        self.assertEqual(result["pages_scanned"], 2)
        self.assertEqual(result["rules_found"], 3)
        self.assertEqual(result["signature_candidates"], 2)
        self.assertEqual([candidate["page"] for candidate in result["candidates"]], [2, 2])

    def test_json_output_contains_geometry_but_no_document_content(self) -> None:
        result = analyze_pages(
            [FakePage(1, [word("_" * 12, x0=20, top=50)], [image(25, 45, 40, 53)])]
        )

        encoded = json.dumps(result)
        self.assertIn('"rule_bbox"', encoded)
        self.assertIn('"image_bbox"', encoded)
        self.assertNotIn('"text"', encoded)
        self.assertNotIn('"image"', encoded)


class MarkdownAnnotationTests(unittest.TestCase):
    def test_replaces_only_rules_with_signature_candidates(self) -> None:
        unsigned = "_" * 12
        signed = "_" * 16

        markdown = annotate_markdown(f"Unsigned: {unsigned}\nSigned: {signed}", [False, True])

        self.assertEqual(markdown, f"Unsigned: {unsigned}\nSigned: {SIGNATURE_MARKER}")

    def test_handles_markdown_escaped_underscore_rules(self) -> None:
        escaped_rule = r"\_\_\_\_\_\_\_\_\_\_\_\_"

        markdown = annotate_markdown(f"Signature: {escaped_rule}", [True])

        self.assertEqual(markdown, f"Signature: {SIGNATURE_MARKER}")

    def test_rule_count_mismatch_preserves_markdown_exactly(self) -> None:
        markdown = "Signature: " + "_" * 12

        self.assertIs(annotate_markdown(markdown, []), markdown)
        self.assertIs(annotate_markdown(markdown, [True, True]), markdown)

    def test_marker_does_not_claim_identity_or_authenticity(self) -> None:
        markdown = annotate_markdown("_" * 12, [True])

        self.assertEqual(markdown, "[signature-like mark present]")
        self.assertNotIn("signed by", markdown.lower())
        self.assertNotIn("valid", markdown.lower())


class ConverterIntegrationTests(unittest.TestCase):
    def test_non_pdf_conversion_skips_signature_annotation(self) -> None:
        converter = Mock()
        converter.convert_stream.return_value = SimpleNamespace(text_content="Signature: " + "_" * 12)

        with (
            patch("markitdown.MarkItDown", return_value=converter),
            patch("signature_probe.annotate_pdf_markdown") as annotate,
        ):
            markdown = converter_app._markitdown_markdown(b"plain text", "note.txt")

        self.assertEqual(markdown, "Signature: " + "_" * 12)
        annotate.assert_not_called()

    def test_probe_failure_preserves_pdf_markdown_without_logging_filename(self) -> None:
        original = "Signature: " + "_" * 12
        converter = Mock()
        converter.convert_stream.return_value = SimpleNamespace(text_content=original)
        output = io.StringIO()

        with (
            patch("markitdown.MarkItDown", return_value=converter),
            patch("signature_probe.annotate_pdf_markdown", side_effect=RuntimeError("private content")),
            redirect_stdout(output),
        ):
            markdown = converter_app._markitdown_markdown(b"pdf bytes", "private-agreement.pdf")

        self.assertEqual(markdown, original)
        self.assertIn("RuntimeError", output.getvalue())
        self.assertNotIn("private-agreement.pdf", output.getvalue())
        self.assertNotIn("private content", output.getvalue())


if __name__ == "__main__":
    unittest.main()
