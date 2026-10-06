"""Exact checks for a word the person spelled letter by letter.

A pure gene: typed, import-safe, no I/O. The model decides which words the
person spelled and declares them; this module only checks that a name the
model proposes still contains each declared word, and reads a word back
letter by letter. It never decides what the person meant.

Matching is deliberately exact. A spelled word passes only when it equals one
whole token of the name after NFC normalization and case folding: no accent
stripping, no prefix or substring, no edit distance. HUSH is not HUSSH and
HUSSHX is not HUSSH; that difference is the reason the person spelled it.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence

MAX_SPELLED_WORD_LENGTH = 40

# Runs of letters and digits in the model's own name text. This splits a field
# into tokens; it does not classify anything the person said.
_TOKEN_RE = re.compile(r"[^\W_]+")


def spelling_key(word: str) -> str:
    """The comparison form of a word: NFC, case folded, NFC again.

    Case folding can decompose a character, so the result is normalized again
    and both sides of every comparison are the same canonical string.
    """
    return unicodedata.normalize("NFC", unicodedata.normalize("NFC", word).casefold())


def clean_spelled_word(raw: str) -> str | None:
    """The word, or None when it is not one word of letters and digits.

    Surrounding whitespace is dropped and the text is NFC normalized (the same
    characters, canonically composed). Case is never changed.
    """
    word = unicodedata.normalize("NFC", raw.strip())
    if not 1 <= len(word) <= MAX_SPELLED_WORD_LENGTH:
        return None
    if not all(char.isalnum() for char in word):
        return None
    return word


def name_tokens(name: str) -> list[str]:
    """The name's runs of letters and digits, in comparison form."""
    return _TOKEN_RE.findall(spelling_key(name))


def unique_spelled_words(words: Iterable[str]) -> list[str]:
    """Each word once, compared without case, keeping the first spelling seen."""
    seen: set[str] = set()
    unique: list[str] = []
    for word in words:
        key = spelling_key(word)
        if key in seen:
            continue
        seen.add(key)
        unique.append(word)
    return unique


def missing_spelled_words(name: str, words: Sequence[str]) -> list[str]:
    """The spelled words the name does not contain as a whole token, in input order."""
    tokens = set(name_tokens(name))
    return [word for word in unique_spelled_words(words) if spelling_key(word) not in tokens]


def spell_out(word: str) -> str:
    """The word read back letter by letter: HUSSH -> H-U-S-S-H, V04 -> V-0-4."""
    return "-".join(word.upper())


__all__ = [
    "MAX_SPELLED_WORD_LENGTH",
    "clean_spelled_word",
    "missing_spelled_words",
    "name_tokens",
    "spell_out",
    "spelling_key",
    "unique_spelled_words",
]
