"""Same-span entity precedence for the Ficta Presidio sidecar.

Two recognizers can validate exactly the same characters. A South African ID number is 13 digits
ending in a Luhn check digit, so the stock CreditCardRecognizer also accepts it, and both results
come back with the same score. Presidio then returns both, in no guaranteed order, and a client
that keeps one label per value ends up with whichever came first.

This module removes that ambiguity inside the sidecar, where the country-specific knowledge lives:
when a more specific entity covers exactly the same span as a generic one it is known to collide
with, the generic result is dropped. Spans that only overlap are left alone, and the rule only fires
when the specific recognizer itself validated the span (it must be in the results at all), so a
13-digit card number that is not a valid ID keeps its CREDIT_CARD result.
"""

from typing import Callable, Iterable, List, Sequence, Tuple

# (winner, loser): when both entity types cover exactly the same span, the loser is dropped.
DEFAULT_PRECEDENCE: Tuple[Tuple[str, str], ...] = (("ZA_ID_NUMBER", "CREDIT_CARD"),)


def apply_precedence(results: Iterable, precedence: Sequence[Tuple[str, str]] = DEFAULT_PRECEDENCE) -> List:
    """Drop each result whose exact span is also claimed by an entity that outranks it."""
    results = list(results)
    claimed = {(result.start, result.end, result.entity_type) for result in results}
    kept = []
    for result in results:
        winners = [winner for winner, loser in precedence if loser == result.entity_type]
        if any((result.start, result.end, winner) in claimed for winner in winners):
            continue
        kept.append(result)
    return kept


def install(engine, precedence: Sequence[Tuple[str, str]] = DEFAULT_PRECEDENCE) -> None:
    """Wrap ``engine.analyze`` (an AnalyzerEngine) so every response applies ``precedence``.

    The REST service and its batch path both call ``AnalyzerEngine.analyze``, so wrapping that one
    method covers every request.
    """
    original: Callable = engine.analyze

    def analyze(*args, **kwargs):
        return apply_precedence(original(*args, **kwargs), precedence)

    engine.analyze = analyze
