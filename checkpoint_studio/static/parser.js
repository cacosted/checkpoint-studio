import * as pdfjs from "./vendor/pdf.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", import.meta.url).href;

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
const COLOR_HUES = { red: 4, green: 145, blue: 210, purple: 278 };

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
function loadPokedex() {
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

function hueDistance(a, b) {
  const difference = Math.abs(a - b);
  return Math.min(difference, 360 - difference);
}

function itemColors(imageData, rect, scale) {
  const { data, width, height } = imageData;
  const left = Math.max(0, Math.floor(rect.x * scale - 2));
  const top = Math.max(0, Math.floor(rect.y * scale - 2));
  const right = Math.min(width, Math.ceil((rect.x + rect.width) * scale + 2));
  const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * scale + 2));
  const counts = { red: 0, green: 0, blue: 0, purple: 0 };
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4;
      if (data[offset + 3] < 128) continue;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const difference = maximum - minimum;
      if (maximum < 40 || difference < 22 || difference / maximum < 0.12) continue;
      let hue;
      if (maximum === red) hue = 60 * (((green - blue) / difference) % 6);
      else if (maximum === green) hue = 60 * ((blue - red) / difference + 2);
      else hue = 60 * ((red - green) / difference + 4);
      if (hue < 0) hue += 360;
      for (const [kind, reference] of Object.entries(COLOR_HUES)) {
        if (hueDistance(hue, reference) <= 24) counts[kind] += 1;
      }
    }
  }
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return dominant[1] >= 6 ? { [dominant[0]]: dominant[1] } : {};
}

async function extractParagraphs(pdf, onProgress) {
  const paragraphs = [];
  let current = null;
  let previousPage = null;
  let previousY = null;
  function flush() {
    if (current && current.text.trim()) {
      current.text = current.text.replace(/\s+/g, " ").trim();
      paragraphs.push(current);
    }
    current = null;
  }
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (onProgress) onProgress(pageNumber, pdf.numPages);
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const renderViewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(renderViewport.width);
    canvas.height = Math.ceil(renderViewport.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: context, viewport: renderViewport }).promise;
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const content = await page.getTextContent();
    const lines = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const transform = pdfjs.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(transform[2], transform[3]);
      const rect = { x: transform[4], y: transform[5] - fontHeight * 0.25, width: item.width, height: fontHeight * 1.25 };
      let line = lines.find((candidate) => Math.abs(candidate.y - transform[5]) < 2);
      if (!line) {
        line = { y: transform[5], fontHeight, pieces: [] };
        lines.push(line);
      }
      line.pieces.push({ text: item.str, x: transform[4], width: item.width, colors: itemColors(imageData, rect, 2) });
    }
    lines.sort((a, b) => a.y - b.y);
    const mergedLines = lines.map((line) => {
      line.pieces.sort((a, b) => a.x - b.x);
      let text = "";
      let end = null;
      const colors = {};
      for (const piece of line.pieces) {
        if (text && end !== null && piece.x - end > 1 && !/\s$/.test(text) && !/^\s/.test(piece.text)) text += " ";
        text += piece.text;
        end = piece.x + piece.width;
        for (const [kind, count] of Object.entries(piece.colors)) colors[kind] = (colors[kind] || 0) + count;
      }
      return { text: text.trim(), colors, y: line.y, fontHeight: line.fontHeight };
    });
    for (const line of mergedLines) {
      const marker = line.text.match(/^\s*(?:\d+\.\s+|\u0000[\u0000\s]*)/);
      const text = line.text.slice(marker?.[0].length || 0).replaceAll("\u0000", "").trim();
      if (!text) continue;
      if (line.y - line.fontHeight > 740 || text.startsWith("Puedo Pasarme un Randomlocke")) continue;
      const isContinuation = current !== null && previousPage === pageNumber && previousY !== null && line.y - previousY > 0 && line.y - previousY < 28;
      if (marker || !isContinuation) {
        flush();
        current = { text, colors: { ...line.colors }, page: pageNumber };
      } else {
        current.text += ` ${text}`;
        for (const [kind, count] of Object.entries(line.colors)) current.colors[kind] = (current.colors[kind] || 0) + count;
      }
      previousPage = pageNumber;
      previousY = line.y;
    }
    page.cleanup();
    canvas.width = 1;
    canvas.height = 1;
  }
  flush();
  return paragraphs;
}

export async function parsePdf(data, filename, onProgress) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: new URL("./vendor/cmaps/", import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("./vendor/standard_fonts/", import.meta.url).href,
  });
  try {
    const pdf = await loadingTask.promise;
    const [paragraphs, pokedex] = await Promise.all([extractParagraphs(pdf, onProgress), loadPokedex()]);
    const result = parseParagraphs(paragraphs, pokedex, filename, pdf.numPages);
    if (!result.checkpoints.length) throw new Error("No encontré checkpoints azules con la palabra «team» en el PDF.");
    return result;
  } catch (error) {
    if (error.name === "PasswordException") throw new Error("El PDF está protegido por contraseña.");
    throw error;
  } finally {
    await loadingTask.destroy();
  }
}
