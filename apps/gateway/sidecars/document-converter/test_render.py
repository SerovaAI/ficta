"""Unit tests for the /render path. Pandoc-dependent tests skip when pandoc is not on PATH
(they always run in the Docker image build, where pandoc is installed)."""

import io
import shutil
import unittest
import zipfile

from app import _pandoc_docx, _safe_docx_filename

SAMPLE_CONTRACT = """\
# Consulting Agreement

## 1. Services

1. The Consultant shall provide the services described in **Exhibit A**.
2. The Consultant shall:
   1. perform the services with reasonable skill and care;
   2. comply with all applicable laws.

## 2. Fees

| Item | Amount |
| ---- | ------ |
| Retainer | $5,000 |
| Hourly rate | $250 |
"""


class SafeDocxFilename(unittest.TestCase):
    def test_default_when_missing(self):
        self.assertEqual(_safe_docx_filename(None), "document.docx")
        self.assertEqual(_safe_docx_filename(""), "document.docx")
        self.assertEqual(_safe_docx_filename("   "), "document.docx")

    def test_forces_docx_extension(self):
        self.assertEqual(_safe_docx_filename("contract"), "contract.docx")
        self.assertEqual(_safe_docx_filename("contract.pdf"), "contract.pdf.docx")
        self.assertEqual(_safe_docx_filename("contract.DOCX"), "contract.docx")

    def test_strips_paths(self):
        self.assertEqual(_safe_docx_filename("../../etc/passwd"), "passwd.docx")
        self.assertEqual(_safe_docx_filename("a/b/contract.docx"), "contract.docx")
        self.assertEqual(_safe_docx_filename("..\\..\\contract.docx"), "contract.docx")

    def test_header_unsafe_characters_replaced(self):
        self.assertEqual(_safe_docx_filename('x"\r\n: evil.docx'), "x_ evil.docx")
        self.assertEqual(_safe_docx_filename("...docx"), "document.docx")

    def test_reasonable_names_survive(self):
        self.assertEqual(
            _safe_docx_filename("Consulting Agreement (v2).docx"),
            "Consulting Agreement (v2).docx",
        )


@unittest.skipUnless(shutil.which("pandoc"), "pandoc not installed")
class PandocRender(unittest.TestCase):
    def test_renders_valid_docx(self):
        docx = _pandoc_docx(SAMPLE_CONTRACT)
        # docx is a zip container; a readable word/document.xml is the minimal validity check.
        with zipfile.ZipFile(io.BytesIO(docx)) as zf:
            document_xml = zf.read("word/document.xml").decode("utf-8")
        self.assertIn("Consulting Agreement", document_xml)
        self.assertIn("Exhibit A", document_xml)
        # Headings must map to real Word heading styles (navigable outline), not plain paragraphs.
        self.assertIn("Heading1", document_xml)
        # The fee table must become a Word table.
        self.assertIn("<w:tbl>", document_xml)

    def test_numbered_clauses_use_word_numbering(self):
        docx = _pandoc_docx(SAMPLE_CONTRACT)
        with zipfile.ZipFile(io.BytesIO(docx)) as zf:
            names = zf.namelist()
            document_xml = zf.read("word/document.xml").decode("utf-8")
        # Nested clause lists must use numbering.xml-backed lists, not literal "1." text runs.
        self.assertIn("word/numbering.xml", names)
        self.assertIn("<w:numPr>", document_xml)


if __name__ == "__main__":
    unittest.main()
