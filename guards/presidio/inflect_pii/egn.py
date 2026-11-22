"""The Bulgarian ЕГН (единен граждански номер), validated from its definition.

Ten digits: YYMMDD, three region/order digits, one check digit.

* The month carries the century: 01-12 is the 1900s, 21-32 the 1800s,
  41-52 the 2000s. The date must exist (no 30 February).
* The check digit is the sum of the first nine digits weighted
  2, 4, 8, 5, 10, 9, 7, 3, 6, modulo 11, with 10 written as 0.

Both halves are required. Ten digits that pass the checksum but name no date
are a batch number, and ten digits on a real date that fail the checksum are an
order number; neither is a person (the fixture corpus carries both as refusal
cases). Pure and dependency-free, so it is tested without Presidio.
"""

from __future__ import annotations

import datetime

WEIGHTS = (2, 4, 8, 5, 10, 9, 7, 3, 6)


def check_digit(first_nine: str) -> int:
    total = sum(w * int(d) for w, d in zip(WEIGHTS, first_nine)) % 11
    return 0 if total == 10 else total


def birth_date(egn: str) -> datetime.date | None:
    """The date an ЕГН encodes, or None when it encodes none."""
    year = int(egn[0:2])
    month = int(egn[2:4])
    day = int(egn[4:6])
    if 1 <= month <= 12:
        year += 1900
    elif 21 <= month <= 32:
        year, month = year + 1800, month - 20
    elif 41 <= month <= 52:
        year, month = year + 2000, month - 40
    else:
        return None
    try:
        return datetime.date(year, month, day)
    except ValueError:
        return None


def is_valid_egn(value: str) -> bool:
    if len(value) != 10 or not value.isascii() or not value.isdigit():
        return False
    return birth_date(value) is not None and check_digit(value[:9]) == int(value[9])
