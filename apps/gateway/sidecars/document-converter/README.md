# document-converter sidecar

Turns uploaded PDF/DOCX into Markdown so the web UI can attach documents. The extracted Markdown is
inlined into the chat message and redacted by the ficta proxy on the way to the model — exactly like a
pasted text file. In a source checkout, root `pnpm dev` starts/reuses this Docker sidecar by default,
and `pnpm sidecars` runs it detached with the other local sidecars. Outside those workflows, run it and
point the app at it.

## Contract

```
POST /convert   multipart/form-data, field `file`   ->   200 {"markdown": "..."}
GET  /health                                         ->   200 {"status": "ok", "backend": "..."}
```

## Backends

| `CONVERTER_BACKEND` | Engine     | When                                                                   |
| ------------------- | ---------- | ---------------------------------------------------------------------- |
| `markitdown` (def.) | markitdown | Light/fast. Good on text-based PDFs/DOCX.                              |
| `docling`           | docling    | Heavy (layout + tables + OCR). Better on scanned/table-heavy PDFs — and better PII recall, since format-anchored entities (SSNs, cards) survive extraction more reliably. Uncomment `docling` in `requirements.txt`. |

## Run

Source checkout:

```sh
pnpm dev       # starts/reuses this sidecar by default
pnpm sidecars  # detached sidecar stack
```

Docker (default markitdown backend):

```sh
docker build -t ficta-doc-converter apps/gateway/sidecars/document-converter
docker run --rm -p 5003:5003 ficta-doc-converter
```

Local:

```sh
pip install -r requirements.txt
CONVERTER_BACKEND=markitdown uvicorn app:app --host 0.0.0.0 --port 5003
```

Then point the web app at it (default is already this URL):

```sh
export FICTA_DOC_CONVERTER_URL=http://127.0.0.1:5003
export FICTA_DOC_CONVERTER_BACKEND=markitdown   # informational on the Node side
```

## Env (web app side)

- `FICTA_DOC_CONVERTER_URL` — sidecar base URL (default `http://127.0.0.1:5003`).
- `FICTA_DOC_CONVERTER_MANAGED` — source-checkout root `pnpm dev` lifecycle toggle (`1` by default;
  set `0` to opt out).
- `FICTA_DOC_CONVERTER_BACKEND` — `markitdown` (default) | `docling`. Informational label; both speak the
  same `/convert` contract.
- `FICTA_DOC_CONVERTER_TIMEOUT_MS` — per-conversion budget (default `30000`).

If the sidecar is down or unset, document uploads fail closed: the file is not attached and the composer
tells the user to paste the text instead.

## Signature candidate detection

`signature_probe.py` is a local, read-only diagnostic for text-based PDFs. It reports long underscore
rules that overlap embedded images, a useful signal for evaluating image-backed signature fields. It
does not send data over the network, identify a signer, validate authenticity, or cover
scanned/flattened signatures.

The MarkItDown PDF path also uses this signal during `/convert`. When the probe's ordered rules match
the converted Markdown one-to-one, image-overlapped rules become `[signature-like mark present]`.
Unsigned rules remain unchanged. If detection fails or the rule counts differ, the converter returns
MarkItDown's original output unchanged rather than risk annotating the wrong field. Other file types and
the Docling backend are unaffected.

Run it inside the converter image so the PDF bytes remain local and the diagnostic uses the same
`pdfplumber` version as the sidecar:

```sh
docker run --rm -i ficta-doc-converter python signature_probe.py - < agreement.pdf
```

The JSON output contains only page numbers, bounding boxes, overlap ratios, and aggregate counts. It
never includes extracted document text or image bytes. A reported item is only a signature candidate,
not proof that the document was signed.
