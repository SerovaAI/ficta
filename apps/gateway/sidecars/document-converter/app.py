"""
Reference document-converter sidecar for ficta's web UI.

In a source checkout, root `pnpm dev` starts/reuses this Docker sidecar by default. Outside that
wrapper, run it yourself and point `FICTA_DOC_CONVERTER_URL` at it. It exposes the one uniform contract
the web client speaks, so the Node side stays backend-agnostic:

    POST /convert   multipart/form-data, field `file`   ->   200 {"markdown": "..."}
    POST /render    JSON {"markdown", "filename"?}      ->   200 .docx bytes (attachment)
    GET  /health                                        ->   200 {"status": "ok", "backend": "...",
                                                                  "render_backend": "..."}

Conversion backend is chosen with the `CONVERTER_BACKEND` env var:
  - `markitdown` (default) — light, fast, LLM-oriented. Good on text-based PDFs/DOCX.
  - `docling`             — heavier (layout analysis, table structure, OCR). Better fidelity on scanned
                            or table-heavy legal PDFs, which means better PII recall downstream.

Render backend is chosen with `RENDER_BACKEND` (only `pandoc` today). `RENDER_REFERENCE_DOCX` may
point at a firm-supplied template .docx whose styles pandoc applies (`--reference-doc`).

Run:  CONVERTER_BACKEND=markitdown uvicorn app:app --host 0.0.0.0 --port 5003
"""

import io
import os
import re
import shutil
import subprocess
import tempfile
import zipfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

BACKEND = os.environ.get("CONVERTER_BACKEND", "markitdown").strip().lower()
RENDER_BACKEND = os.environ.get("RENDER_BACKEND", "pandoc").strip().lower()
RENDER_REFERENCE_DOCX = os.environ.get("RENDER_REFERENCE_DOCX", "").strip()

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# Uploads are attacker-controllable (counterparty documents). Only PDF and DOCX are converted, decided
# from the bytes, and a DOCX's declared uncompressed size is bounded before any parser inflates it
# (Python's zipfile stops reading an entry at its declared size, so the declaration is what counts).
MAX_UNCOMPRESSED_BYTES = int(os.environ.get("CONVERTER_MAX_UNCOMPRESSED_BYTES", str(256 * 1024 * 1024)))
MAX_ZIP_ENTRIES = int(os.environ.get("CONVERTER_MAX_ZIP_ENTRIES", "10000"))
PDF_HEADER_WINDOW = 1024  # PDF readers accept the header anywhere in the first 1 KiB


class UnsupportedDocument(Exception):
    """Not a PDF or DOCX (HTTP 415)."""


class DocumentTooLarge(Exception):
    """Inflates past the configured bounds (HTTP 413)."""

app = FastAPI(title="ficta document-converter", version="1.0")


@app.get("/health")
def health() -> JSONResponse:
    # `status` stays liveness (conversion works without pandoc); `render_ready` is the /render
    # readiness signal: known backend, pandoc on PATH, and a readable reference doc if configured.
    return JSONResponse(
        {"status": "ok", "backend": BACKEND, "render_backend": RENDER_BACKEND, "render_ready": _render_ready()}
    )


def _render_ready() -> bool:
    if RENDER_BACKEND != "pandoc":
        return False
    if shutil.which("pandoc") is None:
        return False
    if RENDER_REFERENCE_DOCX and not os.access(RENDER_REFERENCE_DOCX, os.R_OK):
        return False
    return True


@app.post("/convert")
async def convert(file: UploadFile = File(...)) -> JSONResponse:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    try:
        ext = _sniff(data)
    except UnsupportedDocument as exc:
        raise HTTPException(status_code=415, detail="only PDF and DOCX documents are supported") from exc
    except DocumentTooLarge as exc:
        raise HTTPException(status_code=413, detail="document expands past the size limit") from exc
    try:
        markdown = _to_markdown(data, ext)
    except Exception as exc:  # noqa: BLE001 — surface a generic 500; details stay server-side
        # Values-free: the client's filename and the exception text can both carry document content.
        print(f"conversion failed: {type(exc).__name__}")
        raise HTTPException(status_code=500, detail="conversion failed") from exc

    return JSONResponse({"markdown": markdown})


class RenderRequest(BaseModel):
    markdown: str
    filename: str | None = None


