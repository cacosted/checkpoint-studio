import { cpSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, "checkpoint_studio", "static", "vendor");
const pdfjs = join(root, "node_modules", "pdfjs-dist");
const fflate = join(root, "node_modules", "fflate");

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
for (const file of ["pdf.mjs", "pdf.worker.mjs"]) {
  copyFileSync(join(pdfjs, "legacy", "build", file), join(vendor, file));
}
cpSync(join(pdfjs, "cmaps"), join(vendor, "cmaps"), { recursive: true });
cpSync(join(pdfjs, "standard_fonts"), join(vendor, "standard_fonts"), { recursive: true });
copyFileSync(join(pdfjs, "LICENSE"), join(vendor, "pdfjs-LICENSE"));
copyFileSync(join(fflate, "esm", "browser.js"), join(vendor, "fflate.js"));
copyFileSync(join(fflate, "LICENSE"), join(vendor, "fflate-LICENSE"));
console.log("Recursos web generados en checkpoint_studio/static/vendor/");
