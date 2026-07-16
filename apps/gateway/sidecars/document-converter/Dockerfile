FROM python:3.12-slim

# markitdown's PDF/Office backends need a few system libs; docling additionally needs these for OCR.
# pandoc backs the /render (markdown -> docx) endpoint. Official static build, NOT Debian's package:
# /render runs pandoc with --sandbox, which only reads embedded data files, and the Debian build
# omits them (docx output fails with exit 97, PandocCouldNotFindDataFileError).
ARG PANDOC_VERSION=3.6.4
ARG PANDOC_SHA256_AMD64=5def6e1ff535e397becce292ee97767a947306150b9fb1488003b67ac3417c5e
ARG PANDOC_SHA256_ARM64=ad5cf63fe0420388d9ec513f02d03e061477b786d11a328164dce8ad7387b8bd
RUN apt-get update \
  && apt-get install -y --no-install-recommends libmagic1 libgl1 libglib2.0-0 curl ca-certificates \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
    amd64) sha256="$PANDOC_SHA256_AMD64" ;; \
    arm64) sha256="$PANDOC_SHA256_ARM64" ;; \
    *) echo "no pinned pandoc checksum for $arch" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-${arch}.tar.gz" \
    -o /tmp/pandoc.tar.gz \
  && echo "$sha256  /tmp/pandoc.tar.gz" | sha256sum -c - \
  && tar xz -C /opt -f /tmp/pandoc.tar.gz \
  && rm /tmp/pandoc.tar.gz \
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
