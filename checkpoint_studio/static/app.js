const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const STORAGE_KEY = "checkpoint-studio-project-v1";
const WEB_MODE = new URLSearchParams(location.search).has("web") || !["127.0.0.1", "localhost", "::1"].includes(location.hostname);
const TYPE_LABELS = { capture: "Captura", death: "Baja", evolution: "Evolución", checkpoint: "Checkpoint" };
const TYPE_COLORS = { capture: "#72c99a", death: "#e47d78", evolution: "#b38cda", checkpoint: "#75a9e8" };

const state = {
  filename: "",
  events: [],
  checkpoints: [],
  selected: 0,
  pokedex: [],
  filter: "all",
  draft: null,
  editingNew: false,
  settings: { background: "dark", columns: "auto", sprites: true, title: true },
};

const spriteCache = new Map();
const spritePromises = new Map();
const spriteFailed = new Set();
let toastTimer;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function normalize(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function projectName() {
  return (state.filename || "Proyecto Pokémon")
    .replace(/^[0-9a-f]{8}-[0-9a-f-]+_/i, "")
    .replace(/\.pdf$/i, "")
    .replaceAll("_", " ");
}

function showToast(message) {
  clearTimeout(toastTimer);
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function persist() {
  if (!state.events.length) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ filename: state.filename, events: state.events, settings: state.settings }));
  } catch {
    showToast("No se pudo guardar localmente; exporta el JSON para conservar el proyecto.");
  }
}

function recalculate(render = true) {
  const roster = [];
  const byUid = new Map();
  const recentCaptures = new Set();
  const recentEvolutions = new Set();
  const checkpoints = [];
  for (const event of state.events) {
    if (!event.enabled) continue;
    if (event.type === "capture") {
      const member = {
        uid: event.uid || `pokemon-${event.id}`,
        species: event.species || "Por definir",
        species_id: event.species_id || null,
        nickname: event.nickname || "Por definir",
        dead: false,
      };
      roster.push(member);
      byUid.set(member.uid, member);
      recentCaptures.add(member.uid);
    } else if (event.type === "death") {
      for (const uid of event.target_uids || []) {
        if (byUid.has(uid)) byUid.get(uid).dead = true;
      }
    } else if (event.type === "evolution") {
      for (const uid of event.target_uids || []) {
        if (!byUid.has(uid)) continue;
        const member = byUid.get(uid);
        member.species = event.species || member.species;
        member.species_id = event.species_id || null;
        recentEvolutions.add(uid);
      }
    } else if (event.type === "checkpoint") {
      checkpoints.push({
        number: checkpoints.length + 1,
        title: event.title || `Team ${checkpoints.length + 1}`,
        page: event.page,
        event_id: event.id,
        pokemon: roster.map((member) => ({
          ...member,
          new: recentCaptures.has(member.uid),
          evolved: recentEvolutions.has(member.uid),
        })),
      });
      recentCaptures.clear();
      recentEvolutions.clear();
    }
  }
  state.checkpoints = checkpoints;
  state.selected = Math.max(0, Math.min(state.selected, checkpoints.length - 1));
  persist();
  if (render) renderAll();
}

function checkpointsText() {
  return state.checkpoints.map((checkpoint) => {
    const lines = [`CHECKPOINT ${checkpoint.number} — ${checkpoint.title}`];
    checkpoint.pokemon.forEach((pokemon, index) => {
      let line = `${index + 1}. ${pokemon.species} (${pokemon.nickname})`;
      if (pokemon.dead) line += " 💀";
      if (pokemon.evolved) line += " 🟪";
      if (pokemon.new) line += " 🟩";
      lines.push(line);
    });
    return lines.join("\n");
  }).join("\n\n");
}

