import unittest

from .identity_recognizer import Candidate, FictaSpacyIdentityRecognizer


class IdentityRecognizerTest(unittest.TestCase):
    def setUp(self):
        self.recognizer = FictaSpacyIdentityRecognizer()

    def finalize(self, text, values, entities=None):
        candidates = [
            Candidate(entity_type, text.index(value), text.index(value) + len(value), 0.85)
            for value, entity_type in values
        ]
        return self.finalize_candidates(text, candidates, entities)

    def finalize_candidates(self, text, candidates, entities=None):
        results = self.recognizer._finalize(text, candidates, entities or [])
        return {(result.entity_type, text[result.start : result.end]) for result in results}

    def test_synthetic_legal_identity_and_contract_boundary(self):
        text = "\n".join(
            [
                "Between COPPER KITE FINANCE LIMITED (Lender) and NORTHSTAR ORCHARD PTY LTD (Borrower).",
                "Company Registration Number Seychelles TEST-654321",
                "Registration No: 2099/000001/07",
                "The Borrower is also known as The Northstar Orchard and Northstar Orchard Ltd.",
                "Represented by Alice Johnson.",
                "Signed by Robert Williams.",
                "Capital Sum: ZAR 800 000 at 8% interest for 3 months.",
                "Authorisations within 10 business days; Security Interest; Supreme Court in South Africa.",
            ]
        )
        found = self.finalize(
            text,
            [
                ("COPPER KITE FINANCE LIMITED", "ORGANIZATION"),
                ("NORTHSTAR ORCHARD PTY LTD", "ORGANIZATION"),
                ("Borrower", "PERSON"),
                ("Alice Johnson", "PERSON"),
                ("Robert Williams", "PERSON"),
                ("Capital Sum", "PERSON"),
                ("Authorisations", "PERSON"),
                ("Security Interest", "ORGANIZATION"),
                ("Supreme Court", "ORGANIZATION"),
                ("South Africa", "LOCATION"),
                ("3 months", "DATE_TIME"),
                ("10 business days", "DATE_TIME"),
            ],
        )
        for expected in [
            ("ORGANIZATION", "COPPER KITE FINANCE LIMITED"),
            ("ORGANIZATION", "NORTHSTAR ORCHARD PTY LTD"),
            ("ORGANIZATION", "The Northstar Orchard"),
            ("ORGANIZATION", "Northstar Orchard Ltd"),
            ("PERSON", "Alice Johnson"),
            ("PERSON", "Robert Williams"),
            ("COMPANY_REGISTRATION", "TEST-654321"),
            ("COMPANY_REGISTRATION", "2099/000001/07"),
        ]:
            self.assertIn(expected, found)
        for visible in [
            ("PERSON", "Borrower"),
            ("PERSON", "Capital Sum"),
            ("PERSON", "Authorisations"),
            ("ORGANIZATION", "Security Interest"),
            ("ORGANIZATION", "Supreme Court"),
            ("LOCATION", "South Africa"),
            ("DATE_TIME", "3 months"),
            ("DATE_TIME", "10 business days"),
        ]:
            self.assertNotIn(visible, found)

    def test_singleton_person_candidate_does_not_expand_into_a_legal_phrase(self):
        text = "Capital Sum remains a visible contract term."
        found = self.finalize(text, [("Capital", "PERSON"), ("Capital Sum", "PERSON")])
        self.assertNotIn(("PERSON", "Capital"), found)
        self.assertNotIn(("PERSON", "Capital Sum"), found)

    def test_requested_entities_filter_other_candidate_types(self):
        text = "Signed by Alice Johnson for Blue Lantern Ltd."
        found = self.finalize(
            text,
            [("Alice Johnson", "PERSON"), ("Blue Lantern Ltd", "ORGANIZATION")],
            entities=["ORGANIZATION"],
        )
        self.assertIn(("ORGANIZATION", "Blue Lantern Ltd"), found)
        self.assertTrue(all(entity_type == "ORGANIZATION" for entity_type, _ in found))

    def test_explicit_company_identity_wins_without_protecting_commercial_fields(self):
        text = (
            "Vendor: Northstar Security Ltd. Custodian: Capital Harbor Trust PLC. "
            "Project name: Copper Kite. Access code: BLUE-ORCHID-42."
        )
        found = self.finalize(
            text,
            [
                ("Northstar Security Ltd", "ORGANIZATION"),
                ("Capital Harbor Trust PLC", "ORGANIZATION"),
                ("Copper Kite", "PERSON"),
                ("Copper Kite", "ORGANIZATION"),
                ("BLUE-ORCHID-42", "ORGANIZATION"),
            ],
        )
        self.assertIn(("ORGANIZATION", "Northstar Security Ltd"), found)
        self.assertIn(("ORGANIZATION", "Capital Harbor Trust PLC"), found)
        self.assertFalse(any(value in {"Copper Kite", "BLUE-ORCHID-42"} for _, value in found))

    def test_aliases_require_the_full_non_designator_stem(self):
        text = (
            "Company: BLUE LANTERN FINANCE LIMITED. "
            "The payee is blue lantern capital. The unrelated memo says blue capital."
        )
        found = self.finalize(text, [("BLUE LANTERN FINANCE LIMITED", "ORGANIZATION")])
        self.assertIn(("ORGANIZATION", "blue lantern capital"), found)
        self.assertNotIn(("ORGANIZATION", "blue capital"), found)

    def test_repeated_single_word_organization_aliases_link_to_full_names(self):
        text = (
            "Northstar notified Proxima. Northstar later contacted Proxima. "
            "Client: Northstar Biologics. Vendor: Proxima Medical Supplies CC."
        )
        first_northstar = text.index("Northstar")
        second_northstar = text.index("Northstar", first_northstar + 1)
        first_proxima = text.index("Proxima")
        second_proxima = text.index("Proxima", first_proxima + 1)
        candidates = [
            Candidate("ORGANIZATION", first_northstar, first_northstar + len("Northstar"), 0.85),
            Candidate("ORGANIZATION", second_northstar, second_northstar + len("Northstar"), 0.85),
            Candidate("ORGANIZATION", first_proxima, first_proxima + len("Proxima"), 0.85),
            Candidate("ORGANIZATION", second_proxima, second_proxima + len("Proxima"), 0.85),
            Candidate(
                "ORGANIZATION",
                text.index("Northstar Biologics"),
                text.index("Northstar Biologics") + len("Northstar Biologics"),
                0.85,
            ),
            Candidate(
                "ORGANIZATION",
                text.index("Proxima Medical Supplies CC"),
                text.index("Proxima Medical Supplies CC") + len("Proxima Medical Supplies CC"),
                0.85,
            ),
        ]

        results = self.recognizer._finalize(text, candidates, [])
        found = [(result.entity_type, text[result.start : result.end]) for result in results]

        self.assertEqual(found.count(("ORGANIZATION", "Northstar")), 2)
        self.assertEqual(found.count(("ORGANIZATION", "Proxima")), 2)

    def test_single_ambiguous_word_does_not_link_to_full_organization(self):
        text = "Blue raised a query. Company: BLUE LANTERN FINANCE LIMITED."
        found = self.finalize(
            text,
            [("Blue", "ORGANIZATION"), ("BLUE LANTERN FINANCE LIMITED", "ORGANIZATION")],
        )

        self.assertNotIn(("ORGANIZATION", "Blue"), found)
        self.assertIn(("ORGANIZATION", "BLUE LANTERN FINANCE LIMITED"), found)

    def test_repeated_alias_requires_one_canonical_organization(self):
        text = (
            "Northstar raised a query. Northstar requested a response. "
            "Vendor: Northstar Biologics Ltd. Supplier: Northstar Security Ltd."
        )
        first_alias = text.index("Northstar")
        second_alias = text.index("Northstar", first_alias + 1)
        candidates = [
            Candidate("ORGANIZATION", first_alias, first_alias + len("Northstar"), 0.85),
            Candidate("ORGANIZATION", second_alias, second_alias + len("Northstar"), 0.85),
            Candidate(
                "ORGANIZATION",
                text.index("Northstar Biologics Ltd"),
                text.index("Northstar Biologics Ltd") + len("Northstar Biologics Ltd"),
                0.85,
            ),
            Candidate(
                "ORGANIZATION",
                text.index("Northstar Security Ltd"),
                text.index("Northstar Security Ltd") + len("Northstar Security Ltd"),
                0.85,
            ),
        ]

        found = self.finalize_candidates(text, candidates)

        self.assertNotIn(("ORGANIZATION", "Northstar"), found)

    def test_dates_addresses_and_ocr_are_context_bound(self):
        text = (
            "Date of birth: 12 May 1980. Agreement date: 12 May 2025. "
            "Residential address: Cape Town. Law: Seychelles.\n"
            "Signed by: A l i c e J o h n s o n\n"
            "Other: C a p i t a l S u m"
        )
        found = self.finalize(
            text,
            [
                ("12 May 1980", "DATE_TIME"),
                ("12 May 2025", "DATE_TIME"),
                ("Cape Town", "LOCATION"),
                ("Seychelles", "LOCATION"),
            ],
        )
        self.assertIn(("DATE_TIME", "12 May 1980"), found)
        self.assertIn(("LOCATION", "Cape Town"), found)
        self.assertIn(("PERSON", "A l i c e J o h n s o n"), found)
        self.assertNotIn(("DATE_TIME", "12 May 2025"), found)
        self.assertNotIn(("LOCATION", "Seychelles"), found)
        self.assertFalse(any(value == "C a p i t a l S u m" for _, value in found))


if __name__ == "__main__":
    unittest.main()
