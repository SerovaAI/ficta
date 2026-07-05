"""Span normalization and merge policy shared by detectors and tests."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

BIO_PREFIX = re.compile(r"^(?:B|I|E|S|U|L)-", re.IGNORECASE)
NON_ENTITY_CHAR = re.compile(r"[^A-Za-z0-9]+")

MEDICAL_KEYWORDS = {
    "BENEFICIARY",
    "CLINIC",
    "CLINICAL",
    "DIAGNOSIS",
    "DOCTOR",
    "HEALTH",
    "HOSPITAL",
    "INSURANCE",
    "MEDICAL",
    "MEDICATION",
    "MRN",
    "NPI",
    "PATIENT",
    "PHYSICIAN",
    "PROVIDER",
    "RECORD",
}


@dataclass(frozen=True)
class Span:
    entity_type: str
    start: int
    end: int
    score: float
    source: str

    def to_presidio(self) -> dict[str, float | int | str]:
        return {
            "entity_type": self.entity_type,
            "start": self.start,
            "end": self.end,
            "score": self.score,
        }


def normalize_entity_type(label: str) -> str:
    """Normalize model labels such as B-first_name into Presidio-style names."""
    stripped = BIO_PREFIX.sub("", label.strip())
    normalized = NON_ENTITY_CHAR.sub("_", stripped).strip("_").upper()
    return normalized or "UNKNOWN"


def filter_spans(
    spans: Iterable[Span],
    *,
    score_threshold: float,
    entities: list[str] | None,
) -> list[Span]:
    allowlist = {normalize_entity_type(entity) for entity in entities or []}
    out: list[Span] = []
    for span in spans:
        if span.score < score_threshold:
            continue
        if allowlist and normalize_entity_type(span.entity_type) not in allowlist:
            continue
        if span.start < 0 or span.end <= span.start:
            continue
        out.append(
            Span(
                entity_type=normalize_entity_type(span.entity_type),
                start=span.start,
                end=span.end,
                score=span.score,
                source=span.source,
            )
        )
    return out


def merge_spans(spans: Iterable[Span], *, score_epsilon: float = 0.05) -> list[Span]:
    """Deduplicate and resolve overlaps.

    Exact duplicates keep the highest score. Overlap conflicts prefer clearly
    higher confidence; when confidence is comparable, medical-specific labels
    win, then longer spans win.
    """
    by_exact: dict[tuple[int, int, str], Span] = {}
    for span in spans:
        key = (span.start, span.end, normalize_entity_type(span.entity_type))
        current = by_exact.get(key)
        if current is None or span.score > current.score:
            by_exact[key] = span

    accepted: list[Span] = []
    for candidate in sorted(by_exact.values(), key=lambda s: (s.start, -(s.end - s.start), -s.score)):
        overlaps = [span for span in accepted if spans_overlap(candidate, span)]
        if not overlaps:
            accepted.append(candidate)
            continue

        if any(prefer_span(existing, candidate, score_epsilon=score_epsilon) is existing for existing in overlaps):
            continue

        accepted = [span for span in accepted if span not in overlaps]
        accepted.append(candidate)

    return sorted(accepted, key=lambda s: (s.start, s.end, s.entity_type))


def spans_overlap(a: Span, b: Span) -> bool:
    return a.start < b.end and b.start < a.end


def prefer_span(a: Span, b: Span, *, score_epsilon: float) -> Span:
    if a.score > b.score + score_epsilon:
        return a
    if b.score > a.score + score_epsilon:
        return b

    a_medical = is_medical_specific(a.entity_type)
    b_medical = is_medical_specific(b.entity_type)
    if a_medical and not b_medical:
        return a
    if b_medical and not a_medical:
        return b

    a_len = a.end - a.start
    b_len = b.end - b.start
    if a_len != b_len:
        return a if a_len > b_len else b

    if a.score != b.score:
        return a if a.score > b.score else b
    return a if a.source <= b.source else b


def is_medical_specific(entity_type: str) -> bool:
    parts = set(normalize_entity_type(entity_type).split("_"))
    return bool(parts & MEDICAL_KEYWORDS)
