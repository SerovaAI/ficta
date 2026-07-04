"""
Reference document-converter sidecar for ficta's web UI.

ficta does NOT manage this process's lifecycle (same model as the Presidio analyzer): you run it and
point `FICTA_DOC_CONVERTER_URL` at it. It exposes the one uniform contract the web client speaks, so the
Node side stays backend-agnostic:

    POST /convert   multipart/form-data, field `file`   ->   200 {"markdown": "..."}
    GET  /health                                        ->   200 {"status": "ok", "backend": "..."}

Backend is chosen with the `CONVERTER_BACKEND` env var:
  - `markitdown` (default) — light, fast, LLM-oriented. Good on text-based PDFs/DOCX.
  - `docling`             — heavier (layout analysis, table structure, OCR). Better fidelity on scanned
                            or table-heavy legal PDFs, which means better PII recall downstream.

Run:  CONVERTER_BACKEND=markitdown uvicorn app:app --host 0.0.0.0 --port 5003
"""

import io
import os
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

BACKEND = os.environ.get("CONVERTER_BACKEND", "markitdown").strip().lower()

app = FastAPI(title="ficta document-converter", version="1.0")


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "backend": BACKEND})


@app.post("/convert")
async def convert(file: UploadFile = File(...)) -> JSONResponse:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    filename = file.filename or "document"
    try:
        markdown = _to_markdown(data, filename)
    except Exception as exc:  # noqa: BLE001 — surface a generic 500; details stay server-side
        # Never echo document bytes back; log server-side only.
        print(f"conversion failed for {filename!r}: {exc}")
        raise HTTPException(status_code=500, detail="conversion failed") from exc

    return JSONResponse({"markdown": markdown})


def _to_markdown(data: bytes, filename: str) -> str:
    if BACKEND == "docling":
        return _docling_markdown(data, filename)
    return _markitdown_markdown(data, filename)


def _markitdown_markdown(data: bytes, filename: str) -> str:
    from markitdown import MarkItDown  # imported lazily so a docling-only image needn't install it

    md = MarkItDown()
    # markitdown sniffs type from the stream/extension; give it the original name as a hint.
    stream = io.BytesIO(data)
    result = md.convert_stream(stream, file_extension=_ext(filename))
    return (result.text_content or "").strip()


def _docling_markdown(data: bytes, filename: str) -> str:
    from docling.document_converter import DocumentConverter

    # docling converts from a path; write to a temp file preserving the extension so it detects the format.
    with tempfile.NamedTemporaryFile(suffix=_ext(filename), delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        converter = DocumentConverter()
        result = converter.convert(tmp.name)
        return result.document.export_to_markdown().strip()


def _ext(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot:].lower() if dot != -1 else ""
