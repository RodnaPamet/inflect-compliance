"""The analyzer runs exactly the D-L1-1 scope, offline, and its hash moves with it."""

from __future__ import annotations

import socket
from pathlib import Path

import pytest

from inflect_pii import config


@pytest.fixture(scope="module")
def analyzer():
    return config.build_analyzer()


def test_the_analyzer_detects_the_five_in_scope_types_and_nothing_else(analyzer):
    for lang in config.LANGUAGES:
        assert set(analyzer.get_supported_entities(language=lang)) == set(config.SCOPE)


def test_both_locales_are_served(analyzer):
    assert sorted(analyzer.supported_languages) == ["bg", "en"]


def test_analysis_opens_no_socket(analyzer, monkeypatch, corpus):
    def refuse(*_args, **_kwargs):
        raise AssertionError("the analyzer tried to open a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    for case in corpus["cases"]:
        analyzer.analyze(text=case["text"], language=case["locale"], entities=config.SCOPE)


def test_the_config_hash_is_stable_and_names_its_inputs(tmp_path, monkeypatch):
    first = config.config_hash()
    assert first == config.config_hash()
    assert first.startswith("sha256:") and len(first) == len("sha256:") + 64

    # Copy the package somewhere else and change one context word: the hash moves.
    root = Path(config.__file__).resolve().parent.parent
    (tmp_path / "inflect_pii").mkdir()
    (tmp_path / "requirements.txt").write_bytes((root / "requirements.txt").read_bytes())
    for f in (root / "inflect_pii").glob("*.py"):
        (tmp_path / "inflect_pii" / f.name).write_bytes(f.read_bytes())
    monkeypatch.setattr(config, "_ROOT", tmp_path)
    assert config.config_hash() == first
    rec = tmp_path / "inflect_pii" / "recognizers.py"
    rec.write_text(rec.read_text(encoding="utf-8").replace('"егн"', '"егн:"'), encoding="utf-8")
    assert config.config_hash() != first
