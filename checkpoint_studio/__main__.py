from __future__ import annotations

import argparse
import threading
import webbrowser

from .server import create_server


def main() -> None:
    parser = argparse.ArgumentParser(description="Checkpoint Studio")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    try:
        server = create_server(args.port)
    except OSError as error:
        parser.exit(1, f"No se pudo abrir el puerto {args.port}: {error}\n")
    url = f"http://127.0.0.1:{args.port}"
    print(f"Checkpoint Studio está disponible en {url}")
    print("Pulsa Ctrl+C para cerrar.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