function renderAll() {
  const hasProject = state.events.length > 0;
  $("#empty-state").hidden = hasProject;
  $("#workspace").hidden = !hasProject;
  $("#open-button").hidden = !hasProject;
  $("#export-button").hidden = !hasProject;
  $("#file-context").hidden = !hasProject;
  if (!hasProject) return;
  $("#file-name").textContent = state.filename;
  $("#file-name").title = state.filename;
  $("#project-title").textContent = projectName();
  $("#project-title").title = projectName();
  renderSummary();
  renderCheckpointList();
  renderPreview();
  $("#text-output").textContent = checkpointsText();
  renderEvents();
  syncDesignControls();
}

function renderSummary() {
  const enabled = state.events.filter((event) => event.enabled);
  const captures = enabled.filter((event) => event.type === "capture").length;
  const deaths = enabled.reduce((total, event) => total + (event.type === "death" ? (event.target_uids || []).length : 0), 0);
  const evolutions = enabled.filter((event) => event.type === "evolution").length;
  const review = state.events.filter((event) => event.needs_review).length;
  $("#stat-checkpoints").textContent = state.checkpoints.length;
  $("#stat-captures").textContent = captures;
  $("#stat-deaths").textContent = deaths;
  $("#stat-evolutions").textContent = evolutions;
  $("#stat-review").textContent = review;
  $("#review-button").classList.toggle("clean", review === 0);
  $("#checkpoint-count").textContent = state.checkpoints.length;
  $("#events-tab-count").textContent = state.events.length;
  $("#export-file-count").textContent = `${state.checkpoints.length} plantillas`;
}

function renderCheckpointList() {
  $("#checkpoint-list").innerHTML = state.checkpoints.map((checkpoint) => `
    <button class="checkpoint-item ${checkpoint.number - 1 === state.selected ? "active" : ""}" data-checkpoint="${checkpoint.number - 1}">
      <span class="checkpoint-number">${String(checkpoint.number).padStart(2, "0")}</span>
      <span class="checkpoint-info"><strong>${escapeHtml(checkpoint.title)}</strong><span>${checkpoint.pokemon.length} integrantes · pág. ${checkpoint.page}</span></span>
      <span class="checkpoint-arrow">›</span>
    </button>`).join("");
  $$("[data-checkpoint]").forEach((button) => button.addEventListener("click", () => {
    state.selected = Number(button.dataset.checkpoint);
    renderCheckpointList();
    renderPreview();
  }));
}

function spriteUrl(id) {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;
}

function spriteHref(id) {
  if (!id || spriteFailed.has(id)) return null;
  return spriteCache.get(id) || spriteUrl(id);
}

