"""Detector adapter for OpenMed."""

from __future__ import annotations

import logging
from numbers import Integral
from typing import Any, Protocol

from .config import Settings
from .spans import Span, normalize_entity_type

logger = logging.getLogger("medical-pii-analyzer")


class Detector(Protocol):
    name: str

    def load(self) -> None: ...

    def is_loaded(self) -> bool: ...

    def analyze(self, text: str, language: str, entities: list[str] | None, score_threshold: float) -> list[Span]: ...


class OpenMedDetector:
    name = "openmed"

    def __init__(self, settings: Settings):
        self.settings = settings
        self.pipeline: Any | None = None

    def is_loaded(self) -> bool:
        return self.pipeline is not None

    def load(self) -> None:
        if self.pipeline is not None:
            return

        import torch
        from transformers import AutoModelForTokenClassification, AutoTokenizer, pipeline

        device = resolve_device(self.settings.openmed_device, torch)
        torch_dtype = resolve_torch_dtype(self.settings.openmed_torch_dtype, torch, device)
        model_kwargs: dict[str, Any] = {"trust_remote_code": self.settings.openmed_trust_remote_code}
        if torch_dtype is not None:
            model_kwargs["torch_dtype"] = torch_dtype

        tokenizer_name = self.settings.openmed_tokenizer or self.settings.openmed_model
        tokenizer = AutoTokenizer.from_pretrained(
            tokenizer_name,
            trust_remote_code=self.settings.openmed_trust_remote_code,
        )
        model = AutoModelForTokenClassification.from_pretrained(
            self.settings.openmed_model,
            **model_kwargs,
        )
        self.pipeline = pipeline(
            "token-classification",
            model=model,
            tokenizer=tokenizer,
            aggregation_strategy=self.settings.openmed_aggregation_strategy,
            device=device,
        )
        logger.info("loaded OpenMed model %s on device=%s", self.settings.openmed_model, device)

    def analyze(self, text: str, language: str, entities: list[str] | None, score_threshold: float) -> list[Span]:
        del language, entities, score_threshold
        self.load()
        predictions = self.pipeline(text)
        if not isinstance(predictions, list):
            return []

        spans: list[Span] = []
        for prediction in predictions:
            if not isinstance(prediction, dict):
                continue
            label = prediction.get("entity_group") or prediction.get("entity")
            start = prediction.get("start")
            end = prediction.get("end")
            score = prediction.get("score", 0.0)
            if not isinstance(label, str) or not isinstance(start, Integral) or not isinstance(end, Integral):
                continue
            try:
                numeric_score = float(score)
            except (TypeError, ValueError):
                continue
            spans.append(
                Span(
                    entity_type=normalize_entity_type(label),
                    start=int(start),
                    end=int(end),
                    score=numeric_score,
                    source=self.name,
                )
            )
        return spans


def resolve_device(raw: str, torch: Any) -> int:
    value = raw.strip().lower()
    if value in {"", "auto"}:
        return 0 if torch.cuda.is_available() else -1
    if value == "cpu":
        return -1
    if value == "cuda":
        return 0 if torch.cuda.is_available() else -1
    if value.startswith("cuda:"):
        try:
            index = int(value.split(":", 1)[1])
        except ValueError:
            return -1
        return index if torch.cuda.is_available() and index < torch.cuda.device_count() else -1
    try:
        return int(value)
    except ValueError:
        return -1


def resolve_torch_dtype(raw: str, torch: Any, device: int) -> Any | None:
    value = raw.strip().lower()
    if value in {"", "auto"}:
        return torch.bfloat16 if device >= 0 and hasattr(torch, "bfloat16") else None
    if value in {"bf16", "bfloat16"}:
        return torch.bfloat16
    if value in {"fp16", "float16"}:
        return torch.float16
    if value in {"fp32", "float32"}:
        return torch.float32
    return None
