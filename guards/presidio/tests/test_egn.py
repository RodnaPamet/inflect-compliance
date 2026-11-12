"""The ЕГН is valid only with a real date AND the weighted checksum."""

from __future__ import annotations

import re

from conftest import empty_cases, gold
from inflect_pii.egn import birth_date, check_digit, is_valid_egn


def with_check(first_nine: str) -> str:
    return first_nine + str(check_digit(first_nine))


def test_check_digit_follows_the_weights_and_writes_ten_as_zero():
    # 7*2 + 5*4 + 0*8 + 1*5 + 0*10 + 2*9 + 0*7 + 0*3 + 1*6 = 63; 63 % 11 = 8.
    assert check_digit("750102001") == 8
    # 1*2 + 0*4 + 0*8 + 1*5 + 0*10 + 1*9 + 0*7 + 0*3 + 1*6 = 22; 22 % 11 = 0.
    assert check_digit("100101001") == 0
    # 2*5 = 10, which is written as 0 -- not as the two characters "10".
    assert check_digit("000200000") == 0
    # 2*2 + 2*5 = 14; 14 % 11 = 3: the modulus is taken before the 10 rule.
    assert check_digit("200200000") == 3


def test_month_offsets_name_the_century():
    assert birth_date(with_check("750102001")).year == 1975
    assert birth_date(with_check("752102001")).year == 1875
    assert birth_date(with_check("054102001")).year == 2005
    assert birth_date(with_check("054102001")).month == 1


def test_a_valid_checksum_on_a_date_that_does_not_exist_is_not_an_egn():
    month_13 = with_check("751302001")
    feb_30 = with_check("750230001")
    assert not is_valid_egn(month_13)
    assert not is_valid_egn(feb_30)


def test_a_real_date_with_the_wrong_check_digit_is_not_an_egn():
    good = with_check("750102001")
    assert is_valid_egn(good)
    for wrong in "0123456789":
        if wrong != good[9]:
            assert not is_valid_egn(good[:9] + wrong)


def test_only_ten_ascii_digits_are_considered():
    good = with_check("750102001")
    assert not is_valid_egn(good[:9])
    assert not is_valid_egn(good + "0")
    assert not is_valid_egn("75O1020013")
    # Arabic-Indic digits pass str.isdigit(); they are not an ЕГН.
    assert not is_valid_egn("٧٥٠١٠٢٠٠١٣")


def test_every_egn_in_the_fixture_ground_truth_is_valid(corpus):
    values = [v for _, v, _ in gold(corpus, "BG_EGN")]
    assert values
    assert [v for v in values if not is_valid_egn(v)] == []


def test_no_ten_digit_run_in_a_case_with_nothing_to_find_is_valid(corpus):
    runs = [m for c in empty_cases(corpus) for m in re.findall(r"(?<!\d)\d{10}(?!\d)", c["text"])]
    assert len(runs) >= 4
    assert [r for r in runs if is_valid_egn(r)] == []
