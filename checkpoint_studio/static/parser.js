import * as pdfjs from "./vendor/pdf.mjs";
import { loadPokedex, parseParagraphs } from "./events.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", import.meta.url).href;

export { Pokedex, parseParagraphs } from "./events.js";

const COLOR_HUES = { red: 4, green: 145, blue: 210, purple: 278 };

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
