"""Bootstrap the stock Presidio REST service with Ficta identity recognizers."""

import os

from app import Server
from presidio_analyzer.predefined_recognizers import SpacyRecognizer
from presidio_analyzer.recognizer_registry.recognizers_loader_utils import (
    RecognizerListLoader,
)

from .identity_recognizer import (
    FictaGlinerIdentityRecognizer,
    FictaSpacyIdentityRecognizer,
)


def create_app():
    """Create Presidio's Flask app after replacing raw generic NER output."""
    server = Server()
    registry = server.engine.registry
    registry.remove_recognizer("SpacyRecognizer")

    # Deployment country scope. The pinned analyzer only exposes country filtering
    # programmatically (the registry YAML schema forbids a `supported_countries` key), so the
    # derived image applies the same upstream filter here: recognizers tagged with a
    # `country_code` load only when their code is listed; untagged (locale-agnostic) recognizers
    # always load. Semantics: unset → no filtering (never the case in the shipped image — the
    # Dockerfile defaults the reference profile); set but empty → locale-agnostic only.
    countries_env = os.environ.get("FICTA_PRESIDIO_SUPPORTED_COUNTRIES")
    if countries_env is not None:
        countries = [code.strip() for code in countries_env.split(",") if code.strip()]
        registry.recognizers = RecognizerListLoader.filter_by_countries(
            registry.recognizers, countries
        )

    # The gating design depends on no stock NLP recognizer emitting raw PERSON/ORGANIZATION/LOCATION/
    # DATE_TIME spans. remove_recognizer is a silent no-op if the name ever stops matching (an upstream
    # rename, or a swap to TransformersRecognizer), so verify by type — TransformersRecognizer subclasses
    # SpacyRecognizer — and fail loudly rather than leak ungated NER. Ficta's recognizers are not
    # SpacyRecognizer subclasses, so this must hold before we register our own.
    leaking = [r for r in registry.recognizers if isinstance(r, SpacyRecognizer)]
    if leaking:
        raise RuntimeError(
            "Stock Presidio NLP recognizer still present after removal "
            f"({', '.join(sorted({type(r).__name__ for r in leaking}))}); raw NER would bypass Ficta gating"
        )

    ner = os.environ.get("FICTA_PRESIDIO_NER", "spacy").strip().lower()
    if ner == "spacy":
        recognizer = FictaSpacyIdentityRecognizer()
    elif ner == "gliner":
        recognizer = FictaGlinerIdentityRecognizer(
            model_name=os.environ.get("FICTA_PRESIDIO_GLINER_MODEL", "urchade/gliner_multi_pii-v1"),
            threshold=_float_env("FICTA_PRESIDIO_GLINER_THRESHOLD", 0.5),
        )
    else:
        raise ValueError("FICTA_PRESIDIO_NER must be 'spacy' or 'gliner'")

    recognizer.load()
    registry.add_recognizer(recognizer)
    return server.app


def _float_env(name: str, fallback: float) -> float:
    try:
        value = float(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return fallback
    return value if 0.0 <= value <= 1.0 else fallback
