import unittest

from app.spans import Span

try:
    from fastapi.testclient import TestClient

    from app import main
except ImportError as exc:  # pragma: no cover - local source checkouts may not install sidecar deps.
    raise unittest.SkipTest(f"FastAPI test dependencies are not installed: {exc}") from exc


class FakeDetector:
    def __init__(self, name, spans):
        self.name = name
        self.spans = spans

    def load(self):
        return None

    def is_loaded(self):
        return True

    def analyze(self, text, language, entities, score_threshold):
        del text, language, entities, score_threshold
        return self.spans


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        self.original_detectors = main.detectors
        self.client = TestClient(main.app)

    def tearDown(self):
        main.detectors = self.original_detectors

    def test_health_returns_detector_status(self):
        main.detectors = [FakeDetector("openmed", [])]

        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["detectors"]["openmed"]["loaded"], True)

    def test_analyze_returns_presidio_shaped_spans(self):
        main.detectors = [
            FakeDetector(
                "openmed",
                [
                    Span("FIRST_NAME", 0, 4, 0.9, "openmed"),
                    Span("MEDICAL_RECORD_NUMBER", 16, 23, 0.88, "openmed"),
                ],
            ),
        ]

        response = self.client.post(
            "/analyze",
            json={
                "text": "Sarah Smith MRN A12345",
                "language": "en",
                "score_threshold": 0.5,
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [
            {"entity_type": "FIRST_NAME", "start": 0, "end": 4, "score": 0.9},
            {"entity_type": "MEDICAL_RECORD_NUMBER", "start": 16, "end": 23, "score": 0.88},
        ])

    def test_analyze_applies_entity_allowlist(self):
        main.detectors = [
            FakeDetector("openmed", [Span("MEDICAL_RECORD_NUMBER", 16, 23, 0.88, "openmed")]),
        ]

        response = self.client.post(
            "/analyze",
            json={
                "text": "Sarah Smith MRN A12345",
                "language": "en",
                "score_threshold": 0.5,
                "entities": ["MEDICAL_RECORD_NUMBER"],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [
            {"entity_type": "MEDICAL_RECORD_NUMBER", "start": 16, "end": 23, "score": 0.88},
        ])


if __name__ == "__main__":
    unittest.main()
