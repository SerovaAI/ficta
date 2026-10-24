"""Unit tests for the /convert input gate: only PDF and DOCX, decided from the bytes, with bounded DOCX
inflation, and MarkItDown restricted to its PDF and DOCX converters. Runs in the Docker image build."""

import io
import unittest
import zipfile

from markitdown import UnsupportedFormatException

import app
from app import DocumentTooLarge, UnsupportedDocument, _markitdown_markdown, _sniff

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
RELS = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
    'officeDocument" Target="word/document.xml"/></Relationships>'
)
DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    "<w:body><w:p><w:r><w:t>Consulting Agreement</w:t></w:r></w:p></w:body></w:document>"
)


def make_zip(entries: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, body in entries.items():
            archive.writestr(name, body)
    return buffer.getvalue()


DOCX = make_zip({"[Content_Types].xml": CONTENT_TYPES, "_rels/.rels": RELS, "word/document.xml": DOCUMENT})


class Sniff(unittest.TestCase):
    def test_pdf_header_within_first_kib(self):
        self.assertEqual(_sniff(b"%PDF-1.7\n"), ".pdf")
        self.assertEqual(_sniff(b"\x00" * 500 + b"%PDF-1.4\n"), ".pdf")

    def test_docx(self):
        self.assertEqual(_sniff(DOCX), ".docx")

    def test_rejects_other_zip_containers(self):
        xlsx = make_zip({"[Content_Types].xml": CONTENT_TYPES, "xl/workbook.xml": "<workbook/>"})
        with self.assertRaises(UnsupportedDocument):
            _sniff(xlsx)

    def test_rejects_non_documents(self):
        for data in (b"RIFF\x24\x00\x00\x00WAVEfmt ", b"ID3\x03\x00", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", b"hello"):
            with self.subTest(data=data[:8]), self.assertRaises(UnsupportedDocument):
                _sniff(data)

    def test_rejects_corrupt_zip(self):
        with self.assertRaises(UnsupportedDocument):
            _sniff(b"PK\x03\x04" + b"\x00" * 40)

    def test_bounds_declared_inflation(self):
        bomb = make_zip(
            {"[Content_Types].xml": CONTENT_TYPES, "word/document.xml": DOCUMENT, "word/pad.xml": "0" * 4096}
        )
        saved = app.MAX_UNCOMPRESSED_BYTES
        app.MAX_UNCOMPRESSED_BYTES = 4096
        try:
            with self.assertRaises(DocumentTooLarge):
                _sniff(bomb)
        finally:
            app.MAX_UNCOMPRESSED_BYTES = saved

    def test_bounds_entry_count(self):
        many = make_zip({"[Content_Types].xml": CONTENT_TYPES, "word/document.xml": DOCUMENT, "a": "", "b": ""})
        saved = app.MAX_ZIP_ENTRIES
        app.MAX_ZIP_ENTRIES = 3
        try:
            with self.assertRaises(DocumentTooLarge):
                _sniff(many)
        finally:
            app.MAX_ZIP_ENTRIES = saved


class RestrictedMarkItDown(unittest.TestCase):
    def test_converts_docx(self):
        self.assertIn("Consulting Agreement", _markitdown_markdown(DOCX, ".docx"))

    def test_has_no_other_converters(self):
        # With the built-ins enabled, plain text converts trivially; restricted, nothing accepts it.
        with self.assertRaises(UnsupportedFormatException):
            _markitdown_markdown(b"just text", ".txt")


if __name__ == "__main__":
    unittest.main()
