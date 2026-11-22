"""The custom recognisers Presidio does not ship (Phase 0.3 of
docs/ai-architecture/presidio.md).

One per gap the EN + BG product has in Presidio's defaults:

* ``BgEgnRecognizer`` -- the ЕГН, checksum AND date (``egn.py``). The regex is
  deliberately loose (any ten digits) and scored low; ``validate_result`` is
  what decides, so an order number never reaches the redactor.
* ``BgPhoneRecognizer`` -- Presidio's phonenumbers-backed recogniser, pointed
  at Bulgaria and the UK instead of its default regions (US, GB, DE, FR, IL,
  IN, CA, BR). Under the defaults an ЕГН in the fixture corpus is ALSO
  reported as a phone number -- ten digits are a valid North American number
  -- so a correctly found ЕГН comes back twice, once under the wrong type.
  Validity comes from libphonenumber's numbering plan, not from a regex of
  ours. One refusal on top: a match that is a written date (``02.11.2026``) is
  dropped. Under the BG plan that string IS a valid Sofia number, and
  Bulgarian text writes every date that way.
* ``BulgarianNameRecognizer`` -- Bulgarian personal names by morphology, in
  both scripts: a capitalised given name, an optional patronymic, and a family
  name, the last two each ending in a Bulgarian surname suffix (-ов/-ев/-ова/-ева, -ски/-ска,
  -цки/-цка; in Latin the Streamlined System spellings -ov/-ev/-ova/-eva,
  -ski/-ska). No spaCy pipeline is trained on Bulgarian; the multilingual
  ``xx_ent_wiki_sm`` carries the NER half for BG, and this is the
  deterministic half -- and the one that finds "Radka Stoyanova" in an English
  sentence, which ``en_core_web_sm`` misses. Case-SENSITIVE on purpose:
  Presidio's default flags include IGNORECASE, under which every lower-case
  "-ова" word pair in a sentence would be a name.
* ``OfflineEmailRecognizer`` -- Presidio's e-mail pattern without its
  validation. The stock ``validate_result`` asks ``tldextract`` whether the
  domain ends in a public suffix, which (a) refuses every address under a
  private or reserved TLD -- ``corp.local``, ``example.test`` -- although an
  address does not stop identifying a person because its domain is internal,
  and (b) fetches the public suffix list from publicsuffix.org on first use:
  an egress the in-deployment service must never make.
"""

from __future__ import annotations

from typing import List, Optional

import regex as re
from presidio_analyzer import EntityRecognizer, Pattern, PatternRecognizer, RecognizerResult
from presidio_analyzer.nlp_engine import NlpArtifacts
from presidio_analyzer.predefined_recognizers import EmailRecognizer, PhoneRecognizer

from .egn import is_valid_egn

EGN_CONTEXT = ["егн", "egn", "единен граждански номер", "personal id", "personal number", "id number"]
PHONE_CONTEXT = ["phone", "telephone", "mobile", "call", "contact", "телефон", "тел", "мобилен", "обади", "контакт"]
NAME_CONTEXT = ["г-н", "г-жа", "титуляр", "служител", "колега", "колегата", "holder", "employee", "colleague"]

_NOT_WORD_BEFORE = r"(?<![\p{L}\p{N}])"
_NOT_WORD_AFTER = r"(?![\p{L}\p{N}])"
_CYR_WORD = r"[А-Я][а-яъь]+"
_CYR_SURNAME = r"[А-Я][а-яъь]+(?:ова|ева|ов|ев|ска|ски|цка|цки)"
_LAT_WORD = r"[A-Z][a-z]+"
_LAT_SURNAME = r"[A-Z][a-z]+(?:ova|eva|ov|ev|ska|ski)"
# The patronymic carries the suffix too. Were the middle slot any capitalised
# word, "Колегата Мария Петрова" would match from the sentence's first word.
CYRILLIC_NAME_REGEX = rf"{_NOT_WORD_BEFORE}{_CYR_WORD}(?:\s{_CYR_SURNAME})?\s{_CYR_SURNAME}{_NOT_WORD_AFTER}"
LATIN_BG_NAME_REGEX = rf"{_NOT_WORD_BEFORE}{_LAT_WORD}(?:\s{_LAT_SURNAME})?\s{_LAT_SURNAME}{_NOT_WORD_AFTER}"

# dd.mm.yyyy / dd/mm/yyyy / dd-mm-yyyy, the way both locales write a date.
_WRITTEN_DATE = re.compile(r"^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$")


class BgEgnRecognizer(PatternRecognizer):
    ENTITY = "BG_EGN"

    def __init__(self, supported_language: str) -> None:
        super().__init__(
            supported_entity=self.ENTITY,
            name=f"BgEgnRecognizer_{supported_language}",
            supported_language=supported_language,
            patterns=[Pattern("egn_ten_digits", r"(?<!\d)\d{10}(?!\d)", 0.3)],
            context=EGN_CONTEXT,
        )

    def validate_result(self, pattern_text: str) -> Optional[bool]:  # noqa: D102
        return is_valid_egn(pattern_text)


class BgPhoneRecognizer(PhoneRecognizer):
    REGIONS = ("BG", "GB")

    def __init__(self, supported_language: str) -> None:
        super().__init__(
            context=PHONE_CONTEXT,
            supported_language=supported_language,
            supported_regions=self.REGIONS,
        )
        self.name = f"BgPhoneRecognizer_{supported_language}"

    def analyze(  # noqa: D102
        self, text: str, entities: List[str], nlp_artifacts: Optional[NlpArtifacts] = None
    ) -> List[RecognizerResult]:
        found = super().analyze(text, entities, nlp_artifacts)
        return [r for r in found if not _WRITTEN_DATE.match(text[r.start : r.end])]


class BulgarianNameRecognizer(PatternRecognizer):
    def __init__(self, supported_language: str) -> None:
        super().__init__(
            supported_entity="PERSON",
            name=f"BulgarianNameRecognizer_{supported_language}",
            supported_language=supported_language,
            patterns=[
                Pattern("bg_name_cyrillic", CYRILLIC_NAME_REGEX, 0.6),
                Pattern("bg_name_latin", LATIN_BG_NAME_REGEX, 0.5),
            ],
            context=NAME_CONTEXT,
            global_regex_flags=re.DOTALL | re.MULTILINE,
        )


class OfflineEmailRecognizer(EmailRecognizer):
    def __init__(self, supported_language: str) -> None:
        super().__init__(supported_language=supported_language)
        self.name = f"OfflineEmailRecognizer_{supported_language}"

    def validate_result(self, pattern_text: str) -> Optional[bool]:  # noqa: D102
        # None keeps the pattern's own score: no network, no public-suffix test.
        return None


def custom_recognizers(language: str) -> List[EntityRecognizer]:
    """Every non-NER recogniser one locale runs."""
    return [
        BgEgnRecognizer(language),
        BgPhoneRecognizer(language),
        BulgarianNameRecognizer(language),
        OfflineEmailRecognizer(language),
    ]
