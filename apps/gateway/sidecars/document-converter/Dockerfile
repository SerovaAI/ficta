FROM python:3.12-slim

# markitdown's PDF/Office backends need a few system libs; docling additionally needs these for OCR.
# pandoc backs the /render (markdown -> docx) endpoint. Official static build, NOT Debian's package:
# /render runs pandoc with --sandbox, which only reads embedded data files, and the Debian build
# omits them (docx output fails with exit 97, PandocCouldNotFindDataFileError).
ARG PANDOC_VERSION=3.6.4
RUN apt-get update \
  && apt-get install -y --no-install-recommends libmagic1 libgl1 libglib2.0-0 curl ca-certificates \
  && curl -fsSL "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-$(dpkg --print-architecture).tar.gz" \
    | tar xz -C /opt \
  && ln -s "/opt/pandoc-${PANDOC_VERSION}/bin/pandoc" /usr/local/bin/pandoc \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py signature_probe.py test_signature_probe.py test_render.py ./
RUN python -m unittest -v test_signature_probe.py test_render.py

ENV CONVERTER_BACKEND=markitdown
ENV RENDER_BACKEND=pandoc
EXPOSE 5003
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5003"]
