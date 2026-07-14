"""Presidio recognizers for identity and attribution in business documents.

The recognizers deliberately return final identity candidates rather than exposing raw
PERSON/ORGANIZATION/DATE/LOCATION NER output to Ficta. Structured Presidio recognizers remain
independent and are unaffected.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

from presidio_analyzer import AnalysisExplanation, LocalRecognizer, RecognizerResult
from presidio_analyzer.predefined_recognizers import GLiNERRecognizer


IDENTITY_ENTITIES = ["PERSON", "ORGANIZATION", "DATE_TIME", "LOCATION", "COMPANY_REGISTRATION"]
DATE_OF_BIRTH_CUE = re.compile(r"\b(?:date of birth|birth date|d\.o\.b\.?|dob|born)\b", re.I)
DOB_FIELD = re.compile(
    r"\b(?:date of birth|birth date|d\.o\.b\.?|dob|born)\b\s*[:#-]?\s*("
    r"(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[A-Za-z]{3,9}\s+\d{4})|"
    r"(?:[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})|"
    r"(?:\d{4}[-/]\d{1,2}[-/]\d{1,2})|(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4})"
    r")",
    re.I,
)
PERSONAL_ADDRESS_CUE = re.compile(
    r"\b(?:home|residential|postal|physical|street) address\b|\bresides? at\b", re.I
)
PERSON_CUE = re.compile(
    r"\b(?:signed by|signatory|represented by|representative|director|witness|contact person|attorney)\b|"
    r"\b(?:person|employee|director|signatory|representative|witness|contact)\s+name\b",
    re.I,
)
ORGANIZATION_CUE = re.compile(
    r"\b(?:company|corporation|organisation|organization|registered|registration|borrower|lender|employer|vendor|customer|party|between)\b|\bfor\s*:",
    re.I,
)

NON_IDENTITY_ROLE_WORDS = {
    "agreement",
    "authorisation",
    "authorisations",
    "authorization",
    "authorizations",
    "borrower",
    "clause",
    "court",
    "creditor",
    "debtor",
    "interest",
    "lender",
    "notice",
    "party",
}

LEGAL_CONCEPT_HEADS = {"interest", "sum"}
COURT_WORDS = {"court", "tribunal"}
NON_IDENTITY_FIELD_CUE = re.compile(
    r"\b(?:project|matter|product|facility|access|reference|clause)\s+"
    r"(?:name|code|number|id)\s*[:#-]?\s*$",
    re.I,
)

ORGANIZATION_PREFIX_STOPS = NON_IDENTITY_ROLE_WORDS | {
    "account",
    "against",
    "and",
    "as",
    "between",
    "by",
    "for",
    "from",
    "known",
    "of",
    "to",
}

BUSINESS_DESIGNATORS = {
    "advisory",
    "bank",
    "biologics",
    "capital",
    "cc",
    "company",
    "corp",
    "corporation",
    "consulting",
    "enterprises",
    "finance",
    "foundation",
    "fund",
    "fzco",
    "group",
    "holdings",
    "inc",
    "incorporated",
    "industries",
    "investment",
    "investments",
    "limited",
    "llc",
    "llp",
    "logistics",
    "ltd",
    "management",
    "partners",
    "plc",
    "properties",
    "pty",
    "resources",
    "services",
    "solutions",
    "supplies",
    "systems",
    "technologies",
    "technology",
    "trust",
    "ventures",
}

LEGAL_ENTITY_DESIGNATORS = {
    "cc",
    "company",
    "corp",
    "corporation",
    "fzco",
    "inc",
    "incorporated",
    "limited",
    "llc",
    "llp",
    "ltd",
    "plc",
    "pty",
}

WORD = re.compile(r"[^\W\d_][\w'’.-]*", re.UNICODE)
LETTER_SPACED = re.compile(r"(?:[^\W\d_][ \t]+){3,}[^\W\d_](?:[ \t]+[^\W\d_])*", re.UNICODE)
COMPANY_REGISTRATION = re.compile(
    r"\b(?:company\s+)?reg(?:istration)?(?:\s+(?:number|no\.?))\s*[:#-]?\s*(?:[A-Z][A-Za-z]{2,20}\s+)?([A-Z0-9][A-Z0-9/-]{4,29})\b",
    re.I,
)
OCR_COMPANY_REGISTRATION = re.compile(
    r"\b(?:company\s+)?reg(?:istration)?(?:\s+(?:number|no\.?))\s*[:#-]?\s*((?:\d[ \t]*){5,})",
    re.I,
)
TRANSACTION_HEADER = re.compile(r"\b(?:counterparty|customer|description|details|payee|transaction|vendor)\b", re.I)
AMOUNT_HEADER = re.compile(r"\b(?:amount|balance|credit|debit|payment)\b", re.I)
DATE_FIELD = re.compile(
    r"^(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})$",
    re.I,
)


@dataclass(frozen=True)
class Candidate:
    entity_type: str
    start: int
    end: int
    score: float


class _FictaIdentityMixin:
    """Apply the same final-candidate policy to spaCy and GLiNER evidence."""

    name: str

    def _finalize(self, text: str, candidates: Iterable[Candidate], entities: list[str]) -> list[RecognizerResult]:
        requested = set(entities or IDENTITY_ENTITIES)
        raw = [candidate for candidate in candidates if candidate.entity_type in requested]
        accepted = [candidate for candidate in raw if _accepts_identity_candidate(text, candidate)]

        known_person_words = {
            _normalize_word(word)
            for candidate in accepted
            if candidate.entity_type == "PERSON" and len(_words(text[candidate.start : candidate.end])) > 1
            for word in _words(text[candidate.start : candidate.end])
        }
        for candidate in raw:
            if candidate in accepted or candidate.entity_type != "PERSON":
                continue
            words = _words(text[candidate.start : candidate.end])
            if len(words) == 1 and _normalize_word(words[0]) in known_person_words:
                accepted.append(candidate)

        if "COMPANY_REGISTRATION" in requested:
            accepted.extend(_company_registrations(text))
        if "DATE_TIME" in requested:
            accepted.extend(_birth_dates(text))
        if "ORGANIZATION" in requested:
            accepted.extend(_designator_organizations(text))
            accepted.extend(_tabular_organizations(text))
            accepted.extend(_linked_single_word_organization_aliases(text, raw, accepted))
            accepted.extend(_organization_aliases(text, accepted))
        accepted.extend(_ocr_identity_fields(text, requested))
        return [_result(self.name, candidate) for candidate in _dedupe(accepted)]


class FictaSpacyIdentityRecognizer(_FictaIdentityMixin, LocalRecognizer):
    """Use spaCy spans from Presidio's NLP artifacts, admitting identity contexts only."""

    def __init__(self) -> None:
        super().__init__(supported_entities=IDENTITY_ENTITIES, supported_language="en", name="FictaSpacyIdentityRecognizer")

    def load(self) -> None:
        pass

    def analyze(self, text: str, entities: list[str], nlp_artifacts=None) -> list[RecognizerResult]:
        if not nlp_artifacts:
            return self._finalize(text, [], entities)
        candidates = [
            Candidate(span.label_, span.start_char, span.end_char, float(score))
            for span, score in zip(nlp_artifacts.entities, nlp_artifacts.scores)
            if span.label_ in IDENTITY_ENTITIES
        ]
        return self._finalize(text, candidates, entities)


