// PDF version of the text log, written by hand so it works the same in web and
// local mode. Text uses the built-in Helvetica (selectable, no embedded font);
// the 💀🟪🟩 markers are drawn as small images because PDF base fonts have no emoji.

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_BOTTOM = PAGE_HEIGHT - MARGIN;
// Arial and Liberation Sans share Helvetica's metrics, so canvas widths match the PDF.
const FONT_STACK = "Helvetica, Arial, 'Liberation Sans', sans-serif";
const MARKER_PIXELS = 96;
const MARKERS = [
  { key: "dead", emoji: "💀", label: "Baja" },
  { key: "evolved", emoji: "🟪", label: "Evolución" },
  { key: "new", emoji: "🟩", label: "Captura" },
];
const COLORS = {
  text: "0.11 0.11 0.13",
  muted: "0.45 0.46 0.5",
  accent: "0.25 0.44 0.71",
  rule: "0.86 0.87 0.89",
};
const HEADING = { size: 12, height: 22 };
const LINE = { size: 11, height: 17 };
const BLOCK_GAP = 16;
// Characters outside Latin-1 that WinAnsiEncoding still has, with their byte.
const WIN_ANSI_EXTRAS = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "•": 0x95, "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "™": 0x99, "Œ": 0x8c, "œ": 0x9c };

const encoder = new TextEncoder();

function toWinAnsi(text) {
  return [...String(text ?? "")].map((character) => {
    const code = character.codePointAt(0);
    if ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS[character]) return character;
    if (/[​-‍︀-️]/.test(character)) return "";
    if (/\s/.test(character)) return " ";
    const plain = character.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    return /^[\x20-\x7e]$/.test(plain) ? plain : "?";
  }).join("");
}