@app.post("/render")
def render(req: RenderRequest) -> Response:
    if not req.markdown.strip():
        raise HTTPException(status_code=400, detail="empty markdown")

    try:
        docx = _render_docx(req.markdown)
    except Exception as exc:  # noqa: BLE001 — surface a generic 500; details stay server-side
        # Never echo document text back (pandoc errors can quote input); log the shape only.
        print(f"render failed: {type(exc).__name__}")
        raise HTTPException(status_code=500, detail="render failed") from exc

    filename = _safe_docx_filename(req.filename)
    return Response(
        content=docx,
        media_type=DOCX_MIME,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _render_docx(markdown: str) -> bytes:
    if RENDER_BACKEND != "pandoc":
        raise RuntimeError(f"unknown RENDER_BACKEND: {RENDER_BACKEND}")
    return _pandoc_docx(markdown)


def _pandoc_docx(markdown: str) -> bytes:
    with tempfile.TemporaryDirectory() as tmpdir:
        out_path = os.path.join(tmpdir, "out.docx")
        cmd = ["pandoc", "-f", "gfm+smart", "-t", "docx", "--sandbox", "-o", out_path]
        if RENDER_REFERENCE_DOCX:
            cmd.append(f"--reference-doc={RENDER_REFERENCE_DOCX}")
        subprocess.run(
            cmd,
            input=markdown.encode("utf-8"),
            check=True,
            capture_output=True,
            timeout=60,
        )
        with open(out_path, "rb") as f:
            return f.read()


def _safe_docx_filename(name: str | None) -> str:
    """Reduce an untrusted (model-suggested) filename to a bounded, header-safe .docx basename."""
    base = os.path.basename((name or "").strip().replace("\\", "/"))
    stem = re.sub(r"\.docx$", "", base, flags=re.IGNORECASE)
    stem = re.sub(r"[^\w. ()-]+", "_", stem)[:120].strip(". ") or "document"
    return f"{stem}.docx"


def _sniff(data: bytes) -> str:
    """The extension the bytes really are (".pdf" or ".docx"); the client's filename is never trusted."""
    if b"%PDF-" in data[:PDF_HEADER_WINDOW]:
        return ".pdf"
    if data.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
        except (zipfile.BadZipFile, ValueError) as exc:
            raise UnsupportedDocument("unreadable zip") from exc
        if len(entries) > MAX_ZIP_ENTRIES or sum(entry.file_size for entry in entries) > MAX_UNCOMPRESSED_BYTES:
            raise DocumentTooLarge("zip bounds exceeded")
        names = {entry.filename for entry in entries}
        if "[Content_Types].xml" in names and "word/document.xml" in names:
            return ".docx"
    raise UnsupportedDocument("not a PDF or DOCX")


def _to_markdown(data: bytes, ext: str) -> str:
    if BACKEND == "docling":
        return _docling_markdown(data, ext)
    return _markitdown_markdown(data, ext)


def _markitdown_markdown(data: bytes, ext: str) -> str:
    # Imported lazily so a docling-only image needn't install it.
    from markitdown import MarkItDown
    from markitdown.converters import DocxConverter, PdfConverter

    # Only the two converters the product supports. MarkItDown's built-ins also dispatch on sniffed
    # content, and include audio transcription (sent to Google's speech API) and archive/office parsers.
    md = MarkItDown(enable_builtins=False, enable_plugins=False)
    md.register_converter(PdfConverter())
    md.register_converter(DocxConverter())
    result = md.convert_stream(io.BytesIO(data), file_extension=ext)
    markdown = (result.text_content or "").strip()
    if ext != ".pdf":
        return markdown

    # MarkItDown extracts PDF text but ignores embedded signature images. Annotate only when every
    # extracted underscore rule maps one-to-one to the probe's page geometry and every rule is a
    # candidate, making Markdown reading-order differences irrelevant. Otherwise preserve the converter
    # output exactly rather than risk labeling the wrong form field.
    try:
        from signature_probe import annotate_pdf_markdown

        return annotate_pdf_markdown(markdown, io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001 - signature enrichment must never break base conversion
        print(f"signature annotation skipped: {type(exc).__name__}")
        return markdown


def _docling_markdown(data: bytes, ext: str) -> str:
    from docling.document_converter import DocumentConverter

    # docling converts from a path; write to a temp file with the sniffed extension so it detects the format.
    with tempfile.NamedTemporaryFile(suffix=ext, delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        converter = DocumentConverter()
        result = converter.convert(tmp.name)
        return result.document.export_to_markdown().strip()
