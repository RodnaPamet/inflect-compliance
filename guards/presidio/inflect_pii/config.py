"""The analyzer configuration the service runs, and the hash a record names.

D-L1-1 (owner, 2026-11-11): five entity types, EN + BG, external routes only.
The registry is built from nothing rather than from Presidio's predefined set,
so a type outside the scope (a US SSN, a credit card, LOCATION) is not
detected at all, rather than detected and then filtered: a recogniser that is
not loaded cannot be the reason a payload changed.

``config_hash()`` is what a PII evaluation record names
(``detector.configHash``) and what Phase 1's mount condition compares: the
SHA-256 over the pinned requirements and every module of this package, by
name and bytes. Change a pattern, a context word, a region or a model pin and
the hash moves, and the record that vouched for the old configuration stops
vouching.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Dict, List

from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_analyzer.predefined_recognizers import IbanRecognizer, SpacyRecognizer

from .recognizers import custom_recognizers

SCOPE: List[str] = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "IBAN_CODE", "BG_EGN"]
LANGUAGES: List[str] = ["en", "bg"]

# The smallest models that carry a person label in each locale. No spaCy
# pipeline is trained on Bulgarian; the multilingual WikiNER model is the
# chosen BG NER (D-L4-3's rule applies here too: keep the smaller unless the
# record shows recall falling past a margin).
MODELS: Dict[str, str] = {"en": "en_core_web_sm", "bg": "xx_ent_wiki_sm"}

_ROOT = Path(__file__).resolve().parent.parent


def build_analyzer() -> AnalyzerEngine:
    nlp_engine = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": lang, "model_name": MODELS[lang]} for lang in LANGUAGES],
            "ner_model_configuration": {
                "model_to_presidio_entity_mapping": {"PER": "PERSON", "PERSON": "PERSON"},
                "labels_to_ignore": ["LOC", "ORG", "MISC", "GPE", "NORP", "FAC", "DATE", "CARDINAL"],
            },
        }
    ).create_engine()
    registry = RecognizerRegistry(supported_languages=LANGUAGES)
    for lang in LANGUAGES:
        registry.add_recognizer(SpacyRecognizer(supported_language=lang, supported_entities=["PERSON"]))
        registry.add_recognizer(IbanRecognizer(supported_language=lang))
        for recognizer in custom_recognizers(lang):
            registry.add_recognizer(recognizer)
    return AnalyzerEngine(registry=registry, nlp_engine=nlp_engine, supported_languages=LANGUAGES)


def config_hash() -> str:
    digest = hashlib.sha256()
    files = [_ROOT / "requirements.txt", *sorted((_ROOT / "inflect_pii").glob("*.py"))]
    for f in files:
        digest.update(f.relative_to(_ROOT).as_posix().encode("utf-8") + b"\0")
        digest.update(f.read_bytes() + b"\0")
    return f"sha256:{digest.hexdigest()}"