function renderSvg(checkpoint) {
  const { background, sprites, title } = state.settings;
  const light = background === "light";
  const text = light ? "#17181d" : "#f5f3ee";
  const muted = light ? "#716c76" : "#98959f";
  const rowFill = light ? "#ffffff" : "#ffffff";
  const rowOpacity = light ? ".62" : ".035";
  const rowStroke = light ? "#d9d5ce" : "#ffffff";
  const accent = "#b9a2ef";
  const automatic = state.settings.columns === "auto";
  const count = checkpoint.pokemon.length;
  const columns = automatic ? Math.max(1, Math.ceil(Math.sqrt(count))) : Number(state.settings.columns);
  const rows = Math.max(1, Math.ceil(count / columns));
  const baseTop = title ? 174 : 50;
  const gap = rows > 10 ? 8 : 12;
  const columnGap = 24;
  const availableWidth = 1776;
  const columnWidth = Math.min((availableWidth - columnGap * (columns - 1)) / columns, automatic ? 560 : Infinity);
  const availableHeight = 1080 - baseTop - 48;
  const fittedRowHeight = (availableHeight - gap * (rows - 1)) / rows;
  const rowHeight = Math.max(1, Math.min(automatic ? columnWidth / 2 : 132, fittedRowHeight));
  const contentHeight = rows * rowHeight + (rows - 1) * gap;
  const top = baseTop + Math.max(0, (availableHeight - contentHeight) / 2);
  const speciesSize = Math.max(15, Math.min(28, rowHeight * .23));
  const nicknameSize = Math.max(11, Math.min(19, rowHeight * .15));
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1920" height="1080" viewBox="0 0 1920 1080">`];
  if (background !== "transparent") parts.push(`<rect width="1920" height="1080" fill="${light ? "#f2f0eb" : "#090a0f"}"/>`);
  if (title) {
    parts.push(`<rect x="72" y="56" width="42" height="5" rx="2.5" fill="${accent}"/>`);
    parts.push(`<text x="72" y="95" fill="${accent}" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="700" letter-spacing="4">PROGRESO DEL EQUIPO</text>`);
    parts.push(`<text x="72" y="143" fill="${text}" font-family="Arial,Helvetica,sans-serif" font-size="42" font-weight="800" letter-spacing="-.8">CHECKPOINT ${String(checkpoint.number).padStart(2, "0")}</text>`);
    parts.push(`<text x="1848" y="137" text-anchor="end" fill="${muted}" font-family="Arial,Helvetica,sans-serif" font-size="23" font-weight="600">${escapeHtml(checkpoint.title.toUpperCase())}</text>`);
  }
  checkpoint.pokemon.forEach((pokemon, index) => {
    const row = automatic ? Math.floor(index / columns) : index % rows;
    const column = automatic ? index % columns : Math.floor(index / rows);
    const itemsInRow = automatic ? Math.min(columns, count - row * columns) : columns;
    const rowWidth = itemsInRow * columnWidth + (itemsInRow - 1) * columnGap;
    const x = automatic ? 72 + (availableWidth - rowWidth) / 2 + column * (columnWidth + columnGap) : 72 + column * (columnWidth + columnGap);
    const y = top + row * (rowHeight + gap);
    const centerY = y + rowHeight / 2;
    const compact = rowHeight < 72;
    parts.push(`<rect x="${x}" y="${y}" width="${columnWidth}" height="${rowHeight}" rx="${Math.min(12, rowHeight / 5)}" fill="${rowFill}" fill-opacity="${rowOpacity}" stroke="${rowStroke}" stroke-opacity="${light ? ".8" : ".055"}"/>`);
    let nameX = x + 20;
    if (sprites) {
      const size = automatic ? Math.max(1, Math.min(rowHeight - 20, 96)) : rowHeight - 10;
      const href = spriteHref(pokemon.species_id);
      if (href) {
        parts.push(`<image x="${x + 5}" y="${centerY - size / 2}" width="${size}" height="${size}" href="${escapeHtml(href)}" preserveAspectRatio="xMidYMid meet" image-rendering="pixelated" opacity="${pokemon.dead ? ".5" : "1"}"/>`);
      } else {
        parts.push(`<circle cx="${x + 5 + size / 2}" cy="${centerY}" r="${size * .3}" fill="none" stroke="${muted}" stroke-width="3"/><path d="M${x + 5 + size * .2} ${centerY}h${size * .6}" stroke="${muted}" stroke-width="3"/><circle cx="${x + 5 + size / 2}" cy="${centerY}" r="${size * .08}" fill="${muted}"/>`);
      }
      nameX = automatic ? x + size + 25 : x + rowHeight + 15;
    }
    const statuses = [];
    if (pokemon.dead) statuses.push("dead");
    if (pokemon.evolved) statuses.push("evolved");
    if (pokemon.new) statuses.push("new");
    const statusSize = compact ? 23 : 29;
    const statusGap = compact ? 27 : 35;
    statuses.forEach((status, statusIndex) => {
      const statusX = x + columnWidth - 16 - statusSize - (statuses.length - 1 - statusIndex) * statusGap;
      const statusY = centerY - statusSize / 2;
      if (status === "dead") {
        parts.push(`<text x="${statusX + statusSize / 2}" y="${centerY + statusSize * .34}" text-anchor="middle" font-family="'Apple Color Emoji','Segoe UI Emoji',sans-serif" font-size="${statusSize}">💀</text>`);
      } else {
        const color = status === "new" ? "#65c78e" : "#a780ce";
        const symbol = status === "new" ? "+" : "↑";
        parts.push(`<rect x="${statusX}" y="${statusY}" width="${statusSize}" height="${statusSize}" rx="5" fill="${color}"/><text x="${statusX + statusSize / 2}" y="${centerY + statusSize * .3}" text-anchor="middle" fill="#11151a" font-family="Arial,Helvetica,sans-serif" font-size="${statusSize * .72}" font-weight="800">${symbol}</text>`);
      }
    });
    const available = columnWidth - (nameX - x) - 35 - statuses.length * statusGap;
    const estimated = Math.max(1, (pokemon.species.length * speciesSize * .65));
    const actualSpeciesSize = Math.max(12, Math.min(speciesSize, speciesSize * available / estimated));
    const estimatedNickname = Math.max(1, pokemon.nickname.length * nicknameSize * .6);
    const actualNicknameSize = Math.max(10, Math.min(nicknameSize, nicknameSize * available / estimatedNickname));
    const speciesY = automatic ? centerY - (compact ? 2 : 4) : y + rowHeight * (compact ? .40 : .43);
    const nicknameY = automatic ? centerY + actualNicknameSize + (compact ? 2 : 4) : y + rowHeight * .72;
    parts.push(`<text x="${nameX}" y="${speciesY}" fill="${text}" font-family="Arial,Helvetica,sans-serif" font-size="${actualSpeciesSize}" font-weight="750" letter-spacing=".6">${escapeHtml(pokemon.species.toUpperCase())}</text>`);
    parts.push(`<text x="${nameX}" y="${nicknameY}" fill="${muted}" font-family="Arial,Helvetica,sans-serif" font-size="${actualNicknameSize}" font-weight="500">(${escapeHtml(pokemon.nickname.toUpperCase())})</text>`);
  });
  if (!count) parts.push(`<text x="960" y="570" text-anchor="middle" fill="${muted}" font-family="Arial,Helvetica,sans-serif" font-size="26">No hay integrantes en este checkpoint</text>`);
  parts.push("</svg>");
  return parts.join("");
}

