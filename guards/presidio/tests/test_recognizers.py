"""Each custom recogniser, alone, against hand-written cases and the corpus.

These run the recognisers directly, with no NLP engine: a pattern recogniser
does not need one, so a recogniser regression cannot hide behind the NER model.
"""

from __future__ import annotations

from types import SimpleNamespace

from conftest import empty_cases, gold
from inflect_pii.egn import check_digit
from inflect_pii.recognizers import (
    BgEgnRecognizer,
    BgPhoneRecognizer,
    BulgarianNameRecognizer,
    OfflineEmailRecognizer,
)
from presidio_analyzer.predefined_recognizers import EmailRecognizer, PhoneRecognizer


def spans(recognizer, text, entity):
    return sorted(text[r.start : r.end] for r in recognizer.analyze(text, [entity]))


# ─── ЕГН ─────────────────────────────────────────────────────────────────────


def test_egn_recogniser_keeps_a_valid_number_and_drops_both_near_misses():
    valid = "750102001" + str(check_digit("750102001"))
    bad_check = valid[:9] + str((int(valid[9]) + 1) % 10)
    bad_date = "751302001" + str(check_digit("751302001"))
    text = f"ЕГН {valid}, поръчка {bad_check}, партида {bad_date}"
    assert spans(BgEgnRecognizer("bg"), text, "BG_EGN") == [valid]


def test_egn_recogniser_does_not_cut_ten_digits_out_of_a_longer_number():
    valid = "750102001" + str(check_digit("750102001"))
    assert spans(BgEgnRecognizer("en"), f"account 9{valid}", "BG_EGN") == []


def test_egn_recogniser_finds_every_egn_in_the_corpus_in_both_locales(corpus):
    for locale in ("en", "bg"):
        recognizer = BgEgnRecognizer(locale)
        expected = list(gold(corpus, "BG_EGN", locale))
        assert expected
        missed = [v for case, v, _ in expected if v not in spans(recognizer, case["text"], "BG_EGN")]
        assert missed == []


# ─── Phones ──────────────────────────────────────────────────────────────────


def test_an_egn_is_not_a_phone_number_although_the_stock_regions_say_it_is(corpus):
    # The gap the custom regions close: under Presidio's default regions ten
    # digits are a valid North American number, so a found ЕГН came back twice.
    egns = [(case, v) for case, v, _ in gold(corpus, "BG_EGN")]
    assert egns
    stock = [
        v for case, v in egns if v in spans(PhoneRecognizer(supported_language=case["locale"]), case["text"], "PHONE_NUMBER")
    ]
    assert stock, "the stock recogniser no longer reads an ЕГН as a phone; revisit BgPhoneRecognizer's regions"
    ours = [v for case, v in egns if v in spans(BgPhoneRecognizer(case["locale"]), case["text"], "PHONE_NUMBER")]
    assert ours == []


def test_phone_recogniser_reads_every_bulgarian_format_in_the_corpus(corpus):
    for locale in ("en", "bg"):
        recognizer = BgPhoneRecognizer(locale)
        expected = list(gold(corpus, "PHONE_NUMBER", locale))
        assert expected
        missed = [v for case, v, _ in expected if v not in spans(recognizer, case["text"], "PHONE_NUMBER")]
        assert missed == []


def test_phone_recogniser_drops_a_written_date_that_the_numbering_plan_would_accept():
    text = "Изпратено на 02.11.2026 г., тел. 02 987 6543"
    assert spans(BgPhoneRecognizer("bg"), text, "PHONE_NUMBER") == ["02 987 6543"]


# ─── Names ───────────────────────────────────────────────────────────────────


def test_name_recogniser_takes_the_whole_three_part_bulgarian_name():
    text = "Служебно досие: Невена Иванова Димитрова, отдел ИТ."
    assert spans(BulgarianNameRecognizer("bg"), text, "PERSON") == ["Невена Иванова Димитрова"]


def test_name_recogniser_is_case_sensitive_so_ordinary_words_are_not_names():
    # Presidio's default flags include IGNORECASE; under them this sentence's
    # lower-case "-ова"/"-ски" pairs would all be names.
    text = "новата версия на градски транспорт е готова"
    assert spans(BulgarianNameRecognizer("bg"), text, "PERSON") == []


def test_name_recogniser_needs_a_bulgarian_surname_suffix():
    assert spans(BulgarianNameRecognizer("bg"), "Партида Номер седем", "PERSON") == []
    # The sentence's first word is capitalised; it is not the given name.
    assert spans(BulgarianNameRecognizer("bg"), "Колегата Мария Петрова дойде.", "PERSON") == ["Мария Петрова"]


def test_name_recogniser_reads_a_transliterated_bulgarian_name_in_english():
    text = "Payroll exception for Radka Stoyanova: salary paid twice."
    assert spans(BulgarianNameRecognizer("en"), text, "PERSON") == ["Radka Stoyanova"]


def test_name_recogniser_finds_every_cyrillic_name_in_the_bg_corpus(corpus):
    recognizer = BulgarianNameRecognizer("bg")
    cyrillic = [(c, v) for c, v, _ in gold(corpus, "PERSON", "bg") if not v.isascii()]
    assert cyrillic
    missed = [v for case, v in cyrillic if v not in spans(recognizer, case["text"], "PERSON")]
    assert missed == []


# ─── E-mail ──────────────────────────────────────────────────────────────────


def test_email_recogniser_accepts_a_private_domain_without_asking_the_network(monkeypatch):
    import presidio_analyzer.predefined_recognizers.generic.email_recognizer as stock

    def no_network(*_args, **_kwargs):
        raise AssertionError("tldextract was called: the service would fetch publicsuffix.org")

    monkeypatch.setattr(stock.tldextract, "extract", no_network)
    text = "Write to n.petrova@example.test or ops@corp.local."
    assert spans(OfflineEmailRecognizer("bg"), text, "EMAIL_ADDRESS") == ["n.petrova@example.test", "ops@corp.local"]


def test_the_stock_email_recogniser_would_have_asked_the_network(monkeypatch):
    import presidio_analyzer.predefined_recognizers.generic.email_recognizer as stock

    calls = []

    def recording(*args, **_kwargs):
        calls.append(args)
        return SimpleNamespace(fqdn="example.test")

    monkeypatch.setattr(stock.tldextract, "extract", recording)
    EmailRecognizer(supported_language="en").analyze("n.petrova@example.test", ["EMAIL_ADDRESS"])
    assert calls, "the stock recogniser no longer validates by tldextract; revisit OfflineEmailRecognizer"


# ─── Nothing to find ─────────────────────────────────────────────────────────


def test_no_deterministic_recogniser_flags_anything_where_there_is_nothing_to_find(corpus):
    flagged = []
    for case in empty_cases(corpus):
        for recognizer, entity in (
            (BgEgnRecognizer(case["locale"]), "BG_EGN"),
            (BgPhoneRecognizer(case["locale"]), "PHONE_NUMBER"),
            (BulgarianNameRecognizer(case["locale"]), "PERSON"),
            (OfflineEmailRecognizer(case["locale"]), "EMAIL_ADDRESS"),
        ):
            for value in spans(recognizer, case["text"], entity):
                flagged.append((case["id"], entity, value))
    assert flagged == []
