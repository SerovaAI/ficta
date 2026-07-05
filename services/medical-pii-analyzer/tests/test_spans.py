import unittest

from app.spans import Span, filter_spans, merge_spans, normalize_entity_type


class SpanPolicyTests(unittest.TestCase):
    def test_normalizes_bioes_and_punctuation(self):
        self.assertEqual(normalize_entity_type("B-first_name"), "FIRST_NAME")
        self.assertEqual(normalize_entity_type("E-health plan beneficiary number"), "HEALTH_PLAN_BENEFICIARY_NUMBER")

    def test_filters_threshold_entities_and_bad_offsets(self):
        spans = [
            Span("PERSON", 0, 4, 0.9, "presidio"),
            Span("PHONE_NUMBER", 5, 12, 0.4, "presidio"),
            Span("MEDICAL_RECORD_NUMBER", 13, 12, 0.95, "openmed"),
            Span("MEDICAL_RECORD_NUMBER", 13, 20, 0.95, "openmed"),
        ]

        filtered = filter_spans(spans, score_threshold=0.5, entities=["PERSON", "MEDICAL_RECORD_NUMBER"])

        self.assertEqual([(span.entity_type, span.start, span.end) for span in filtered], [
            ("PERSON", 0, 4),
            ("MEDICAL_RECORD_NUMBER", 13, 20),
        ])

    def test_deduplicates_exact_spans_with_highest_score(self):
        spans = [
            Span("EMAIL_ADDRESS", 0, 12, 0.6, "presidio"),
            Span("EMAIL_ADDRESS", 0, 12, 0.95, "openmed"),
        ]

        merged = merge_spans(spans)

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0].score, 0.95)
        self.assertEqual(merged[0].source, "openmed")

    def test_overlap_prefers_higher_confidence(self):
        spans = [
            Span("PERSON", 0, 10, 0.95, "presidio"),
            Span("FIRST_NAME", 0, 4, 0.7, "openmed"),
        ]

        self.assertEqual(merge_spans(spans), [spans[0]])

    def test_overlap_prefers_medical_when_scores_are_comparable(self):
        spans = [
            Span("ID", 4, 12, 0.91, "presidio"),
            Span("MEDICAL_RECORD_NUMBER", 0, 12, 0.88, "openmed"),
        ]

        merged = merge_spans(spans)

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0].entity_type, "MEDICAL_RECORD_NUMBER")

    def test_overlap_prefers_longer_span_when_scores_are_comparable(self):
        spans = [
            Span("FIRST_NAME", 0, 4, 0.91, "openmed"),
            Span("PERSON", 0, 10, 0.9, "presidio"),
        ]

        merged = merge_spans(spans)

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0].entity_type, "PERSON")


if __name__ == "__main__":
    unittest.main()