function renderPreview() {
  const checkpoint = state.checkpoints[state.selected];
  if (!checkpoint) {
    $("#template-preview").innerHTML = "";
    $("#preview-title").textContent = "Sin checkpoints";
    return;
  }
  $("#preview-kicker").textContent = `PLANTILLA ${String(checkpoint.number).padStart(2, "0")} · PÁGINA ${checkpoint.page}`;
  $("#preview-title").textContent = checkpoint.title;
  $("#preview-roster-count").textContent = `${checkpoint.pokemon.length} integrantes`;
  $("#template-preview").innerHTML = renderSvg(checkpoint);
  $("#template-preview").classList.toggle("transparent-preview", state.settings.background === "transparent");
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function ensureSprite(id) {
  if (!id) return Promise.resolve(null);
  if (spriteCache.has(id)) return Promise.resolve(spriteCache.get(id));
  if (spriteFailed.has(id)) return Promise.resolve(null);
  if (spritePromises.has(id)) return spritePromises.get(id);
  const promise = fetch(spriteUrl(id), { signal: AbortSignal.timeout(12000) })
    .then((response) => {
      if (!response.ok) throw new Error("Sprite no disponible");
      return response.blob();
    })
    .then(blobToDataUrl)
    .then((dataUrl) => {
      spriteCache.set(id, dataUrl);
      return dataUrl;
    })
    .catch(() => {
      spriteFailed.add(id);
      return null;
    });
  spritePromises.set(id, promise);
  return promise;
}

function warmSprites() {
  const ids = new Set(state.events.map((event) => event.species_id).filter(Boolean));
  for (const id of ids) {
    ensureSprite(id).then(() => {
      const current = state.checkpoints[state.selected];
      if (current?.pokemon.some((pokemon) => pokemon.species_id === id)) renderPreview();
    });
  }
}

async function exportSvg(checkpoint) {
  await Promise.all(checkpoint.pokemon.map((pokemon) => ensureSprite(pokemon.species_id)));
  return renderSvg(checkpoint);
}

function eventDescription(event) {
  const targetNames = (event.target_uids || []).map((uid) => {
    const capture = state.events.find((candidate) => candidate.type === "capture" && candidate.uid === uid);
    return capture ? `${capture.nickname} · ${capture.species}` : "Integrante desconocido";
  });
  if (event.type === "capture") return `${event.species || "Especie pendiente"} (${event.nickname || "apodo pendiente"})`;
  if (event.type === "death") return targetNames.join(" + ") || "Integrante sin asignar";
  if (event.type === "evolution") return `${targetNames[0] || "Integrante sin asignar"} → ${event.species || "especie pendiente"}`;
  return event.title;
}

function renderEvents() {
  const events = state.events.filter((event) => state.filter === "all" || event.needs_review);
  $$(".filter").forEach((button) => button.classList.toggle("active", button.dataset.filter === state.filter));
  if (!events.length) {
    $("#event-list").innerHTML = `<p class="design-note">No hay eventos en esta vista. Todo está confirmado.</p>`;
    return;
  }
  $("#event-list").innerHTML = events.map((event) => `
    <button class="event-item ${event.needs_review ? "needs-review" : ""} ${event.enabled ? "" : "disabled"}" data-event="${event.id}">
      <span class="event-color" style="background:${TYPE_COLORS[event.type]}"></span>
      <span class="event-type"><strong>${TYPE_LABELS[event.type]}</strong><span>${event.page ? `Página ${event.page}` : "Manual"}</span></span>
      <span class="event-description">${escapeHtml(eventDescription(event))}<small>${escapeHtml(event.source)}</small></span>
      ${event.needs_review ? `<span class="event-warning" title="Revisar">⚠</span>` : ""}<span class="event-chevron">›</span>
    </button>`).join("");
  $$("[data-event]").forEach((button) => button.addEventListener("click", () => openEvent(button.dataset.event)));
}

function availableTargets(eventId) {
  const targets = [];
  for (const event of state.events) {
    if (event.id === eventId) break;
    if (event.type === "capture" && event.enabled) targets.push({ uid: event.uid, label: `${event.nickname} · ${event.species}` });
  }
  return targets;
}

function speciesInput(value) {
  return `<input name="species" list="pokemon-names" value="${escapeHtml(value || "")}" placeholder="Ej. Dwebble" autocomplete="off" required>`;
}

function renderEventFields() {
  const event = state.draft;
  let html = "";
  if (state.editingNew) {
    html += `<label class="form-field"><span>Tipo de evento</span><select name="event-type" id="event-type">${Object.entries(TYPE_LABELS).map(([value, label]) => `<option value="${value}" ${event.type === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
  }
  if (event.type === "capture") {
    html += `<div class="form-row"><label class="form-field"><span>Especie</span>${speciesInput(event.species)}</label><label class="form-field"><span>Apodo</span><input name="nickname" value="${escapeHtml(event.nickname || "")}" placeholder="Ej. Rango" required></label></div>`;
  } else if (event.type === "death") {
    const targets = availableTargets(event.id);
    html += `<div class="form-field"><span>Integrantes que cayeron</span><div class="target-list">${targets.length ? targets.map((target) => `<label class="target-option"><input type="checkbox" name="targets" value="${target.uid}" ${(event.target_uids || []).includes(target.uid) ? "checked" : ""}>${escapeHtml(target.label)}</label>`).join("") : "No hay capturas anteriores."}</div><small>Puedes seleccionar varios si cayeron en el mismo evento.</small></div>`;
  } else if (event.type === "evolution") {
    const targets = availableTargets(event.id);
    html += `<div class="form-row"><label class="form-field"><span>Integrante</span><select name="target" required><option value="">Seleccionar</option>${targets.map((target) => `<option value="${target.uid}" ${(event.target_uids || [])[0] === target.uid ? "selected" : ""}>${escapeHtml(target.label)}</option>`).join("")}</select></label><label class="form-field"><span>Nueva especie</span>${speciesInput(event.species)}</label></div>`;
  } else {
    html += `<label class="form-field"><span>Nombre o contexto</span><input name="title" value="${escapeHtml(event.title || "")}" placeholder="Team 1" required></label>`;
  }
  $("#event-fields").innerHTML = html;
  $("#event-enabled").checked = event.enabled;
  $("#event-type")?.addEventListener("change", (input) => {
    state.draft.type = input.target.value;
    state.draft.target_uids = [];
    if (state.draft.type === "capture") state.draft.uid ||= `pokemon-${state.draft.id}`;
    renderEventFields();
  });
}

function openEvent(id) {
  const event = state.events.find((candidate) => candidate.id === id);
  if (!event) return;
  state.draft = structuredClone(event);
  $("#event-modal-title").textContent = `${state.editingNew ? "Añadir" : "Editar"} ${TYPE_LABELS[event.type].toLowerCase()}`;
  $("#event-source").textContent = event.source || "Evento añadido manualmente";
  $("#delete-event").hidden = !state.editingNew && !event.id.startsWith("event-manual");
  renderEventFields();
  $("#event-modal").hidden = false;
}

function closeEventModal() {
  if (state.editingNew && state.draft) {
    state.events = state.events.filter((event) => event.id !== state.draft.id);
    recalculate();
  }
  state.editingNew = false;
  state.draft = null;
  $("#event-modal").hidden = true;
}

function resolveSpecies(value) {
  const key = normalize(value);
  const entry = state.pokedex.find((pokemon) => normalize(pokemon.display) === key || normalize(pokemon.name) === key);
  return { species: value.trim(), species_id: entry?.id || null, species_identifier: entry?.name || "" };
}

function saveEvent(event) {
  event.preventDefault();
  const draft = state.draft;
  const form = new FormData($("#event-form"));
  if (state.editingNew) draft.type = form.get("event-type") || draft.type;
  if (draft.type === "capture") {
    const species = String(form.get("species") || "").trim();
    const nickname = String(form.get("nickname") || "").trim();
    if (!species || !nickname) return showToast("Completa la especie y el apodo.");
    Object.assign(draft, resolveSpecies(species), { nickname });
    draft.uid ||= `pokemon-${draft.id}`;
  } else if (draft.type === "death") {
    draft.target_uids = form.getAll("targets").map(String);
    if (!draft.target_uids.length) return showToast("Selecciona al menos un integrante.");
  } else if (draft.type === "evolution") {
    const species = String(form.get("species") || "").trim();
    const target = String(form.get("target") || "");
    if (!species || !target) return showToast("Selecciona el integrante y su nueva especie.");
    Object.assign(draft, resolveSpecies(species), { target_uids: [target] });
  } else {
    draft.title = String(form.get("title") || "").trim();
    if (!draft.title) return showToast("Escribe un nombre para el checkpoint.");
  }
  draft.enabled = $("#event-enabled").checked;
  draft.needs_review = false;
  const index = state.events.findIndex((candidate) => candidate.id === draft.id);
  if (index >= 0) state.events[index] = draft;
  state.editingNew = false;
  state.draft = null;
  $("#event-modal").hidden = true;
  recalculate();
  warmSprites();
  showToast("Evento guardado. Los checkpoints se recalcularon.");
}

function addEvent() {
  const id = `event-manual-${Date.now()}`;
  const checkpoint = state.checkpoints[state.selected];
  const insertAt = checkpoint ? state.events.findIndex((event) => event.id === checkpoint.event_id) : state.events.length;
  const event = {
    id,
    uid: `pokemon-${id}`,
    type: "capture",
    page: checkpoint?.page || 0,
    source: "Añadido manualmente",
    enabled: true,
    needs_review: true,
    notes: [],
    species: "",
    species_id: null,
    nickname: "",
  };
  state.events.splice(insertAt < 0 ? state.events.length : insertAt, 0, event);
  state.editingNew = true;
  openEvent(id);
}

function syncDesignControls() {
  $("#setting-background").value = state.settings.background;
  $("#setting-columns").value = state.settings.columns;
  $("#setting-sprites").checked = state.settings.sprites;
  $("#setting-title").checked = state.settings.title;
}

function activateTab(name) {
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  for (const tab of ["text", "events", "design"]) $(`#tab-${tab}`).hidden = tab !== name;
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > 40 * 1024 * 1024) return showToast("El PDF supera el límite de 40 MB.");
  $("#loading-title").textContent = "Leyendo tu guion";
  $("#loading-detail").textContent = "Extrayendo texto, colores y eventos…";
  $("#loading").hidden = false;
  try {
    let result;
    if (WEB_MODE) {
      const { parsePdf } = await import("./parser.js");
      result = await parsePdf(await file.arrayBuffer(), file.name, (page, total) => {
        $("#loading-detail").textContent = `Leyendo página ${page} de ${total} en tu navegador…`;
      });
    } else {
      const response = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(file.name) },
        body: file,
      });
      result = await response.json();
      if (!response.ok) throw new Error(result.error || "No se pudo leer el PDF.");
    }
    state.filename = result.filename;
    state.events = result.events;
    state.selected = 0;
    state.filter = "all";
    recalculate();
    warmSprites();
    showToast(`${result.summary.checkpoints} checkpoints generados. Revisa las observaciones antes de exportar.`);
  } catch (error) {
    showToast(error.message || "No se pudo procesar el PDF.");
  } finally {
    $("#loading").hidden = true;
    $("#file-input").value = "";
  }
}