function pdfString(text) {
  let literal = "";
  for (const character of text) {
    const byte = WIN_ANSI_EXTRAS[character] ?? character.codePointAt(0);
    if ("()\\".includes(character)) literal += `\\${character}`;
    else if (byte < 0x80) literal += character;
    else literal += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `(${literal})`;
}

function utf16Hex(text) {
  let hex = "FEFF";
  for (let index = 0; index < text.length; index++) hex += text.charCodeAt(index).toString(16).padStart(4, "0");
  return `<${hex}>`;
}

function number(value) {
  return String(Math.round(value * 100) / 100);
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function rasterizeEmoji(emoji) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = MARKER_PIXELS;
  const context = canvas.getContext("2d");
  context.font = `${MARKER_PIXELS * 0.78}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(emoji, MARKER_PIXELS / 2, MARKER_PIXELS / 2);
  const { data } = context.getImageData(0, 0, MARKER_PIXELS, MARKER_PIXELS);
  const rgb = new Uint8Array(MARKER_PIXELS * MARKER_PIXELS * 3);
  const alpha = new Uint8Array(MARKER_PIXELS * MARKER_PIXELS);
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    rgb.set(data.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
    alpha[pixel] = data[pixel * 4 + 3];
  }
  return { rgb: await deflate(rgb), alpha: await deflate(alpha) };
}

function createPageWriter() {
  const measure = document.createElement("canvas").getContext("2d");
  const pages = [];
  let operations;
  const writer = {
    y: MARGIN,
    pages,
    newPage() {
      operations = [];
      pages.push(operations);
      writer.y = MARGIN;
    },
    width(text, size, bold = false) {
      measure.font = `${bold ? "bold " : ""}${size}px ${FONT_STACK}`;
      // PDF text is drawn without kerning, so measure it the same way.
      measure.fontKerning = "none";
      return measure.measureText(text).width;
    },
    // `baseline` is measured from the top of the page, like the layout code.
    text(text, x, baseline, { size, bold = false, color = COLORS.text }) {
      operations.push(`${color} rg BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${number(x)} ${number(PAGE_HEIGHT - baseline)} Tm ${pdfString(text)} Tj ET`);
      return x + writer.width(text, size, bold);
    },
    marker(key, x, baseline, size) {
      const side = size * 1.15;
      const bottom = PAGE_HEIGHT - baseline - size * 0.22;
      operations.push(`q ${number(side)} 0 0 ${number(side)} ${number(x)} ${number(bottom)} cm /M${key} Do Q`);
      return x + side;
    },
    rule(baseline) {
      operations.push(`${COLORS.rule} RG 0.75 w ${MARGIN} ${number(PAGE_HEIGHT - baseline)} m ${number(PAGE_WIDTH - MARGIN)} ${number(PAGE_HEIGHT - baseline)} l S`);
    },
  };
  writer.newPage();
  return writer;
}

function writeHeader(page, title, checkpointCount) {
  page.text(title, MARGIN, page.y + 20, { size: 20, bold: true });
  const subtitle = `Registro de checkpoints · ${checkpointCount} ${checkpointCount === 1 ? "checkpoint" : "checkpoints"}`;
  page.text(subtitle, MARGIN, page.y + 40, { size: 10, color: COLORS.muted });
  let x = MARGIN;
  for (const marker of MARKERS) {
    x = page.marker(marker.key, x, page.y + 58, 9) + 3;
    x = page.text(marker.label, x, page.y + 58, { size: 9, color: COLORS.muted }) + 14;
  }
  page.rule(page.y + 72);
  page.y += 72 + 26;
}

function pokemonLine(pokemon, index) {
  return toWinAnsi(`${index + 1}. ${pokemon.species} (${pokemon.nickname})`);
}

function writeCheckpoint(page, checkpoint) {
  const blockHeight = HEADING.height + checkpoint.pokemon.length * LINE.height;
  const fitsOnOnePage = blockHeight <= CONTENT_BOTTOM - MARGIN;
  if (page.y + blockHeight > CONTENT_BOTTOM && page.y > MARGIN && fitsOnOnePage) page.newPage();
  page.text(toWinAnsi(`CHECKPOINT ${checkpoint.number} — ${checkpoint.title}`), MARGIN, page.y + HEADING.size, { size: HEADING.size, bold: true, color: COLORS.accent });
  page.y += HEADING.height;
  checkpoint.pokemon.forEach((pokemon, index) => {
    if (page.y + LINE.height > CONTENT_BOTTOM) page.newPage();
    const baseline = page.y + LINE.size;
    let x = page.text(pokemonLine(pokemon, index), MARGIN, baseline, { size: LINE.size });
    for (const marker of MARKERS) {
      if (pokemon[marker.key]) x = page.marker(marker.key, x + LINE.size * 0.3, baseline, LINE.size);
    }
    page.y += LINE.height;
  });
  page.y += BLOCK_GAP;
}

function writeFooters(page) {
  page.pages.forEach((operations, index) => {
    const label = `${index + 1} / ${page.pages.length}`;
    const x = (PAGE_WIDTH - page.width(label, 8)) / 2;
    operations.push(`${COLORS.muted} rg BT /F1 8 Tf 1 0 0 1 ${number(x)} ${number(MARGIN / 2)} Tm ${pdfString(label)} Tj ET`);
  });
}

function serialize(objects) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (part) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  push("%PDF-1.4\n%âãÏÓ\n");
  objects.forEach((object, index) => {
    offsets.push(length);
    push(`${index + 1} 0 obj\n`);
    if (typeof object === "string") {
      push(object);
    } else {
      push(`<< ${object.dictionary} /Length ${object.stream.length} >>\nstream\n`);
      push(object.stream);
      push("\nendstream");
    }
    push("\nendobj\n");
  });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: "application/pdf" });
}

export async function createRegistroPdf({ title, checkpoints }) {
  const page = createPageWriter();
  writeHeader(page, toWinAnsi(title), checkpoints.length);
  checkpoints.forEach((checkpoint) => writeCheckpoint(page, checkpoint));
  writeFooters(page);

  // Object numbers: 1 catalog, 2 page tree, 3–4 fonts, 5 info, then an image and
  // its alpha mask per marker, then a page and its content stream per page.
  const firstImage = 6;
  const firstPage = firstImage + MARKERS.length * 2;
  const images = await Promise.all(MARKERS.map((marker) => rasterizeEmoji(marker.emoji)));
  const xObjects = MARKERS.map((marker, index) => `/M${marker.key} ${firstImage + index * 2} 0 R`).join(" ");
  const pageRefs = page.pages.map((_, index) => `${firstPage + index * 2} 0 R`).join(" ");
  const imageFormat = `/Type /XObject /Subtype /Image /Width ${MARKER_PIXELS} /Height ${MARKER_PIXELS} /BitsPerComponent 8 /Filter /FlateDecode`;

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${page.pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title ${utf16Hex(`${title} — Registro de checkpoints`)} /Producer (Checkpoint Studio) >>`,
  ];
  images.forEach((image, index) => {
    objects.push({ dictionary: `${imageFormat} /ColorSpace /DeviceRGB /SMask ${firstImage + index * 2 + 1} 0 R`, stream: image.rgb });
    objects.push({ dictionary: `${imageFormat} /ColorSpace /DeviceGray`, stream: image.alpha });
  });
  page.pages.forEach((operations, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xObjects} >> >> /Contents ${firstPage + index * 2 + 1} 0 R >>`);
    objects.push({ dictionary: "", stream: encoder.encode(operations.join("\n")) });
  });
  return serialize(objects);
}
