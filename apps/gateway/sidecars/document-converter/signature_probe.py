"""Local diagnostic for image-backed signature candidates in PDFs.

This module deliberately does not decide whether a document was signed. It only
reports long underscore rules that overlap an embedded PDF image. The output is
geometry-only so running the probe never copies document text or image data into
logs or diagnostic artifacts.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Mapping, Sequence

import pdfplumber

MIN_RULE_LENGTH = 12
MIN_RULE_HORIZONTAL_OVERLAP_RATIO = 0.3
MIN_IMAGE_HORIZONTAL_OVERLAP_RATIO = 0.5
OUTPUT_SCHEMA_VERSION = 1
SIGNATURE_MARKER = "[signature-like mark present]"
MARKDOWN_RULE_PATTERN = re.compile(r"(?:(?:\\_){12,}|_{12,})")


@dataclass(frozen=True)
class Box:
    x0: float
    top: float
    x1: float
    bottom: float

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> Box | None:
        try:
            box = cls(
                x0=float(value["x0"]),
                top=float(value["top"]),
                x1=float(value["x1"]),
                bottom=float(value["bottom"]),
            )
        except (KeyError, TypeError, ValueError):
            return None
        return box if box.width > 0 and box.height > 0 else None

    @classmethod
    def enclosing(cls, values: Sequence[Mapping[str, Any]]) -> Box | None:
        boxes = [box for value in values if (box := cls.from_mapping(value)) is not None]
        if not boxes:
            return None
        return cls(
            x0=min(box.x0 for box in boxes),
            top=min(box.top for box in boxes),
            x1=max(box.x1 for box in boxes),
            bottom=max(box.bottom for box in boxes),
        )

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.bottom - self.top

    def horizontal_overlap(self, other: Box) -> float:
        return max(0.0, min(self.x1, other.x1) - max(self.x0, other.x0))

    def vertical_overlap_ratio(self, other: Box) -> float:
        overlap = max(0.0, min(self.bottom, other.bottom) - max(self.top, other.top))
        return overlap / min(self.height, other.height)

    def to_json(self) -> dict[str, float]:
        return {
            "x0": round(self.x0, 3),
            "top": round(self.top, 3),
            "x1": round(self.x1, 3),
            "bottom": round(self.bottom, 3),
        }


@dataclass(frozen=True)
class Candidate:
    page: int
    rule: Box
    image: Box
    rule_horizontal_overlap_ratio: float
    image_horizontal_overlap_ratio: float
    vertical_overlap_ratio: float

    def to_json(self) -> dict[str, Any]:
        return {
            "page": self.page,
            "rule_bbox": self.rule.to_json(),
            "image_bbox": self.image.to_json(),
            "rule_horizontal_overlap_ratio": round(self.rule_horizontal_overlap_ratio, 3),
            "image_horizontal_overlap_ratio": round(self.image_horizontal_overlap_ratio, 3),
            "vertical_overlap_ratio": round(self.vertical_overlap_ratio, 3),
        }


@dataclass(frozen=True)
class RuleObservation:
    page: int
    rule: Box
    candidate: Candidate | None

    @property
    def has_signature_candidate(self) -> bool:
        return self.candidate is not None


def find_underscore_rules(
    words: Iterable[Mapping[str, Any]], min_rule_length: int = MIN_RULE_LENGTH
) -> list[Box]:
    """Return exact boxes for long, consecutive underscore character runs."""

    rules: list[Box] = []
    for word in words:
        chars = word.get("chars")
        if not isinstance(chars, list):
            continue

        run: list[Mapping[str, Any]] = []
        for char in chars:
            if isinstance(char, Mapping) and char.get("text") == "_":
                run.append(char)
                continue
            _append_rule(rules, run, min_rule_length)
            run = []
        _append_rule(rules, run, min_rule_length)
    return rules


def find_candidates(
    *, page_number: int, rules: Sequence[Box], images: Iterable[Mapping[str, Any]]
) -> list[Candidate]:
    """Return at most one best overlapping image candidate per rule."""

    image_boxes = [box for image in images if (box := Box.from_mapping(image)) is not None]
    candidates: list[Candidate] = []

    for rule in rules:
        matches: list[Candidate] = []
        for image in image_boxes:
            horizontal_overlap = rule.horizontal_overlap(image)
            rule_horizontal = horizontal_overlap / rule.width
            image_horizontal = horizontal_overlap / image.width
            vertical = rule.vertical_overlap_ratio(image)
            if (
                rule_horizontal < MIN_RULE_HORIZONTAL_OVERLAP_RATIO
                or image_horizontal < MIN_IMAGE_HORIZONTAL_OVERLAP_RATIO
                or vertical <= 0
            ):
                continue
            matches.append(
                Candidate(
                    page=page_number,
                    rule=rule,
                    image=image,
                    rule_horizontal_overlap_ratio=rule_horizontal,
                    image_horizontal_overlap_ratio=image_horizontal,
                    vertical_overlap_ratio=vertical,
                )
            )
        if matches:
            candidates.append(
                max(
                    matches,
                    key=lambda candidate: (
                        candidate.rule_horizontal_overlap_ratio,
                        candidate.image_horizontal_overlap_ratio,
                        candidate.vertical_overlap_ratio,
                    ),
                )
            )
    return candidates


def scan_pages(pages: Iterable[Any]) -> tuple[int, list[RuleObservation]]:
    observations: list[RuleObservation] = []
    pages_scanned = 0

    for fallback_page_number, page in enumerate(pages, start=1):
        pages_scanned += 1
        page_number = int(getattr(page, "page_number", fallback_page_number))
        words = page.extract_words(keep_blank_chars=True, return_chars=True)
        rules = sorted(find_underscore_rules(words), key=lambda rule: (rule.top, rule.x0))
        candidates = find_candidates(page_number=page_number, rules=rules, images=page.images)
        candidates_by_rule = {candidate.rule: candidate for candidate in candidates}
        observations.extend(
            RuleObservation(page=page_number, rule=rule, candidate=candidates_by_rule.get(rule))
            for rule in rules
        )
    return pages_scanned, observations


def analyze_pages(pages: Iterable[Any]) -> dict[str, Any]:
    pages_scanned, observations = scan_pages(pages)
    candidates = [observation.candidate for observation in observations if observation.candidate is not None]

    return {
        "schema_version": OUTPUT_SCHEMA_VERSION,
        "pages_scanned": pages_scanned,
        "rules_found": len(observations),
        "signature_candidates": len(candidates),
        "candidates": [candidate.to_json() for candidate in candidates],
    }


def analyze_pdf(source: str | Path | BinaryIO) -> dict[str, Any]:
    with pdfplumber.open(source) as pdf:
        return analyze_pages(pdf.pages)


def annotate_pdf_markdown(markdown: str, source: str | Path | BinaryIO) -> str:
    """Replace only geometrically matched rules, or return Markdown unchanged."""

    with pdfplumber.open(source) as pdf:
        _, observations = scan_pages(pdf.pages)
    states = [observation.has_signature_candidate for observation in observations]
    return annotate_markdown(markdown, states)


def annotate_markdown(markdown: str, signature_states: Sequence[bool]) -> str:
    """Map ordered PDF rule states to Markdown, failing closed on any mismatch."""

    matches = list(MARKDOWN_RULE_PATTERN.finditer(markdown))
    if len(matches) != len(signature_states):
        return markdown

    state_index = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal state_index
        has_signature_candidate = signature_states[state_index]
        state_index += 1
        return SIGNATURE_MARKER if has_signature_candidate else match.group(0)

    return MARKDOWN_RULE_PATTERN.sub(replace, markdown)


def _append_rule(rules: list[Box], run: Sequence[Mapping[str, Any]], minimum: int) -> None:
    if len(run) < minimum:
        return
    box = Box.enclosing(run)
    if box is not None:
        rules.append(box)


def _open_source(path: str) -> str | io.BytesIO:
    if path == "-":
        return io.BytesIO(sys.stdin.buffer.read())
    return path


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report image-overlapped underscore rules without extracting document content."
    )
    parser.add_argument("pdf", help="PDF path, or - to read PDF bytes from standard input")
    args = parser.parse_args(argv)

    try:
        result = analyze_pdf(_open_source(args.pdf))
    except Exception as exc:  # noqa: BLE001 - CLI boundary intentionally emits only a safe error class
        print(f"signature probe failed: {type(exc).__name__}", file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
