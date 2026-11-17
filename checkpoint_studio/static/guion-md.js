// Lee guiones de Guion Studio (.md con colores) sin pasar por el PDF.
// Los colores vienen escritos en el archivo, así que no hay que adivinarlos por píxeles:
//   1. <span data-color="green">Lo atrapé y le puse Furia.</span>
import { loadPokedex, parseParagraphs } from "./events.js";

const COLOR_MAP = { green: "green", teal: "green", red: "red", blue: "blue", purple: "purple" };
const TOKEN = /<(\/?)(span|mark)\b([^>]*)>|<[^>]*>|&[a-zA-Z#0-9]+;|\\[\s\S]|[\s\S]/g;

function splitFrontMatter(text) {
  const match = text.match(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? text.slice(match[0].length) : text;
}

function decodeEntity(entity) {
  const named = { "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };
  if (named[entity]) return named[entity];
  const numeric = entity.match(/^&#(x?)([0-9a-f]+);$/i);
  return numeric ? String.fromCodePoint(parseInt(numeric[2], numeric[1] ? 16 : 10)) : entity;
}

// Devuelve el texto plano de una línea y cuántos caracteres hay de cada color.
export function readInline(markdown) {
  const stack = [];
  const colors = {};
  let text = "";
  for (const match of markdown.matchAll(TOKEN)) {
    const [token, closing, tag, attributes] = match;
    if (tag) {
      if (closing) stack.pop();
      else stack.push(COLOR_MAP[(attributes.match(/data-color\s*=\s*"([^"]*)"/i) || [])[1]] || null);
      continue;
    }
    let piece;
    if (token.startsWith("<")) piece = /^<br\b/i.test(token) ? " " : "";
    else if (token.startsWith("&")) piece = decodeEntity(token);
    else if (token.startsWith("\\")) piece = token[1];
    else if (token === "*" || token === "`" || token === "~") piece = "";
    else piece = token;
    if (!piece) continue;
    text += piece;
    if (/\S/.test(piece)) {
      for (const color of new Set(stack.filter(Boolean))) colors[color] = (colors[color] || 0) + piece.length;
    }
  }
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return { text, colors };
}

export function markdownParagraphs(markdown) {
  const lines = splitFrontMatter(String(markdown || "")).split(/\r?\n/);
  const paragraphs = [];
  let current = null;
  let section = "";
  let sectionNumber = 0;
  let fence = null;

  function push(raw, kind) {
    const { text, colors } = readInline(raw);
    if (!text) {
      current = null;
      return;
    }
    current = { text, colors, page: Math.max(1, sectionNumber), section, kind };
    paragraphs.push(current);
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fence) {
      if (fenceMatch && fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      current = null;
      continue;
    }
    if (!line.trim()) {
      current = null;
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      sectionNumber += 1;
      section = readInline(heading[2]).text;
      push(heading[2], "heading");
      current = null;
      continue;
    }
    const content = line.replace(/^\s*(?:>\s?)+/, "");
    const item = content.match(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(.*)$/);
    if (item) {
      push(item[1], "item");
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(content)) {
      current = null;
      continue;
    }
    if (current && current.kind !== "heading") {
      const next = readInline(content);
      current.text = `${current.text} ${next.text}`.trim();
      for (const [color, count] of Object.entries(next.colors)) current.colors[color] = (current.colors[color] || 0) + count;
    } else {
      push(content, "text");
    }
  }
  return paragraphs.map(({ kind, ...paragraph }) => paragraph);
}

export function isGuionMarkdown(filename) {
  return /\.(md|markdown)$/i.test(filename || "");
}

export async function parseGuionMarkdown(markdown, filename = "guion.md") {
  const paragraphs = markdownParagraphs(markdown);
  const pokedex = await loadPokedex();
  const result = parseParagraphs(paragraphs, pokedex, filename, 0);
  if (!result.checkpoints.length) {
    throw new Error("No encontré checkpoints: falta al menos una línea azul con la palabra «team».");
  }
  return result;
}
