"""Presidio-compatible HTTP API for OpenMed medical PII detection."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .config import settings
from .detectors import Detector, OpenMedDetector
from .spans import Span, filter_spans, merge_spans

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("medical-pii-analyzer")


class AnalyzeRequest(BaseModel):
    text: str
    language: str = "en"
    score_threshold: float | None = Field(default=None, ge=0, le=1)
    entities: list[str] | None = None


class AnalyzeSpan(BaseModel):
    entity_type: str
    start: int
    end: int
    score: float


class HealthResponse(BaseModel):
    status: str
    detectors: dict[str, dict[str, bool | str]]


def build_detectors() -> list[Detector]:
    return [OpenMedDetector(settings)]


detectors = build_detectors()


@asynccontextmanager
async def lifespan(app: FastAPI):
    del app
    if settings.eager_load:
        for detector in detectors:
            detector.load()
    yield


app = FastAPI(title="Ficta Medical PII Analyzer", version="0.1.0", lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        detectors={
            detector.name: {
                "enabled": True,
                "loaded": detector.is_loaded(),
            }
            for detector in detectors
        },
    )


@app.post("/analyze", response_model=list[AnalyzeSpan])
def analyze(req: AnalyzeRequest) -> list[AnalyzeSpan]:
    if not req.text:
        raise HTTPException(status_code=400, detail="No text provided")
    if not detectors:
        raise HTTPException(status_code=503, detail="No detectors are enabled")

    score_threshold = req.score_threshold if req.score_threshold is not None else settings.default_score_threshold
    spans: list[Span] = []
    try:
        for detector in detectors:
            spans.extend(detector.analyze(req.text, req.language, req.entities, score_threshold))
    except Exception as exc:
        logger.exception("detector failure")
        raise HTTPException(status_code=503, detail=f"detector failure: {type(exc).__name__}") from exc

    filtered = filter_spans(spans, score_threshold=score_threshold, entities=req.entities)
    return [AnalyzeSpan(**span.to_presidio()) for span in merge_spans(filtered)]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port)
