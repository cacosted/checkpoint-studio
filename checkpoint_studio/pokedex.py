from __future__ import annotations

import json
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path


SPECIAL_NAMES = {
    "nidoran-f": "Nidoran♀",
    "nidoran-m": "Nidoran♂",
    "farfetchd": "Farfetch'd",
    "sirfetchd": "Sirfetch'd",
    "mr-mime": "Mr. Mime",
    "mime-jr": "Mime Jr.",
    "ho-oh": "Ho-Oh",
    "porygon-z": "Porygon-Z",
    "type-null": "Type: Null",
    "jangmo-o": "Jangmo-o",
    "hakamo-o": "Hakamo-o",
    "kommo-o": "Kommo-o",
    "mr-rime": "Mr. Rime",
}
HYPHEN_NAMES = {"ho-oh", "porygon-z", "jangmo-o", "hakamo-o", "kommo-o"}


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(char for char in value if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def display_name(identifier: str) -> str:
    if identifier in SPECIAL_NAMES:
        return SPECIAL_NAMES[identifier]
    separator = "-" if identifier in HYPHEN_NAMES else " "
    return separator.join(part.capitalize() for part in identifier.split("-"))


class Pokedex:
    def __init__(self) -> None:
        path = Path(__file__).parent / "static" / "data" / "pokemon.json"
        self.entries = json.loads(path.read_text(encoding="utf-8"))
        self.by_id = {entry["id"]: entry for entry in self.entries}
        self.by_identifier = {entry["name"]: entry for entry in self.entries}
        self.aliases: dict[str, dict] = {}
        self.single_aliases: dict[str, dict] = {}
        for entry in self.entries:
            entry = {**entry, "display": display_name(entry["name"])}
            self.by_id[entry["id"]] = entry
            self.by_identifier[entry["name"]] = entry
            names = {entry["name"], entry["display"], entry["name"].replace("-", " ")}
            for name in names:
                key = normalize(name)
                self.aliases[key] = entry
                if " " not in key:
                    self.single_aliases[key] = entry
        self.max_alias_words = max(len(key.split()) for key in self.aliases)

    def get(self, value: str) -> dict | None:
        key = normalize(value)
        if key in self.aliases:
            return self.aliases[key]
        matches = self._fuzzy_token(key, minimum=0.78)
        return matches[0] if matches else None

    def find_matches(self, text: str, fuzzy: bool = True) -> list[dict]:
        tokens = normalize(text).split()
        found: dict[tuple[int, int], dict] = {}
        for start in range(len(tokens)):
            for size in range(1, min(self.max_alias_words, len(tokens) - start) + 1):
                phrase = " ".join(tokens[start:start + size])
                entry = self.aliases.get(phrase)
                if entry:
                    found[(start, size)] = {
                        **entry,
                        "position": start,
                        "score": 1.0,
                        "matched": phrase,
                    }
            if fuzzy and len(tokens[start]) >= 5:
                candidates = self._fuzzy_token(tokens[start])
                if candidates:
                    entry, score, matched = candidates[0]
                    key = (start, 1)
                    if key not in found or found[key]["score"] < score:
                        found[key] = {
                            **entry,
                            "position": start,
                            "score": score,
                            "matched": matched,
                        }
        return sorted(found.values(), key=lambda item: (item["position"], -item["score"]))

    def _fuzzy_token(self, token: str, minimum: float = 0.80) -> list[tuple[dict, float, str]]:
        token = normalize(token).replace(" ", "")
        if len(token) < 5:
            return []
        exact = self.single_aliases.get(token)
        if exact:
            return [(exact, 1.0, token)]
        if token.endswith("s") and not token.endswith("ss"):
            singular = self.single_aliases.get(token[:-1])
            if singular:
                return [(singular, 0.98, token)]
        candidates = []
        for name, entry in self.single_aliases.items():
            if name[0] != token[0] or abs(len(name) - len(token)) > 2:
                continue
            score = SequenceMatcher(None, token, name).ratio()
            if score >= minimum:
                candidates.append((entry, score, token))
        return sorted(candidates, key=lambda item: item[1], reverse=True)
