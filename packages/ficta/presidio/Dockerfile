ARG PRESIDIO_ANALYZER_IMAGE=ghcr.io/data-privacy-stack/presidio-analyzer:2.2.364@sha256:ae8f6f111ac2f04e3fec552f7f80edd0dcbfa2dd69ee1b9e030475be31669885
FROM ${PRESIDIO_ANALYZER_IMAGE}

ARG INSTALL_GLINER=0
USER root
RUN if [ "${INSTALL_GLINER}" = "1" ]; then \
      pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch==2.9.1" && \
      pip install --no-cache-dir "gliner==0.2.27"; \
    fi
RUN mkdir -p /home/presidio/.cache/huggingface && chown -R 1001:1001 /home/presidio/.cache

COPY --chown=1001:1001 ficta_presidio /app/ficta_presidio
COPY --chown=1001:1001 --chmod=755 entrypoint.sh /app/ficta-presidio-entrypoint.sh

# Deployment country scope (comma-separated ISO-3166-1 alpha-2). Country-tagged recognizers in the
# registry load only when listed here; locale-agnostic recognizers always load. The baked default is
# the SA-legal reference profile; override per deployment. Empty string = locale-agnostic only.
ENV FICTA_PRESIDIO_SUPPORTED_COUNTRIES="za,us,mu"

# Verify the entrypoint runtime exists in the pinned upstream image.
USER 1001
RUN python -m gunicorn --version
ENTRYPOINT ["/app/ficta-presidio-entrypoint.sh"]

# Recorded by sidecars:update to skip builds when inputs are unchanged.
ARG FICTA_SIDECAR_FINGERPRINT
LABEL ai.serova.ficta.sidecar-inputs=$FICTA_SIDECAR_FINGERPRINT
ARG FICTA_SIDECAR_BASE_DIGEST
LABEL ai.serova.ficta.sidecar-base-digest=$FICTA_SIDECAR_BASE_DIGEST
