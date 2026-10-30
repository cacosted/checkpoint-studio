from __future__ import annotations

import re
from collections import Counter
from copy import deepcopy

import fitz

from .pokedex import Pokedex, display_name, normalize


COLORS = {
    "red": "#CF5148",
    "green": "#50946E",
    "blue": "#387DC9",
    "purple": "#9A6BB4",
}
DEATH_WORDS = {"cayo", "perdi", "murio", "deleteo", "deletearon", "deletearon", "cheto"}


def _rgb_from_int(value: int) -> tuple[float, float, float]:
    return ((value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255)


def _color_kind(rgb) -> str:
    if not rgb or max(rgb) < 0.08:
        return "black"
    red, green, blue = rgb
    if blue > 0.6 and blue > red * 1.5 and blue > green * 1.2:
        return "blue"
    if red > 0.65 and red > green * 1.5 and red > blue * 1.5:
        return "red"
    if green > 0.42 and green > red * 1.25 and green > blue * 1.1:
        return "green"
    if red > 0.45 and blue > 0.55 and blue > green * 1.25 and red > green * 1.2:
        return "purple"
    return "other"


def _drawing_color(char_rect, drawings) -> str:
    best_kind = None
    best_area = 0.0
    for rect, kind in drawings:
        if rect.x0 > char_rect.x1 + 1 or rect.x1 < char_rect.x0 - 1:
            continue
        if rect.y0 > char_rect.y1 + 2 or rect.y1 < char_rect.y0 - 2:
            continue
        intersection = char_rect & rect
        area = max(0, intersection.width) * max(0, intersection.height)
        if area > best_area:
            best_area = area
            best_kind = kind
    return best_kind or "black"


def extract_paragraphs(document) -> list[dict]:
    paragraphs = []
    current = None
    previous_page = None
    previous_y = None

    def flush():
        nonlocal current
        if current and current["text"].strip():
            current["text"] = re.sub(r"\s+", " ", current["text"]).strip()
            paragraphs.append(current)
        current = None

    for page_number, page in enumerate(document, 1):
        drawings = []
        for drawing in page.get_drawings():
            kind = _color_kind(drawing.get("fill"))
            if kind not in {"black", "other"}:
                drawings.append((drawing["rect"], kind))
        lines = []
        raw = page.get_text("rawdict")
        for block in raw["blocks"]:
            for line in block.get("lines", []):
                pieces = []
                colors = Counter()
                for span in line["spans"]:
                    direct_kind = _color_kind(_rgb_from_int(span.get("color", 0)))
                    for char in span["chars"]:
                        text = char["c"]
                        pieces.append(text)
                        if not text.strip():
                            continue
                        kind = direct_kind
                        if span.get("alpha", 255) == 0:
                            drawing_kind = _drawing_color(fitz.Rect(char["bbox"]), drawings)
                            if drawing_kind != "black":
                                kind = drawing_kind
                        if kind != "black":
                            colors[kind] += 1
                text = "".join(pieces).strip()
                if text:
                    lines.append({"text": text, "colors": colors, "y": line["bbox"][1]})
        lines.sort(key=lambda item: item["y"])
        for line in lines:
            text = line["text"]
            if line["y"] > 740 or text.startswith("Puedo Pasarme un Randomlocke"):
                continue
            numbered = re.match(r"^\s*\d+\.\s+(.*)$", text)
            is_continuation = (
                current is not None
                and previous_page == page_number
                and previous_y is not None
                and 0 < line["y"] - previous_y < 28
            )
            if numbered or not is_continuation:
                flush()
                current = {
                    "text": numbered.group(1) if numbered else text,
                    "colors": Counter(line["colors"]),
                    "page": page_number,
                }
            else:
                current["text"] += " " + text
                current["colors"].update(line["colors"])
            previous_page = page_number
            previous_y = line["y"]
    flush()
    return paragraphs


def _base_event(event_type: str, paragraph: dict, index: int) -> dict:
    return {
        "id": f"event-{index:03d}",
        "type": event_type,
        "page": paragraph["page"],
        "source": paragraph["text"],
        "enabled": True,
        "needs_review": False,
        "notes": [],
    }


def _is_capture(paragraph: dict, pokedex: Pokedex) -> bool:
    text = normalize(paragraph["text"])
    colored_green = paragraph["colors"].get("green", 0) > 0
    named = bool(re.search(r"\ble puse\b", text)) or "asi le puse" in text
    action = any(cue in text for cue in ("atrap", "me regalo", "bienvenido al equipo", "bievenido al equipo"))
    if colored_green:
        return action or (named and bool(pokedex.find_matches(text)))
    auxiliary_capture = any(cue in text for cue in ("atrap", "elegi a", "elegi al"))
    return not paragraph["colors"] and auxiliary_capture and named


def _nickname(text: str) -> str | None:
    match = re.search(r"\ble\s+puse\s+([a-zA-ZáéíóúüñÁÉÍÓÚÜÑ0-9_]+)", text, re.IGNORECASE)
    if match:
        return match.group(1).strip(".,!?;:")
    normalized = normalize(text)
    if "asi le puse" in normalized:
        roulette = re.search(r"\bruleta\b.*?\bsalio\s+([a-zA-Z0-9_]+)", text, re.IGNORECASE)
        if roulette:
            return roulette.group(1).strip(".,!?;:")
    return None


def _capture_event(paragraph: dict, index: int, paragraphs: list[dict], position: int, pokedex: Pokedex) -> dict:
    event = _base_event("capture", paragraph, index)
    event["color"] = "green" if paragraph["colors"].get("green") else "none"
    matches = pokedex.find_matches(paragraph["text"])
    species = max(matches, key=lambda match: (match["score"], match["position"])) if matches else None
    from_context = False
    for distance in (1, 2):
        if position - distance < 0 or (species and species["score"] >= 0.82):
            break
        context_matches = [
            match for match in pokedex.find_matches(paragraphs[position - distance]["text"])
            if match["score"] >= 0.82
        ]
        if not context_matches:
            continue
        species = max(context_matches, key=lambda match: (match["score"], match["position"]))
        from_context = True
        break
    nickname = _nickname(paragraph["text"])
    if not nickname:
        for distance in (1, 2):
            if position + distance >= len(paragraphs):
                continue
            following = paragraphs[position + distance]
            if following["colors"].get("blue"):
                break
            nickname = _nickname(following["text"])
            if nickname:
                break
    if species:
        event.update({
            "species": species["display"],
            "species_id": species["id"],
            "species_identifier": species["name"],
        })
        if species["score"] < 1:
            event["notes"].append(f"Especie interpretada desde «{species['matched']}».")
        if species["score"] < 0.82:
            event["needs_review"] = True
    else:
        event.update({"species": "", "species_id": None, "species_identifier": ""})
        event["needs_review"] = True
        event["notes"].append("No se pudo identificar la especie.")
    event["nickname"] = nickname or event["species"]
    event["uid"] = f"pokemon-{event['id']}"
    if from_context:
        event["notes"].append("La especie se tomó del párrafo anterior.")
    if not nickname:
        event["needs_review"] = True
        event["notes"].append("No había apodo explícito; se usa la especie como apodo provisional.")
    if event["color"] == "none":
        event["needs_review"] = True
        event["notes"].append("Captura detectada por contexto: el párrafo no estaba marcado en verde.")
    return event


def _mentions(text: str, roster: list[dict]) -> list[dict]:
    tokens = normalize(text).split()
    mentions = []
    for member in roster:
        if member["dead"]:
            continue
        aliases = {member["nickname"], member["species"], *member.get("aliases", [])}
        for alias in aliases:
            alias_tokens = normalize(alias).split()
            if not alias_tokens or not alias_tokens[0]:
                continue
            size = len(alias_tokens)
            for start in range(len(tokens) - size + 1):
                if tokens[start:start + size] == alias_tokens:
                    mentions.append({"uid": member["uid"], "position": start, "score": 1.0})
            if size == 1 and len(alias_tokens[0]) >= 4:
                alias_token = alias_tokens[0]
                for start, token in enumerate(tokens):
                    if len(token) < 4 or token[0] != alias_token[0]:
                        continue
                    prefixed = token.startswith(alias_token) or alias_token.startswith(token)
                    if not prefixed and abs(len(token) - len(alias_token)) > 3:
                        continue
                    from difflib import SequenceMatcher
                    score = SequenceMatcher(None, token, alias_token).ratio()
                    fuzzy = len(token) >= 5 and len(alias_token) >= 5 and score >= 0.80
                    if fuzzy or (prefixed and min(len(token), len(alias_token)) >= 4):
                        mentions.append({"uid": member["uid"], "position": start, "score": max(score, 0.85)})
    unique = {}
    for mention in mentions:
        key = (mention["uid"], mention["position"])
        if key not in unique or unique[key]["score"] < mention["score"]:
            unique[key] = mention
    return sorted(unique.values(), key=lambda item: item["position"])


def _death_targets(text: str, roster: list[dict]) -> list[str]:
    mentions = _mentions(text, roster)
    normalized = normalize(text)
    tokens = normalized.split()
    if not mentions:
        if "starter" in tokens and roster:
            return [roster[0]["uid"]]
        return []
    cues = [index for index, token in enumerate(tokens) if token in DEATH_WORDS or token.startswith("delete")]
    if not cues:
        return []
    last_cue = cues[-1]
    after = [item for item in mentions if last_cue <= item["position"] <= last_cue + 8]
    selected = after or [mentions[-1]]
    return list(dict.fromkeys(item["uid"] for item in selected))


def _resolve_events(events: list[dict], pokedex: Pokedex, paragraphs: list[dict]) -> None:
    roster = []
    for event in events:
        if event["type"] == "capture":
            member = {
                "uid": event["uid"],
                "species": event["species"] or "Por definir",
                "nickname": event["nickname"] or "Por definir",
                "dead": False,
                "aliases": [],
            }
            roster.append(member)
        elif event["type"] == "death":
            targets = _death_targets(event["source"], roster)
            event["target_uids"] = targets
            if not targets:
                event["needs_review"] = True
                event["notes"].append("No se pudo asociar la baja con un integrante del equipo.")
            for member in roster:
                if member["uid"] in targets:
                    member["dead"] = True
        elif event["type"] == "evolution":
            mentions = _mentions(event["source"], roster)
            if not mentions:
                position = event.get("paragraph_index", 0)
                for distance in (1, 2):
                    context_position = position - distance
                    if context_position < 0:
                        break
                    context_mentions = _mentions(paragraphs[context_position]["text"], roster)
                    if context_mentions:
                        mentions = [context_mentions[-1]]
                        event["notes"].append("El integrante se tomó del párrafo anterior.")
                        break
            event["target_uids"] = [mentions[0]["uid"]] if mentions else []
            matches = pokedex.find_matches(event["source"])
            if matches:
                species = matches[-1]
                event.update({
                    "species": species["display"],
                    "species_id": species["id"],
                    "species_identifier": species["name"],
                })
                if species["score"] < 1:
                    event["notes"].append(f"Evolución interpretada desde «{species['matched']}».")
            else:
                event.update({"species": "", "species_id": None, "species_identifier": ""})
            if not mentions or not matches:
                event["needs_review"] = True
                event["notes"].append("Revisa el integrante o la especie evolucionada.")
            for member in roster:
                if member["uid"] in event["target_uids"]:
                    if member["species"]:
                        member["aliases"].append(member["species"])
                    member["species"] = event["species"] or member["species"]


def build_checkpoints(events: list[dict]) -> list[dict]:
    roster = []
    by_uid = {}
    new_since_checkpoint = set()
    evolved_since_checkpoint = set()
    checkpoints = []
    for event in events:
        if not event.get("enabled", True):
            continue
        event_type = event["type"]
        if event_type == "capture":
            member = {
                "uid": event.get("uid") or f"pokemon-{event['id']}",
                "species": event.get("species") or "Por definir",
                "species_id": event.get("species_id"),
                "nickname": event.get("nickname") or "Por definir",
                "dead": False,
            }
            roster.append(member)
            by_uid[member["uid"]] = member
            new_since_checkpoint.add(member["uid"])
        elif event_type == "death":
            for uid in event.get("target_uids", []):
                if uid in by_uid:
                    by_uid[uid]["dead"] = True
        elif event_type == "evolution":
            for uid in event.get("target_uids", []):
                if uid in by_uid:
                    by_uid[uid]["species"] = event.get("species") or by_uid[uid]["species"]
                    by_uid[uid]["species_id"] = event.get("species_id")
                    evolved_since_checkpoint.add(uid)
        elif event_type == "checkpoint":
            pokemon = []
            for member in roster:
                item = deepcopy(member)
                item["new"] = member["uid"] in new_since_checkpoint
                item["evolved"] = member["uid"] in evolved_since_checkpoint
                pokemon.append(item)
            checkpoints.append({
                "number": len(checkpoints) + 1,
                "title": event.get("title") or f"Team {len(checkpoints) + 1}",
                "page": event["page"],
                "event_id": event["id"],
                "pokemon": pokemon,
            })
            new_since_checkpoint.clear()
            evolved_since_checkpoint.clear()
    return checkpoints


def checkpoints_text(checkpoints: list[dict]) -> str:
    blocks = []
    for checkpoint in checkpoints:
        lines = [f"CHECKPOINT {checkpoint['number']} — {checkpoint['title']}"]
        for position, pokemon in enumerate(checkpoint["pokemon"], 1):
            line = f"{position}. {pokemon['species']} ({pokemon['nickname']})"
            if pokemon["dead"]:
                line += " 💀"
            if pokemon.get("evolved"):
                line += " 🟪"
            if pokemon.get("new"):
                line += " 🟩"
            lines.append(line)
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def parse_pdf(pdf_bytes: bytes, filename: str) -> dict:
    pokedex = Pokedex()
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        if document.needs_pass:
            raise ValueError("El PDF está protegido por contraseña.")
        paragraphs = extract_paragraphs(document)
        page_count = len(document)
    events = []
    for position, paragraph in enumerate(paragraphs):
        text = normalize(paragraph["text"])
        colors = paragraph["colors"]
        if colors.get("blue") and re.search(r"\bteam(?=\d|\s|=|:|-|$)", text):
            event = _base_event("checkpoint", paragraph, len(events) + 1)
            match = re.search(r"\bteam\s*(?:=|:|-)?\s*([\w-]+)", text)
            event["title"] = f"Team {match.group(1)}" if match else f"Team {len(events) + 1}"
            event["color"] = "blue"
        elif colors.get("purple") and "evol" in text:
            event = _base_event("evolution", paragraph, len(events) + 1)
            event["color"] = "purple"
        elif _is_capture(paragraph, pokedex):
            event = _capture_event(paragraph, len(events) + 1, paragraphs, position, pokedex)
        elif colors.get("red") and any(word in text for word in ("cayo", "delete", "perdi", "murio", "cheto a")):
            event = _base_event("death", paragraph, len(events) + 1)
            event["color"] = "red"
        else:
            continue
        event["paragraph_index"] = position
        events.append(event)
    _resolve_events(events, pokedex, paragraphs)
    checkpoints = build_checkpoints(events)
    review_count = sum(1 for event in events if event["needs_review"])
    return {
        "filename": filename,
        "page_count": page_count,
        "events": events,
        "checkpoints": checkpoints,
        "text": checkpoints_text(checkpoints),
        "summary": {
            "checkpoints": len(checkpoints),
            "captures": sum(event["type"] == "capture" for event in events),
            "deaths": sum(len(event.get("target_uids", [])) for event in events if event["type"] == "death"),
            "evolutions": sum(event["type"] == "evolution" for event in events),
            "review": review_count,
        },
    }
