import { strToU8, zipSync } from "./vendor/fflate.js";

function binary(content) {
  const decoded = atob(content);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function createZip({ text, project, files }) {
  const entries = {
    "registro.txt": strToU8(text),
    "proyecto.json": strToU8(JSON.stringify(project, null, 2)),
  };
  files.forEach((file, index) => {
    const name = (file.name || `checkpoint-${String(index + 1).padStart(2, "0")}.svg`).split("/").pop();
    entries[`plantillas/${name}`] = file.encoding === "base64" ? binary(file.content) : strToU8(file.content);
  });
  return new Blob([zipSync(entries, { level: 6 })], { type: "application/zip" });
}
