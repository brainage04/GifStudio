#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import tempfile
from email.parser import BytesParser
from email.policy import default
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from gif_overlay import OverlaySettings, render_overlay_gif


ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
BASE_GIF = ROOT / "base_gifs" / "woman_is_talking.gif"
DEFAULT_OVERLAY_IMAGE = ROOT / "overlay_images" / "brainage.jpg"
HOST = "127.0.0.1"
PORT = 8000


class OverlayHandler(BaseHTTPRequestHandler):
    server_version = "WomanGifOverlay/1.0"

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self._serve_file(WEB_DIR / "index.html", "text/html; charset=utf-8")
            return
        if path == "/styles.css":
            self._serve_file(WEB_DIR / "styles.css", "text/css; charset=utf-8")
            return
        if path == "/app.js":
            self._serve_file(WEB_DIR / "app.js", "application/javascript; charset=utf-8")
            return
        if path == "/base.gif":
            self._serve_file(BASE_GIF, "image/gif")
            return
        if path == "/default-overlay-image":
            self._serve_file(DEFAULT_OVERLAY_IMAGE)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/render":
            self._handle_render()
            return
        if path == "/api/fetch-base-gif":
            self._handle_fetch_base_gif()
            return
        if path == "/api/fetch-overlay-image":
            self._handle_fetch_overlay_image()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def _handle_render(self) -> None:
        try:
            overlay_bytes, overlay_name, base_bytes, base_name, settings = self._parse_upload()
            with tempfile.TemporaryDirectory() as tmpdir:
                tmpdir_path = Path(tmpdir)
                overlay_suffix = Path(overlay_name or "overlay.webp").suffix or ".webp"
                input_path = tmpdir_path / f"overlay{overlay_suffix}"
                output_path = tmpdir_path / "rendered.gif"
                input_path.write_bytes(overlay_bytes)

                base_path = BASE_GIF
                if base_bytes is not None:
                    base_suffix = Path(base_name or "base.gif").suffix or ".gif"
                    base_path = tmpdir_path / f"base{base_suffix}"
                    base_path.write_bytes(base_bytes)

                render_overlay_gif(base_path, input_path, output_path, settings)
                gif_bytes = output_path.read_bytes()
        except ValueError as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/gif")
        self.send_header("Content-Length", str(len(gif_bytes)))
        self.send_header(
            "Content-Disposition",
            'attachment; filename="woman_is_talking_overlay.gif"',
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(gif_bytes)

    def _handle_fetch_base_gif(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            self._send_json({"error": "Empty request body"}, HTTPStatus.BAD_REQUEST)
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON body"}, HTTPStatus.BAD_REQUEST)
            return

        url = str(payload.get("url", "")).strip()
        if not url:
            self._send_json({"error": "URL is required"}, HTTPStatus.BAD_REQUEST)
            return

        try:
            gif_bytes, filename = self._fetch_remote_gif(url)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/gif")
        self.send_header("Content-Length", str(len(gif_bytes)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(gif_bytes)

    def _handle_fetch_overlay_image(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            self._send_json({"error": "Empty request body"}, HTTPStatus.BAD_REQUEST)
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON body"}, HTTPStatus.BAD_REQUEST)
            return

        url = str(payload.get("url", "")).strip()
        if not url:
            self._send_json({"error": "URL is required"}, HTTPStatus.BAD_REQUEST)
            return

        try:
            image_bytes, filename, content_type = self._fetch_remote_image(url)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(image_bytes)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(image_bytes)

    def log_message(self, format: str, *args: object) -> None:
        return

    def _parse_upload(self) -> tuple[bytes, str, bytes | None, str | None, OverlaySettings]:
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            raise ValueError("Expected multipart form data")

        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise ValueError("Empty request body")

        body = self.rfile.read(content_length)
        message = BytesParser(policy=default).parsebytes(
            (
                f"Content-Type: {content_type}\r\n"
                "MIME-Version: 1.0\r\n\r\n"
            ).encode("utf-8")
            + body
        )

        overlay_bytes: bytes | None = None
        overlay_name = "overlay.webp"
        base_bytes: bytes | None = None
        base_name: str | None = None
        fields: dict[str, str] = {}

        for part in message.iter_parts():
            if part.get_content_disposition() != "form-data":
                continue

            field_name = part.get_param("name", header="content-disposition")
            if not field_name:
                continue

            payload = part.get_payload(decode=True) or b""
            filename = part.get_filename()
            if filename:
                if field_name == "overlay":
                    overlay_bytes = payload
                    overlay_name = filename
                elif field_name == "baseGif":
                    base_bytes = payload
                    base_name = filename
                continue

            charset = part.get_content_charset() or "utf-8"
            fields[field_name] = payload.decode(charset).strip()

        if overlay_bytes is None:
            raise ValueError("Missing overlay file")
        if not overlay_bytes:
            raise ValueError("Uploaded overlay file is empty")

        settings = OverlaySettings(
            x=self._coerce_rounded_int(fields.get("x"), 58),
            y=self._coerce_rounded_int(fields.get("y"), 0),
            width=self._coerce_optional_rounded_int(fields.get("width")),
            height=self._coerce_optional_rounded_int(fields.get("height")),
            scale_divisor=self._coerce_float(fields.get("scaleDivisor"), 2.0),
            loop=0,
        )
        return overlay_bytes, overlay_name, base_bytes, base_name, settings

    @staticmethod
    def _coerce_rounded_int(value: str | None, default: int) -> int:
        if value in (None, ""):
            return default
        return round(float(value))

    @staticmethod
    def _coerce_optional_rounded_int(value: str | None) -> int | None:
        if value in (None, ""):
            return None
        return round(float(value))

    @staticmethod
    def _coerce_float(value: str | None, default: float) -> float:
        if value in (None, ""):
            return default
        return float(value)

    def _serve_file(self, path: Path, content_type: str | None = None) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        data = path.read_bytes()
        guessed_type = (
            content_type
            or mimetypes.guess_type(path.name)[0]
            or "application/octet-stream"
        )
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", guessed_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _fetch_remote_gif(self, url: str) -> tuple[bytes, str]:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("Only http and https GIF URLs are supported")

        request = Request(
            url,
            headers={
                "User-Agent": "WomanGifOverlay/1.0",
                "Accept": "image/gif,image/*;q=0.8,*/*;q=0.1",
            },
        )

        try:
            with urlopen(request, timeout=20) as response:
                gif_bytes = response.read()
                content_type = response.headers.get_content_type() or "application/octet-stream"
        except HTTPError as exc:
            raise ValueError(f"GIF fetch failed: {exc.reason}") from exc
        except URLError as exc:
            raise ValueError(f"GIF fetch failed: {exc.reason}") from exc

        if not self._is_gif_bytes(gif_bytes):
            raise ValueError(
                f"URL did not return a valid GIF (content type was {content_type})"
            )

        filename = Path(parsed.path).name or "base.gif"
        if not filename.lower().endswith(".gif"):
            filename = f"{filename}.gif"
        return gif_bytes, filename

    def _fetch_remote_image(self, url: str) -> tuple[bytes, str, str]:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("Only http and https image URLs are supported")

        request = Request(
            url,
            headers={
                "User-Agent": "WomanGifOverlay/1.0",
                "Accept": "image/*,*/*;q=0.1",
            },
        )

        try:
            with urlopen(request, timeout=20) as response:
                image_bytes = response.read()
                content_type = response.headers.get_content_type() or "application/octet-stream"
        except HTTPError as exc:
            raise ValueError(f"Image fetch failed: {exc.reason}") from exc
        except URLError as exc:
            raise ValueError(f"Image fetch failed: {exc.reason}") from exc

        detected_extension, detected_type = self._detect_image_format(image_bytes)
        if detected_extension is None:
            raise ValueError(
                f"URL did not return a supported image (content type was {content_type})"
            )

        filename = Path(parsed.path).name or f"overlay{detected_extension}"
        if not filename.lower().endswith(detected_extension):
            filename = f"{filename}{detected_extension}"
        return image_bytes, filename, detected_type

    @staticmethod
    def _is_gif_bytes(data: bytes) -> bool:
        return data.startswith((b"GIF87a", b"GIF89a"))

    @staticmethod
    def _detect_image_format(data: bytes) -> tuple[str | None, str | None]:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return ".png", "image/png"
        if data.startswith(b"\xff\xd8\xff"):
            return ".jpg", "image/jpeg"
        if data.startswith((b"GIF87a", b"GIF89a")):
            return ".gif", "image/gif"
        if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            return ".webp", "image/webp"
        return None, None

    def _send_json(self, payload: dict[str, str], status: HTTPStatus) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    if not BASE_GIF.is_file():
        raise SystemExit(f"Base GIF not found: {BASE_GIF}")

    port = int(os.environ.get("PORT", PORT))
    server = ThreadingHTTPServer((HOST, port), OverlayHandler)
    print(f"Serving on http://{HOST}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
