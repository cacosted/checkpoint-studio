// Reglas para detectar capturas, bajas, evoluciones y checkpoints a partir de párrafos con colores.
// Las comparten el lector de PDF (parser.js) y el de guiones Markdown de Cacoscript (guion-md.js).

const DEATH_WORDS = new Set(["cayo", "perdi", "murio", "deleteo", "deletearon", "cheto"]);
const SPECIAL_NAMES = {
  "nidoran-f": "Nidoran♀",
  "nidoran-m": "Nidoran♂",
  farfetchd: "Farfetch'd",
  sirfetchd: "Sirfetch'd",
  "mr-mime": "Mr. Mime",
  "mime-jr": "Mime Jr.",
  "ho-oh": "Ho-Oh",
  "porygon-z": "Porygon-Z",
  "type-null": "Type: Null",
  "jangmo-o": "Jangmo-o",
  "hakamo-o": "Hakamo-o",
  "kommo-o": "Kommo-o",
  "mr-rime": "Mr. Rime",
};
const HYPHEN_NAMES = new Set(["ho-oh", "porygon-z", "jangmo-o", "hakamo-o", "kommo-o"]);

function normalize(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function displayName(identifier) {
  if (SPECIAL_NAMES[identifier]) return SPECIAL_NAMES[identifier];
  const separator = HYPHEN_NAMES.has(identifier) ? "-" : " ";
  return identifier.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(separator);
}

function similarity(a, b) {
  let matches = 0;
  function visit(aStart, aEnd, bStart, bEnd) {
    let bestI = aStart;
    let bestJ = bStart;
    let bestSize = 0;
    let previous = new Map();
    for (let i = aStart; i < aEnd; i += 1) {
      const current = new Map();
      for (let j = bStart; j < bEnd; j += 1) {
        if (a[i] !== b[j]) continue;
        const size = (previous.get(j - 1) || 0) + 1;
        current.set(j, size);
        if (size > bestSize) {
          bestI = i - size + 1;
          bestJ = j - size + 1;
          bestSize = size;
        }
      }
      previous = current;
    }
    if (!bestSize) return;
    matches += bestSize;
    visit(aStart, bestI, bStart, bestJ);
    visit(bestI + bestSize, aEnd, bestJ + bestSize, bEnd);
  }
  visit(0, a.length, 0, b.length);
  return 2 * matches / (a.length + b.length);
}

export class Pokedex {
  constructor(entries) {
    this.entries = entries;
    this.aliases = new Map();
    this.singleAliases = new Map();
    for (const source of entries) {
      const entry = { ...source, display: displayName(source.name) };
      const names = new Set([entry.name, entry.display, entry.name.replaceAll("-", " ")]);
      for (const name of names) {
        const key = normalize(name);
        this.aliases.set(key, entry);
        if (!key.includes(" ")) this.singleAliases.set(key, entry);
      }
    }
    this.maxAliasWords = Math.max(...[...this.aliases.keys()].map((key) => key.split(" ").length));
  }

  findMatches(text, fuzzy = true) {
    const tokens = normalize(text).split(" ");
    const found = new Map();
    for (let start = 0; start < tokens.length; start += 1) {
      for (let size = 1; size <= Math.min(this.maxAliasWords, tokens.length - start); size += 1) {
        const phrase = tokens.slice(start, start + size).join(" ");
        const entry = this.aliases.get(phrase);
        if (entry) found.set(`${start}:${size}`, { ...entry, position: start, score: 1, matched: phrase });
      }
      if (fuzzy && tokens[start].length >= 5) {
        const candidates = this.fuzzyToken(tokens[start]);
        if (candidates.length) {
          const [entry, score, matched] = candidates[0];
          const key = `${start}:1`;
          if (!found.has(key) || found.get(key).score < score) {
            found.set(key, { ...entry, position: start, score, matched });
          }
        }
      }
    }
    return [...found.values()].sort((a, b) => a.position - b.position || b.score - a.score);
  }

  fuzzyToken(value, minimum = 0.80) {
    const token = normalize(value).replaceAll(" ", "");
    if (token.length < 5) return [];
    const exact = this.singleAliases.get(token);
    if (exact) return [[exact, 1, token]];
    if (token.endsWith("s") && !token.endsWith("ss")) {
      const singular = this.singleAliases.get(token.slice(0, -1));
      if (singular) return [[singular, 0.98, token]];
    }
    const candidates = [];
    for (const [name, entry] of this.singleAliases) {
      if (name[0] !== token[0] || Math.abs(name.length - token.length) > 2) continue;
      const score = similarity(token, name);
      if (score >= minimum) candidates.push([entry, score, token]);
    }
    return candidates.sort((a, b) => b[1] - a[1]);
  }
}

let pokedexPromise;
export function loadPokedex() {
  if (!pokedexPromise) {
    pokedexPromise = fetch(new URL("./data/pokemon.json", import.meta.url))
      .then((response) => {
        if (!response.ok) throw new Error("No se pudo cargar la lista de especies.");
        return response.json();
      })
      .then((entries) => new Pokedex(entries));
  }
  return pokedexPromise;
}

function baseEvent(type, paragraph, index) {
  return {
    id: `event-${String(index).padStart(3, "0")}`,
    type,
    page: paragraph.page,
    section: paragraph.section || "",
    source: paragraph.text,
    enabled: true,
    needs_review: false,
    notes: [],
  };
}

function isCapture(paragraph, pokedex) {
  const text = normalize(paragraph.text);
  const coloredGreen = (paragraph.colors.green || 0) > 0;
  const named = /\ble puse\b/.test(text) || text.includes("asi le puse");
  const action = ["atrap", "me regalo", "bienvenido al equipo", "bievenido al equipo"].some((cue) => text.includes(cue));
  if (coloredGreen) return action || (named && pokedex.findMatches(text).length > 0);
  const auxiliaryCapture = ["atrap", "elegi a", "elegi al"].some((cue) => text.includes(cue));
  return Object.keys(paragraph.colors).length === 0 && auxiliaryCapture && named;
}

function nickname(text) {
  const match = text.match(/\ble\s+puse\s+([a-zA-ZáéíóúüñÁÉÍÓÚÜÑ0-9_]+)/i);
  if (match) return match[1].replace(/^[.,!?;:]+|[.,!?;:]+$/g, "");
  const normalized = normalize(text);
  if (normalized.includes("asi le puse")) {
    const roulette = text.match(/\bruleta\b.*?\bsalio\s+([a-zA-Z0-9_]+)/i);
    if (roulette) return roulette[1].replace(/^[.,!?;:]+|[.,!?;:]+$/g, "");
  }
  return null;
}

function captureEvent(paragraph, index, paragraphs, position, pokedex) {
  const event = baseEvent("capture", paragraph, index);
  event.color = paragraph.colors.green ? "green" : "none";
  const matches = pokedex.findMatches(paragraph.text);
  let species = matches.length ? matches.reduce((best, match) => (match.score > best.score || (match.score === best.score && match.position > best.position)) ? match : best) : null;
  let fromContext = false;
  for (const distance of [1, 2]) {
    if (position - distance < 0 || (species && species.score >= 0.82)) break;
    const contextMatches = pokedex.findMatches(paragraphs[position - distance].text).filter((match) => match.score >= 0.82);
    if (!contextMatches.length) continue;
    species = contextMatches.reduce((best, match) => (match.score > best.score || (match.score === best.score && match.position > best.position)) ? match : best);
    fromContext = true;
    break;
  }
  let nick = nickname(paragraph.text);
  if (!nick) {
    for (const distance of [1, 2]) {
      if (position + distance >= paragraphs.length) continue;
      const following = paragraphs[position + distance];
      if (following.colors.blue) break;
      nick = nickname(following.text);
      if (nick) break;
    }
  }
  if (species) {
    Object.assign(event, { species: species.display, species_id: species.id, species_identifier: species.name });
    if (species.score < 1) event.notes.push(`Especie interpretada desde «${species.matched}».`);
    if (species.score < 0.82) event.needs_review = true;
  } else {
    Object.assign(event, { species: "", species_id: null, species_identifier: "" });
    event.needs_review = true;
    event.notes.push("No se pudo identificar la especie.");
  }
  event.nickname = nick || event.species;
  event.uid = `pokemon-${event.id}`;
  if (fromContext) event.notes.push("La especie se tomó del párrafo anterior.");
  if (!nick) {
    event.needs_review = true;
    event.notes.push("No había apodo explícito; se usa la especie como apodo provisional.");
  }
  if (event.color === "none") {
    event.needs_review = true;
    event.notes.push("Captura detectada por contexto: el párrafo no estaba marcado en verde.");
  }
  return event;
}

function mentions(text, roster) {
  const tokens = normalize(text).split(" ");
  const found = [];
  for (const member of roster) {
    if (member.dead) continue;
    const aliases = new Set([member.nickname, member.species, ...(member.aliases || [])]);
    for (const alias of aliases) {
      const aliasTokens = normalize(alias).split(" ");
      if (!aliasTokens[0]) continue;
      const size = aliasTokens.length;
      for (let start = 0; start <= tokens.length - size; start += 1) {
        if (tokens.slice(start, start + size).join(" ") === aliasTokens.join(" ")) {
          found.push({ uid: member.uid, position: start, score: 1 });
        }
      }
      if (size === 1 && aliasTokens[0].length >= 4) {
        const aliasToken = aliasTokens[0];
        for (let start = 0; start < tokens.length; start += 1) {
          const token = tokens[start];
          if (token.length < 4 || token[0] !== aliasToken[0]) continue;
          const prefixed = token.startsWith(aliasToken) || aliasToken.startsWith(token);
          if (!prefixed && Math.abs(token.length - aliasToken.length) > 3) continue;
          const score = similarity(token, aliasToken);
          const fuzzy = token.length >= 5 && aliasToken.length >= 5 && score >= 0.80;
          if (fuzzy || (prefixed && Math.min(token.length, aliasToken.length) >= 4)) {
            found.push({ uid: member.uid, position: start, score: Math.max(score, 0.85) });
          }
        }
      }
    }
  }
  const unique = new Map();
  for (const mention of found) {
    const key = `${mention.uid}:${mention.position}`;
    if (!unique.has(key) || unique.get(key).score < mention.score) unique.set(key, mention);
  }
  return [...unique.values()].sort((a, b) => a.position - b.position);
}

function deathTargets(text, roster) {
  const found = mentions(text, roster);
  const tokens = normalize(text).split(" ");
  if (!found.length) return tokens.includes("starter") && roster.length ? [roster[0].uid] : [];
  const cues = tokens.flatMap((token, index) => DEATH_WORDS.has(token) || token.startsWith("delete") ? [index] : []);
  if (!cues.length) return [];
  const lastCue = cues.at(-1);
  const after = found.filter((item) => item.position >= lastCue && item.position <= lastCue + 8);
  const selected = after.length ? after : [found.at(-1)];
  return [...new Set(selected.map((item) => item.uid))];
}

function resolveEvents(events, pokedex, paragraphs) {
  const roster = [];
  for (const event of events) {
    if (event.type === "capture") {
      roster.push({ uid: event.uid, species: event.species || "Por definir", nickname: event.nickname || "Por definir", dead: false, aliases: [] });
    } else if (event.type === "death") {
      const targets = deathTargets(event.source, roster);
      event.target_uids = targets;
      if (!targets.length) {
        event.needs_review = true;
        event.notes.push("No se pudo asociar la baja con un integrante del equipo.");
      }
      for (const member of roster) if (targets.includes(member.uid)) member.dead = true;
    } else if (event.type === "evolution") {
      let found = mentions(event.source, roster);
      if (!found.length) {
        const position = event.paragraph_index || 0;
        for (const distance of [1, 2]) {
          const contextPosition = position - distance;
          if (contextPosition < 0) break;
          const contextMentions = mentions(paragraphs[contextPosition].text, roster);
          if (contextMentions.length) {
            found = [contextMentions.at(-1)];
            event.notes.push("El integrante se tomó del párrafo anterior.");
            break;
          }
        }
      }
      event.target_uids = found.length ? [found[0].uid] : [];
      const matches = pokedex.findMatches(event.source);
      if (matches.length) {
        const species = matches.at(-1);
        Object.assign(event, { species: species.display, species_id: species.id, species_identifier: species.name });
        if (species.score < 1) event.notes.push(`Evolución interpretada desde «${species.matched}».`);
      } else {
        Object.assign(event, { species: "", species_id: null, species_identifier: "" });
      }
      if (!found.length || !matches.length) {
        event.needs_review = true;
        event.notes.push("Revisa el integrante o la especie evolucionada.");
      }
      for (const member of roster) {
        if (!event.target_uids.includes(member.uid)) continue;
        if (member.species) member.aliases.push(member.species);
        member.species = event.species || member.species;
      }
    }
  }
}

function buildCheckpoints(events) {
  const roster = [];
  const byUid = new Map();
  const recentCaptures = new Set();
  const recentEvolutions = new Set();
  const checkpoints = [];
  for (const event of events) {
    if (!event.enabled) continue;
    if (event.type === "capture") {
      const member = {
        uid: event.uid || `pokemon-${event.id}`,
        species: event.species || "Por definir",
        species_id: event.species_id ?? null,
        nickname: event.nickname || "Por definir",
        dead: false,
      };
      roster.push(member);
      byUid.set(member.uid, member);
      recentCaptures.add(member.uid);
    } else if (event.type === "death") {
      for (const uid of event.target_uids || []) if (byUid.has(uid)) byUid.get(uid).dead = true;
    } else if (event.type === "evolution") {
      for (const uid of event.target_uids || []) {
        if (!byUid.has(uid)) continue;
        const member = byUid.get(uid);
        member.species = event.species || member.species;
        member.species_id = event.species_id ?? null;
        recentEvolutions.add(uid);
      }
    } else if (event.type === "checkpoint") {
      checkpoints.push({
        number: checkpoints.length + 1,
        title: event.title || `Team ${checkpoints.length + 1}`,
        page: event.page,
        section: event.section || "",
        event_id: event.id,
        pokemon: roster.map((member) => ({ ...member, new: recentCaptures.has(member.uid), evolved: recentEvolutions.has(member.uid) })),
      });
      recentCaptures.clear();
      recentEvolutions.clear();
    }
  }
  return checkpoints;
}

function checkpointsText(checkpoints) {
  return checkpoints.map((checkpoint) => {
    const lines = [`CHECKPOINT ${checkpoint.number} — ${checkpoint.title}`];
    checkpoint.pokemon.forEach((pokemon, position) => {
      let line = `${position + 1}. ${pokemon.species} (${pokemon.nickname})`;
      if (pokemon.dead) line += " 💀";
      if (pokemon.evolved) line += " 🟪";
      if (pokemon.new) line += " 🟩";
      lines.push(line);
    });
    return lines.join("\n");
  }).join("\n\n");
}

export function parseParagraphs(paragraphs, pokedex, filename = "", pageCount = 0) {
  const events = [];
  paragraphs.forEach((paragraph, position) => {
    const text = normalize(paragraph.text);
    const colors = paragraph.colors || {};
    let event;
    if (colors.blue && /\bteam(?=\d|\s|=|:|-|$)/.test(text)) {
      event = baseEvent("checkpoint", paragraph, events.length + 1);
      const match = text.match(/\bteam\s*(?:=|:|-)?\s*([\w-]+)/);
      event.title = match ? `Team ${match[1]}` : `Team ${events.length + 1}`;
      event.color = "blue";
    } else if (colors.purple && text.includes("evol")) {
      event = baseEvent("evolution", paragraph, events.length + 1);
      event.color = "purple";
    } else if (isCapture(paragraph, pokedex)) {
      event = captureEvent(paragraph, events.length + 1, paragraphs, position, pokedex);
    } else if (colors.red && ["cayo", "delete", "perdi", "murio", "cheto a"].some((word) => text.includes(word))) {
      event = baseEvent("death", paragraph, events.length + 1);
      event.color = "red";
    } else {
      return;
    }
    event.paragraph_index = position;
    events.push(event);
  });
  resolveEvents(events, pokedex, paragraphs);
  const checkpoints = buildCheckpoints(events);
  return {
    filename,
    page_count: pageCount,
    events,
    checkpoints,
    text: checkpointsText(checkpoints),
    summary: {
      checkpoints: checkpoints.length,
      captures: events.filter((event) => event.type === "capture").length,
      deaths: events.reduce((total, event) => total + (event.type === "death" ? (event.target_uids || []).length : 0), 0),
      evolutions: events.filter((event) => event.type === "evolution").length,
      review: events.filter((event) => event.needs_review).length,
    },
  };
}