class FictaGlinerIdentityRecognizer(_FictaIdentityMixin, GLiNERRecognizer):
    """Optional GLiNER candidate source used by the benchmark/reference sidecar."""

    def __init__(self, model_name: str, threshold: float) -> None:
        super().__init__(
            name="FictaGlinerIdentityRecognizer",
            model_name=model_name,
            entity_mapping={
                "person": "PERSON",
                "name": "PERSON",
                "organization": "ORGANIZATION",
                "company": "ORGANIZATION",
                "date": "DATE_TIME",
                "location": "LOCATION",
                "address": "LOCATION",
            },
            flat_ner=True,
            multi_label=False,
            threshold=threshold,
            map_location="cpu",
        )
        self.supported_entities.append("COMPANY_REGISTRATION")

    def analyze(self, text: str, entities: list[str], nlp_artifacts=None) -> list[RecognizerResult]:
        raw = super().analyze(text, entities, nlp_artifacts)
        candidates = [Candidate(item.entity_type, item.start, item.end, float(item.score)) for item in raw]
        return self._finalize(text, candidates, entities)


def _accepts_identity_candidate(text: str, candidate: Candidate) -> bool:
    value = text[candidate.start : candidate.end]
    if candidate.entity_type == "PERSON":
        return _accepts_person(text, candidate, value)
    if candidate.entity_type == "ORGANIZATION":
        return _accepts_organization(text, candidate, value)
    if candidate.entity_type == "DATE_TIME":
        return bool(DATE_OF_BIRTH_CUE.search(_context_before_on_line(text, candidate.start)))
    if candidate.entity_type == "LOCATION":
        return bool(PERSONAL_ADDRESS_CUE.search(_context_before_on_line(text, candidate.start)))
    return False


def _accepts_person(text: str, candidate: Candidate, value: str) -> bool:
    words = _words(value)
    context = _context_before_on_line(text, candidate.start)
    if not words or _is_non_identity_phrase(words) or NON_IDENTITY_FIELD_CUE.search(context):
        return False
    if PERSON_CUE.search(context):
        return len(words) <= 7
    return 2 <= len(words) <= 6 and all(_is_name_word(word) for word in words)


