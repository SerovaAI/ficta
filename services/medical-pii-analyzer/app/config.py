"""Runtime configuration for the medical PII analyzer."""

from __future__ import annotations

import os
from dataclasses import dataclass


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    host: str = os.environ.get("HOST", "0.0.0.0")
    port: int = int(os.environ.get("PORT", "3000"))
    default_score_threshold: float = env_float("MEDICAL_SCORE_THRESHOLD", 0.5)
    eager_load: bool = env_flag("MEDICAL_EAGER_LOAD", False)

    openmed_model: str = os.environ.get("OPENMED_MODEL", "OpenMed/privacy-filter-nemotron-v2")
    openmed_tokenizer: str | None = os.environ.get("OPENMED_TOKENIZER") or None
    openmed_device: str = os.environ.get("OPENMED_DEVICE", "auto")
    openmed_torch_dtype: str = os.environ.get("OPENMED_TORCH_DTYPE", "auto")
    openmed_trust_remote_code: bool = env_flag("OPENMED_TRUST_REMOTE_CODE", True)
    openmed_aggregation_strategy: str = os.environ.get("OPENMED_AGGREGATION_STRATEGY", "simple")


settings = Settings()
