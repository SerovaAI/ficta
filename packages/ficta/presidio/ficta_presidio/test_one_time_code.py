"""Registry tests for FictaOneTimeCodeRecognizer in ``default_recognizers.yaml``.

These build Presidio's AnalyzerEngine from the shipped registry file and the same spaCy model the
sidecar uses, so they need the derived image (or an environment with presidio-analyzer and
``en_core_web_lg``). Run them inside the image with the package and registry mounted::

    docker run --rm -w /app \\
      -v "$PWD/packages/ficta/presidio/ficta_presidio:/app/ficta_presidio:ro" \\
      -v "$PWD/packages/ficta/presidio/default_recognizers.yaml:/app/ficta-presidio-recognizers.yaml:ro" \\
      --entrypoint python ficta-presidio:dev -m unittest ficta_presidio.test_one_time_code
"""

import os
import unittest
from pathlib import Path

from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.context_aware_enhancers import LemmaContextAwareEnhancer
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_analyzer.recognizer_registry import RecognizerRegistryProvider

# Ficta's request threshold: spans scoring below it never leave the sidecar as redactions.
THRESHOLD = 0.5


def _registry_path() -> Path:
    for candidate in (
        os.environ.get("FICTA_PRESIDIO_REGISTRY_FILE"),
        "/app/ficta-presidio-recognizers.yaml",
        Path(__file__).resolve().parent.parent / "default_recognizers.yaml",
    ):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise unittest.SkipTest("default_recognizers.yaml is not available")


class OneTimeCodeRecognizerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        nlp_engine = NlpEngineProvider(
            nlp_configuration={
                "nlp_engine_name": "spacy",
                "models": [{"lang_code": "en", "model_name": "en_core_web_lg"}],
            }
        ).create_engine()
        registry = RecognizerRegistryProvider(conf_file=_registry_path(), nlp_engine=nlp_engine).create_recognizer_registry()
        # As in service.py: raw spaCy NER never leaves the sidecar ungated, so leave it out here too.
        registry.remove_recognizer("SpacyRecognizer")
        cls.analyzer = AnalyzerEngine(registry=registry, nlp_engine=nlp_engine, supported_languages=["en"])

    def spans(self, text, entity):
        results = self.analyzer.analyze(text=text, language="en", entities=[entity], score_threshold=THRESHOLD)
        return sorted(text[result.start : result.end] for result in results)

    def codes(self, text):
        return self.spans(text, "ONE_TIME_CODE")

    def test_detects_labelled_codes_in_english_and_german(self):
        cases = {
            "verification code 7731": ["7731"],
            "Your one-time PIN: 55120931": ["55120931"],
            "Your OTP is 902114, do not share it.": ["902114"],
            "2FA code: 118342": ["118342"],
            "Enter passcode 4417 to continue": ["4417"],
            "Code: 6620. It expires in 10 minutes.": ["6620"],
            "Ihr Code lautet 4821": ["4821"],
            "TAN: 482913": ["482913"],
            "Ihr Bestätigungscode: 5521": ["5521"],
            "Ihr Bestaetigungscode: 5521": ["5521"],
            "Einmalcode 77341": ["77341"],
            "Einmalpasswort: 993120": ["993120"],
            "Sicherheitscode 4410": ["4410"],
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(self.codes(text), expected)

    def test_detects_a_label_that_follows_the_code(self):
        self.assertEqual(self.codes("7731 is your verification code"), ["7731"])
        self.assertEqual(self.codes("4821 ist Ihr Code"), ["4821"])

    def test_leaves_unlabelled_and_formatted_numbers_alone(self):
        # Must stay byte-identical end to end, so nothing in the whole registry may claim them.
        for text in (
            "Order 7731 ships Monday",
            "Budget 2027 is 48000",
            "ref 62004418871",
            "Termin am 01.10.2026",
            "48.000 €",
            "1.250,00 EUR",
            "10115 Berlin",
        ):
            with self.subTest(text=text):
                results = self.analyzer.analyze(text=text, language="en", score_threshold=THRESHOLD)
                self.assertEqual([text[r.start : r.end] for r in results], [])

    def test_ignores_code_numbers_in_legal_and_postal_text(self):
        for text in (
            "Civil Procedure Code 1908",
            "under the Code, section 2045 applies",
            "see Labour Code s 1872",
            "The Code was amended in 2019 and again in 2021",
            "Section 1234 of the Internal Revenue Code",
            "postal code 2196",
            "zip code 10115",
            "branch code 250655",
            "error code 4040",
            "In our opinion 2024 was decisive",
            "Standard Bank 250655",
            "Tan paid 4500 on signature",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.codes(text), [])

    def test_context_enhancer_only_reads_words_before_the_match(self):
        # Presidio's default LemmaContextAwareEnhancer looks 5 words back and 0 forward, so a
        # context word AFTER a number never boosts it. FictaAccountNumberRecognizer (context-gated,
        # base 0.3) shows the effect: "account" before the number admits it, after it does not.
        # That is why the one-time-code recognizer carries its trailing-label form in its own regex.
        enhancer = LemmaContextAwareEnhancer()
        self.assertEqual(enhancer.context_prefix_count, 5)
        self.assertEqual(enhancer.context_suffix_count, 0)
        self.assertEqual(self.spans("account 9434765919", "ACCOUNT_NUMBER"), ["9434765919"])
        self.assertEqual(self.spans("9434765919 account", "ACCOUNT_NUMBER"), [])

    def test_context_enhancer_matches_context_words_as_substrings(self):
        # The enhancer's default matching mode is substring, so a short context word fires inside
        # an unrelated one ("bank" inside "Bankleitzahl" below). Short OTP words such as `tan` or
        # `pin` would fire inside "Standard" or "opinion"; the one-time-code recognizer therefore
        # requires its label on a word boundary in the regex instead of listing context words.
        self.assertEqual(LemmaContextAwareEnhancer().context_matching_mode, "substring")
        results = self.analyzer.analyze(
            text="Bankleitzahl 37040044", language="en", entities=["US_BANK_NUMBER"], return_decision_process=True
        )
        self.assertTrue(any(r.analysis_explanation.supportive_context_word == "bank" for r in results))


if __name__ == "__main__":
    unittest.main()