def _accepts_organization(text: str, candidate: Candidate, value: str) -> bool:
    words = _words(value)
    if not words:
        return False
    normalized = [_normalize_word(word) for word in words]
    context = _context_before_on_line(text, candidate.start)
    if NON_IDENTITY_FIELD_CUE.search(context):
        return False
    # An explicit terminal company designator is stronger identity evidence than an ambiguous
    # word inside the name (for example, "Security" in "Northstar Security Ltd").
    if len(words) >= 2 and normalized[-1] in BUSINESS_DESIGNATORS:
        return True
    if _is_non_identity_phrase(words):
        return False
    if "and" in normalized:
        connector = normalized.index("and")
        left = {word for word in normalized[:connector] if word != "the" and word not in BUSINESS_DESIGNATORS}
        right = {word for word in normalized[connector + 1 :] if word != "the" and word not in BUSINESS_DESIGNATORS}
        if left & right:
            return False
    if any(word in BUSINESS_DESIGNATORS for word in normalized):
        return True
    if ORGANIZATION_CUE.search(context):
        return len(words) <= 10
    letters = "".join(character for character in value if character.isalpha())
    return 2 <= len(words) <= 8 and all(_is_name_word(word) for word in words) and len(letters) > 1 and letters.isupper()


def _is_non_identity_phrase(words: list[str]) -> bool:
    """Reject roles and legal concepts without vetoing those words inside explicit company names."""
    normalized = [_normalize_word(word) for word in words]
    if any(word in COURT_WORDS for word in normalized):
        return True
    if normalized[-1] in LEGAL_CONCEPT_HEADS:
        return True
    return any(word in NON_IDENTITY_ROLE_WORDS for word in normalized)


def _company_registrations(text: str) -> list[Candidate]:
    out: list[Candidate] = []
    for regex in (COMPANY_REGISTRATION, OCR_COMPANY_REGISTRATION):
        for match in regex.finditer(text):
            value = match.group(1).strip()
            if not any(character.isdigit() for character in value):
                continue
            start = match.start(1) + (len(match.group(1)) - len(match.group(1).lstrip()))
            out.append(Candidate("COMPANY_REGISTRATION", start, start + len(value), 0.9))
    return out


def _birth_dates(text: str) -> list[Candidate]:
    return [Candidate("DATE_TIME", match.start(1), match.end(1), 0.9) for match in DOB_FIELD.finditer(text)]


def _designator_organizations(text: str) -> list[Candidate]:
    out: list[Candidate] = []
    for segment in re.finditer(r"[^\t,;:!?()[\]{}|\r\n]+", text):
        words = list(WORD.finditer(segment.group(0)))
        for index, word in enumerate(words):
            if _normalize_word(word.group(0)) not in BUSINESS_DESIGNATORS:
                continue
            start_index = index - 1
            while start_index >= 0 and index - start_index <= 7:
                normalized = _normalize_word(words[start_index].group(0))
                if normalized in ORGANIZATION_PREFIX_STOPS or not _is_name_word(words[start_index].group(0)):
                    break
                start_index -= 1
            start_index += 1
            if start_index >= index:
                continue
            start = segment.start() + words[start_index].start()
            end = segment.start() + word.end()
            out.append(Candidate("ORGANIZATION", start, end, 0.9))
    return out


def _organization_aliases(text: str, accepted: Iterable[Candidate]) -> list[Candidate]:
    stems: set[str] = set()
    for candidate in accepted:
        if candidate.entity_type != "ORGANIZATION":
            continue
        words = [word for word in _words(text[candidate.start : candidate.end]) if _normalize_word(word) != "the" and _normalize_word(word) not in BUSINESS_DESIGNATORS]
        if words:
            stems.add(r"\s+".join(re.escape(word) for word in words))

    out: list[Candidate] = []
    suffixes = "|".join(sorted((re.escape(value) for value in BUSINESS_DESIGNATORS), key=len, reverse=True))
    for stem in stems:
        # Link only the full non-designator stem. First-word matching is too weak for names whose
        # opening word is also ordinary language (for example, "Blue").
        regex = re.compile(rf"\b(?:The\s+{stem}|{stem}\s+(?:{suffixes}))\b", re.I)
        for match in regex.finditer(text):
            out.append(Candidate("ORGANIZATION", match.start(), match.end(), 0.9))
    return out


