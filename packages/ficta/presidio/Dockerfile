ARG PRESIDIO_ANALYZER_IMAGE=ghcr.io/data-privacy-stack/presidio-analyzer@sha256:330c78c144eca0c554e4cf12ab7c05a21872dca63fe6f93d67f08741de30b62f
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

USER 1001
ENTRYPOINT ["/app/ficta-presidio-entrypoint.sh"]