function svgToPng(svg) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1920;
      canvas.height = 1080;
      canvas.getContext("2d").drawImage(image, 0, 0, 1920, 1080);
      URL.revokeObjectURL(url);
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error("No se pudo generar el PNG.")), "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo renderizar la plantilla."));
    };
    image.src = url;
  });
}

async function blobToBase64(blob) {
  return (await blobToDataUrl(blob)).split(",")[1];
}

function validateForExport() {
  const incomplete = state.events.some((event) => event.enabled && (
    (event.type === "capture" && (!event.species || !event.nickname)) ||
    (event.type === "death" && !(event.target_uids || []).length) ||
    (event.type === "evolution" && (!event.species || !(event.target_uids || []).length))
  ));
  if (incomplete) {
    state.filter = "review";
    activateTab("events");
    renderEvents();
    showToast("Hay eventos incompletos. Asigna sus datos antes de exportar.");
    return false;
  }
  return true;
}

async function downloadCurrent(format) {
  const checkpoint = state.checkpoints[state.selected];
  if (!checkpoint || !validateForExport()) return;
  const button = $(`#download-${format}`);
  button.disabled = true;
  try {
    const svg = await exportSvg(checkpoint);
    const base = `checkpoint-${String(checkpoint.number).padStart(2, "0")}`;
    if (format === "svg") downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${base}.svg`);
    else downloadBlob(await svgToPng(svg), `${base}.png`);
    showToast(`Checkpoint ${checkpoint.number} exportado en ${format.toUpperCase()}.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function exportAll() {
  if (!validateForExport()) {
    $("#export-modal").hidden = true;
    return;
  }
  const format = $("input[name='export-format']:checked").value;
  const button = $("#confirm-export");
  button.disabled = true;
  try {
    const files = [];
    for (const checkpoint of state.checkpoints) {
      $("#export-progress").textContent = `Preparando ${checkpoint.number}/${state.checkpoints.length}…`;
      const svg = await exportSvg(checkpoint);
      const name = `checkpoint-${String(checkpoint.number).padStart(2, "0")}.${format}`;
      if (format === "svg") files.push({ name, content: svg });
      else files.push({ name, content: await blobToBase64(await svgToPng(svg)), encoding: "base64" });
    }
    $("#export-progress").textContent = "Creando ZIP…";
    const payload = {
      project_name: projectName(),
      text: checkpointsText(),
      project: { filename: state.filename, events: state.events, checkpoints: state.checkpoints, settings: state.settings },
      files,
    };
    let blob;
    if (WEB_MODE) {
      const { createZip } = await import("./web-export.js");
      blob = createZip(payload);
    } else {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("No se pudo crear el paquete ZIP.");
      blob = await response.blob();
    }
    downloadBlob(blob, `${projectName().replace(/[^a-zA-Z0-9áéíóúñ]+/gi, "-")}-checkpoints.zip`);
    $("#export-modal").hidden = true;
    showToast("Paquete completo descargado.");
  } catch (error) {
    showToast(error.message);
  } finally {
    $("#export-progress").textContent = "";
    button.disabled = false;
  }
}

function bindEvents() {
  $("#dropzone").addEventListener("click", () => $("#file-input").click());
  $("#dropzone").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") $("#file-input").click();
  });
  $("#file-input").addEventListener("change", (event) => handleFile(event.target.files[0]));
  for (const name of ["dragenter", "dragover"]) $("#dropzone").addEventListener(name, (event) => {
    event.preventDefault();
    $("#dropzone").classList.add("dragging");
  });
  for (const name of ["dragleave", "drop"]) $("#dropzone").addEventListener(name, (event) => {
    event.preventDefault();
    $("#dropzone").classList.remove("dragging");
  });
  $("#dropzone").addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
  $("#open-button").addEventListener("click", () => {
    if (confirm("Abrir otro PDF reemplazará el proyecto actual. Exporta tu trabajo si quieres conservarlo.")) $("#file-input").click();
  });
  $$(".tab").forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.tab)));
  $$(".filter").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    renderEvents();
  }));
  $("#review-button").addEventListener("click", () => {
    state.filter = "review";
    activateTab("events");
    renderEvents();
    $(".detail-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("#add-event").addEventListener("click", addEvent);
  $("#event-form").addEventListener("submit", saveEvent);
  $$("[data-close]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.close === "event-modal") closeEventModal();
    else $(`#${button.dataset.close}`).hidden = true;
  }));
  $("#delete-event").addEventListener("click", () => {
    if (!state.draft) return;
    state.events = state.events.filter((event) => event.id !== state.draft.id);
    state.editingNew = false;
    state.draft = null;
    $("#event-modal").hidden = true;
    recalculate();
    showToast("Evento eliminado.");
  });
  for (const [selector, key, type] of [
    ["#setting-background", "background", "value"],
    ["#setting-columns", "columns", "value"],
    ["#setting-sprites", "sprites", "checked"],
    ["#setting-title", "title", "checked"],
  ]) $(selector).addEventListener("change", (event) => {
    state.settings[key] = type === "checked" ? event.target.checked : event.target.value;
    persist();
    renderPreview();
  });
  $("#copy-text").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(checkpointsText());
      showToast("Registro completo copiado.");
    } catch {
      showToast("El navegador no permitió copiar; descarga el TXT.");
    }
  });
  $("#download-text").addEventListener("click", () => downloadBlob(new Blob([checkpointsText()], { type: "text/plain;charset=utf-8" }), "registro-checkpoints.txt"));
  $("#download-svg").addEventListener("click", () => downloadCurrent("svg"));
  $("#download-png").addEventListener("click", () => downloadCurrent("png"));
  $("#export-button").addEventListener("click", () => {
    $("#export-file-count").textContent = `${state.checkpoints.length} plantillas`;
    $("#export-modal").hidden = false;
  });
  $("#confirm-export").addEventListener("click", exportAll);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#event-modal").hidden) closeEventModal();
    $("#export-modal").hidden = true;
  });
}

async function initialize() {
  bindEvents();
  const response = await fetch("./data/pokemon.json");
  const entries = await response.json();
  state.pokedex = entries.map((entry) => ({
    ...entry,
    display: entry.name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
  }));
  $("#pokemon-names").innerHTML = state.pokedex.map((entry) => `<option value="${escapeHtml(entry.display)}"></option>`).join("");
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const project = JSON.parse(saved);
      state.filename = project.filename;
      state.events = project.events || [];
      state.settings = { ...state.settings, ...project.settings };
      recalculate();
      warmSprites();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  } else {
    renderAll();
  }
}

initialize();