def _linked_single_word_organization_aliases(
    text: str, raw: Iterable[Candidate], accepted: Iterable[Candidate]
) -> list[Candidate]:
    """Admit repeated NER aliases which uniquely name a fuller organization in this document."""
    full_organizations = [
        candidate
        for candidate in accepted
        if candidate.entity_type == "ORGANIZATION"
        and len(_words(text[candidate.start : candidate.end])) > 1
    ]

    canonical_by_alias: dict[str, set[tuple[str, ...]]] = {}
    for candidate in full_organizations:
        words = [_normalize_word(word) for word in _words(text[candidate.start : candidate.end])]
        if words and words[0] == "the":
            words = words[1:]
        while words and words[-1] in LEGAL_ENTITY_DESIGNATORS:
            words.pop()
        identity = tuple(words)
        if identity:
            canonical_by_alias.setdefault(identity[0], set()).add(identity)

    singleton_by_alias: dict[str, dict[tuple[int, int], Candidate]] = {}
    for candidate in raw:
        if candidate.entity_type != "ORGANIZATION":
            continue
        words = _words(text[candidate.start : candidate.end])
        if len(words) != 1:
            continue
        if any(
            organization.start <= candidate.start and candidate.end <= organization.end
            for organization in full_organizations
        ):
            continue
        alias = _normalize_word(words[0])
        singleton_by_alias.setdefault(alias, {})[(candidate.start, candidate.end)] = candidate

    out: list[Candidate] = []
    for alias, candidates in singleton_by_alias.items():
        if len(candidates) >= 2 and len(canonical_by_alias.get(alias, ())) == 1:
            out.extend(candidates.values())
    return out


def _ocr_identity_fields(text: str, requested: set[str]) -> list[Candidate]:
    out: list[Candidate] = []
    for line_match in re.finditer(r"[^\r\n]*", text):
        line = line_match.group(0)
        if not line:
            continue
        person = "PERSON" in requested and bool(PERSON_CUE.search(line))
        organization = "ORGANIZATION" in requested and bool(ORGANIZATION_CUE.search(line))
        if not person and not organization:
            continue
        for spaced in LETTER_SPACED.finditer(line):
            if len(re.sub(r"[ \t]+", "", spaced.group(0))) < 4:
                continue
            entity_type = "ORGANIZATION" if organization else "PERSON"
            out.append(Candidate(entity_type, line_match.start() + spaced.start(), line_match.start() + spaced.end(), 0.9))
    return out


def _tabular_organizations(text: str) -> list[Candidate]:
    out: list[Candidate] = []
    in_transaction_table = False
    offset = 0
    for line_with_end in text.splitlines(keepends=True):
        line = line_with_end.rstrip("\r\n")
        if "\t" in line and TRANSACTION_HEADER.search(line) and AMOUNT_HEADER.search(line):
            in_transaction_table = True
            offset += len(line_with_end)
            continue
        if in_transaction_table and "\t" in line:
            fields = line.split("\t")
            if len(fields) >= 2 and DATE_FIELD.match(fields[0].strip()):
                candidate = fields[1].strip()
                words = _words(candidate)
                if 2 <= len(words) <= 8 and _normalize_word(words[-1]) in BUSINESS_DESIGNATORS and all(_is_name_word(word) for word in words):
                    start = offset + line.index(fields[1]) + (len(fields[1]) - len(fields[1].lstrip()))
                    out.append(Candidate("ORGANIZATION", start, start + len(candidate), 0.65))
        offset += len(line_with_end)
    return out


def _result(recognizer_name: str, candidate: Candidate) -> RecognizerResult:
    explanation = AnalysisExplanation(
        recognizer=recognizer_name,
        original_score=candidate.score,
        textual_explanation="Identity candidate admitted by Ficta's Presidio recognizer",
    )
    return RecognizerResult(
        entity_type=candidate.entity_type,
        start=candidate.start,
        end=candidate.end,
        score=candidate.score,
        analysis_explanation=explanation,
    )


def _context_before_on_line(text: str, start: int) -> str:
    line_start = max(text.rfind("\n", 0, start) + 1, start - 160)
    context = text[line_start:start]
    sentence_boundary = max(context.rfind("."), context.rfind(";"))
    return context[sentence_boundary + 1 :]


def _words(value: str) -> list[str]:
    return WORD.findall(value)


def _normalize_word(value: str) -> str:
    return unicodedata.normalize("NFKC", value).lower().rstrip(".'’")


def _is_name_word(word: str) -> bool:
    normalized = _normalize_word(word)
    if normalized in {"and", "of", "the"}:
        return True
    letters = "".join(character for character in word if character.isalpha())
    return bool(letters) and (letters.isupper() or letters[0].isupper())


def _dedupe(candidates: Iterable[Candidate]) -> list[Candidate]:
    out: list[Candidate] = []
    seen: set[tuple[str, int, int]] = set()
    for candidate in candidates:
        key = (candidate.entity_type, candidate.start, candidate.end)
        if candidate.start < 0 or candidate.end <= candidate.start or key in seen:
            continue
        seen.add(key)
        out.append(candidate)
    return out
