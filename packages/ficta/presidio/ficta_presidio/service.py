"""Bootstrap the stock Presidio REST service with Ficta identity recognizers."""

import os

from app import Server

from .identity_recognizer import (
    FictaGlinerIdentityRecognizer,
    FictaSpacyIdentityRecognizer,
)


def create_app():
    """Create Presidio's Flask app after replacing raw generic NER output."""
    server = Server()
    server.engine.registry.remove_recognizer("SpacyRecognizer")

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
    server.engine.registry.add_recognizer(recognizer)
    return server.app


def _float_env(name: str, fallback: float) -> float:
    try:
        value = float(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return fallback
    return value if 0.0 <= value <= 1.0 else fallback
