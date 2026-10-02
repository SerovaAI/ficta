"""Tests for same-span entity precedence (``span_precedence.py``).

The unit tests need only presidio-analyzer. The registry tests build Presidio's AnalyzerEngine from
the shipped registry file and the same spaCy model the sidecar uses, so they need the derived image.
Run them inside the image with the package and registry mounted::

    docker run --rm -w /app \\
      -v "$PWD/packages/ficta/presidio/ficta_presidio:/app/ficta_presidio:ro" \\
      -v "$PWD/packages/ficta/presidio/default_recognizers.yaml:/app/ficta-presidio-recognizers.yaml:ro" \\
      --entrypoint python ficta-presidio:dev -m unittest ficta_presidio.test_span_precedence

Every ID number here is synthetic: a made-up date and sequence with a computed Luhn check digit.
"""

import itertools
import os
import unittest
from pathlib import Path

from presidio_analyzer import AnalyzerEngine, RecognizerResult
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_analyzer.recognizer_registry import RecognizerRegistryProvider

from . import span_precedence

THRESHOLD = 0.5


def with_luhn_check_digit(prefix: str) -> str:
    """Append the digit that makes ``prefix`` + digit pass the Luhn checksum."""
    for check in "0123456789":
        digits = [int(d) for d in prefix + check]
        total = 0
        for index, digit in enumerate(reversed(digits)):
            if index % 2 == 1:
                digit *= 2
                if digit > 9:
                    digit -= 9
            total += digit
        if total % 10 == 0:
            return prefix + check
    raise AssertionError("unreachable")


# YYMMDD 450101 (a past date), sequence 5009, citizen 0, legacy digit 8, Luhn check digit.
ZA_ID = with_luhn_check_digit("450101500908")
# Same shape, but month 13 is not a date: Luhn-valid, so a card match, but not a valid ID.
NOT_AN_ID = with_luhn_check_digit("451301500908")


def result(entity, start=3, end=16, score=1.0):
    return RecognizerResult(entity_type=entity, start=start, end=end, score=score)


class ApplyPrecedenceTest(unittest.TestCase):
    def test_id_beats_card_on_the_same_span_in_any_order(self):
        for order in itertools.permutations([result("CREDIT_CARD"), result("ZA_ID_NUMBER")]):
            kept = span_precedence.apply_precedence(order)
            self.assertEqual([r.entity_type for r in kept], ["ZA_ID_NUMBER"])

    def test_card_alone_is_kept(self):
        kept = span_precedence.apply_precedence([result("CREDIT_CARD")])
        self.assertEqual([r.entity_type for r in kept], ["CREDIT_CARD"])

    def test_overlapping_but_different_spans_are_both_kept(self):
        kept = span_precedence.apply_precedence([result("CREDIT_CARD", 3, 22), result("ZA_ID_NUMBER", 3, 16)])
        self.assertEqual(sorted(r.entity_type for r in kept), ["CREDIT_CARD", "ZA_ID_NUMBER"])

    def test_unrelated_entities_on_the_same_span_are_untouched(self):
        kept = span_precedence.apply_precedence([result("PHONE_NUMBER"), result("ZA_ID_NUMBER")])
        self.assertEqual(sorted(r.entity_type for r in kept), ["PHONE_NUMBER", "ZA_ID_NUMBER"])


def _registry_path() -> Path:
    for candidate in (
        os.environ.get("FICTA_PRESIDIO_REGISTRY_FILE"),
        "/app/ficta-presidio-recognizers.yaml",
        Path(__file__).resolve().parent.parent / "default_recognizers.yaml",
    ):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise unittest.SkipTest("default_recognizers.yaml is not available")


class RegistryPrecedenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        nlp_engine = NlpEngineProvider(
            nlp_configuration={
                "nlp_engine_name": "spacy",
                "models": [{"lang_code": "en", "model_name": "en_core_web_lg"}],
            }
        ).create_engine()
        registry = RecognizerRegistryProvider(conf_file=_registry_path(), nlp_engine=nlp_engine).create_recognizer_registry()
        registry.remove_recognizer("SpacyRecognizer")
        cls.analyzer = AnalyzerEngine(registry=registry, nlp_engine=nlp_engine, supported_languages=["en"])
        span_precedence.install(cls.analyzer)

    def entities(self, text, value):
        start = text.index(value)
        results = self.analyzer.analyze(text=text, language="en", score_threshold=THRESHOLD)
        return sorted(r.entity_type for r in results if (r.start, r.end) == (start, start + len(value)))

    def test_valid_za_id_is_reported_only_as_an_id(self):
        for text in (f"ID {ZA_ID} on file", f"card {ZA_ID}", ZA_ID):
            self.assertEqual(self.entities(text, ZA_ID), ["ZA_ID_NUMBER"], text)

    def test_luhn_valid_13_digits_with_an_invalid_date_stays_a_card(self):
        self.assertEqual(self.entities(f"card {NOT_AN_ID}", NOT_AN_ID), ["CREDIT_CARD"])

    def test_sixteen_digit_card_is_unaffected(self):
        card = "4111 1111 1111 1111"
        self.assertEqual(self.entities(f"card {card}", card), ["CREDIT_CARD"])


if __name__ == "__main__":
    unittest.main()
