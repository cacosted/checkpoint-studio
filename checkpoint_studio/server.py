from __future__ import annotations

import base64
import io
import json
import re
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

from .parser import parse_pdf


MAX_PDF_SIZE = 40 * 1024 * 1024
MAX_EXPORT_SIZE = 180 * 1024 * 1024


class StudioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        static_dir = Path(__file__).parent / "static"
        super().__init__(*args, directory=str(static_dir), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            self._json({"ok": True})
            return
        super().do_GET()

    def do_POST(self):
        try:
            if self.path == "/api/parse":
                self._parse()
            elif self.path == "/api/export":
                self._export()
            else:
                self._json({"error": "Ruta no encontrada."}, 404)
        except ValueError as error:
            self._json({"error": str(error)}, 400)
        except Exception as error:
            print(f"Error procesando la solicitud: {error}")
            self._json({"error": "No se pudo procesar la solicitud. Revisa el archivo e inténtalo de nuevo."}, 500)

    def _body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise ValueError("La solicitud está vacía.")
        if length > limit:
            raise ValueError("El archivo supera el tamaño máximo permitido.")
        return self.rfile.read(length)

    def _parse(self):
        body = self._body(MAX_PDF_SIZE)
        if not body.startswith(b"%PDF"):
            raise ValueError("Selecciona un archivo PDF válido.")
        filename = unquote(self.headers.get("X-Filename", "guion.pdf"))
        result = parse_pdf(body, Path(filename).name)
        if not result["checkpoints"]:
            raise ValueError("No encontré checkpoints azules con la palabra «team» en el PDF.")
        self._json(result)

    def _export(self):
        body = self._body(MAX_EXPORT_SIZE)
        payload = json.loads(body.decode("utf-8"))
        project_name = re.sub(r"[^a-zA-Z0-9_-]+", "-", payload.get("project_name") or "checkpoints").strip("-")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("registro.txt", payload.get("text", ""))
            archive.writestr(
                "proyecto.json",
                json.dumps(payload.get("project", {}), ensure_ascii=False, indent=2),
            )
            for index, item in enumerate(payload.get("files", []), 1):
                name = Path(item.get("name") or f"checkpoint-{index:02}.svg").name
                if item.get("encoding") == "base64":
                    content = base64.b64decode(item["content"])
                else:
                    content = item.get("content", "").encode("utf-8")
                archive.writestr(f"plantillas/{name}", content)
        output = buffer.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(output)))
        self.send_header("Content-Disposition", f'attachment; filename="{project_name or "checkpoints"}.zip"')
        self.end_headers()
        self.wfile.write(output)

    def _json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        if not args or (len(args) > 1 and str(args[1]).startswith("2")):
            return
        super().log_message(format, *args)


def create_server(port: int = 8765) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), StudioHandler)
