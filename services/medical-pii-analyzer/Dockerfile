ARG BASE_IMAGE=python:3.12-slim

FROM ${BASE_IMAGE} AS runtime

ARG INSTALL_TORCH=1
ARG TORCH_SPEC=torch

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV PORT=3000
ENV OPENMED_MODEL=OpenMed/privacy-filter-nemotron-v2
ENV OPENMED_AGGREGATION_STRATEGY=simple
ENV OPENMED_TRUST_REMOTE_CODE=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN if [ "${INSTALL_TORCH}" = "1" ]; then pip install "${TORCH_SPEC}"; fi \
  && pip install -r /app/requirements.txt

COPY app /app/app

RUN useradd -m -u 1001 analyzer && chown -R analyzer:analyzer /app
USER 1001

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]

FROM runtime AS cpu
ENV OPENMED_DEVICE=cpu
ENV OPENMED_TORCH_DTYPE=float32

FROM runtime AS gpu
ENV OPENMED_DEVICE=cuda
ENV OPENMED_TORCH_DTYPE=bfloat16
