"""Gitnix SDK - Binary/Image Storage.

Chunked encrypted file storage with MIME detection.
"""

from __future__ import annotations

import hashlib
import time
from base64 import b64encode
from typing import Any, Callable

from gitnix.errors import GitnixError, GitnixErrorCode
from gitnix.types import BinaryMetadata, DownloadOptions, UploadOptions

DEFAULT_CHUNK_SIZE = 512 * 1024  # 512 KB
MAX_FILE_SIZE = 95 * 1024 * 1024  # 95 MB
BINARY_COLLECTION = "__binaries__"

# Magic byte signatures for MIME detection
MIME_SIGNATURES = [
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG", "image/png"),
    (b"GIF8", "image/gif"),
    (b"RIFF", "image/webp"),
    (b"%PDF", "application/pdf"),
    (b"PK\x03\x04", "application/zip"),
    (b"\x1f\x8b", "application/gzip"),
]


class BinaryStorage:
    """Handles chunked encrypted binary file storage."""

    def __init__(
        self,
        transport: Any,
        cache: Any,
        storage_manager: Any,
        key_manager: Any,
    ) -> None:
        self._transport = transport
        self._cache = cache
        self._storage_manager = storage_manager
        self._key_manager = key_manager

    async def upload(self, data: bytes, options: UploadOptions | None = None) -> BinaryMetadata:
        """Upload a binary file (chunked, encrypted)."""
        opts = options or UploadOptions()

        if len(data) == 0:
            raise GitnixError("Cannot upload empty file", GitnixErrorCode.UPLOAD_FAILED)
        if len(data) > MAX_FILE_SIZE:
            raise GitnixError(
                f"File size {len(data)} exceeds limit of {MAX_FILE_SIZE}",
                GitnixErrorCode.FILE_TOO_LARGE,
            )

        chunk_size = opts.chunk_size
        file_id = self._generate_id()
        mime_type = opts.mime_type or self._detect_mime(data, opts.filename)
        file_hash = hashlib.sha256(data).hexdigest()

        # Chunk the data
        chunks = [data[i : i + chunk_size] for i in range(0, len(data), chunk_size)]
        total_chunks = len(chunks)

        # Get storage allocation
        allocation = await self._storage_manager.get_allocation(
            BINARY_COLLECTION, int(len(data) * 1.5)
        )
        hashed_id = self._key_manager.hash_document_id(BINARY_COLLECTION, file_id)
        base_path = f"binaries/{hashed_id}"

        # Encrypt and prepare batch
        batch_ops: list[dict[str, Any]] = []
        for i, chunk in enumerate(chunks):
            encrypted = self._key_manager.encrypt_bytes_for_collection(BINARY_COLLECTION, chunk)
            batch_ops.append({
                "path": f"{base_path}/chunk_{i:05d}.enc",
                "content": encrypted,
                "encoding": "base64",
            })
            if opts.on_progress:
                opts.on_progress(min((i + 1) / total_chunks * 100, 100.0))

        # Create metadata
        metadata = BinaryMetadata(
            id=file_id,
            filename=opts.filename or f"file_{file_id}",
            mime_type=mime_type,
            size=len(data),
            chunk_count=total_chunks,
            chunk_size=chunk_size,
            hash=file_hash,
            uploaded_at=self._now(),
            metadata=opts.metadata,
            repo=allocation.repo,
        )

        # Add metadata to batch
        encrypted_meta = self._key_manager.encrypt_for_collection(
            BINARY_COLLECTION, self._metadata_to_dict(metadata)
        )
        batch_ops.append({
            "path": f"{base_path}/meta.enc",
            "content": encrypted_meta,
            "encoding": "base64",
        })

        # Write all in one commit
        await self._transport.batch_write(
            batch_ops,
            f"gitnix: upload {metadata.filename} ({self._format_size(len(data))})",
            allocation.repo,
        )

        return metadata

    async def download(self, file_id: str, options: DownloadOptions | None = None) -> bytes:
        """Download a binary file by ID."""
        opts = options or DownloadOptions()
        metadata = await self.get_metadata(file_id)
        if not metadata:
            raise GitnixError(
                f"Binary file not found: {file_id}",
                GitnixErrorCode.DOWNLOAD_FAILED,
            )

        hashed_id = self._key_manager.hash_document_id(BINARY_COLLECTION, file_id)
        base_path = f"binaries/{hashed_id}"
        repo = metadata.repo

        files = await self._transport.list_files(base_path, repo)
        chunk_files = sorted(
            [f for f in files if "chunk_" in f["path"]],
            key=lambda f: f["path"],
        )

        chunks: list[bytes] = []
        for i, file in enumerate(chunk_files):
            blob = await self._transport.get_blob(file["sha"], repo)
            chunk_data = self._key_manager.decrypt_bytes_for_collection(
                BINARY_COLLECTION, blob["content"]
            )
            chunks.append(chunk_data)
            if opts.on_progress:
                opts.on_progress((i + 1) / len(chunk_files) * 100)

        result = b"".join(chunks)

        if opts.range_start is not None and opts.range_end is not None:
            return result[opts.range_start : opts.range_end + 1]

        return result

    async def get_metadata(self, file_id: str) -> BinaryMetadata | None:
        """Get file metadata without content."""
        hashed_id = self._key_manager.hash_document_id(BINARY_COLLECTION, file_id)
        base_path = f"binaries/{hashed_id}"

        try:
            repo = self._storage_manager.get_collection_repo(BINARY_COLLECTION)
            files = await self._transport.list_files(base_path, repo)
            meta_file = next((f for f in files if f["path"].endswith("meta.enc")), None)
            if not meta_file:
                return None

            blob = await self._transport.get_blob(meta_file["sha"], repo)
            data = self._key_manager.decrypt_for_collection(BINARY_COLLECTION, blob["content"])
            return self._dict_to_metadata(data)
        except GitnixError:
            return None

    async def delete(self, file_id: str) -> bool:
        """Delete a binary file."""
        metadata = await self.get_metadata(file_id)
        if not metadata:
            return False

        hashed_id = self._key_manager.hash_document_id(BINARY_COLLECTION, file_id)
        base_path = f"binaries/{hashed_id}"
        files = await self._transport.list_files(base_path, metadata.repo)

        delete_ops = [{"path": f["path"], "content": "", "delete": True} for f in files]
        if delete_ops:
            await self._transport.batch_write(
                delete_ops, f"gitnix: delete {metadata.filename}", metadata.repo
            )
        return True

    # ─── Helpers ─────────────────────────────────────────────────────────

    def _detect_mime(self, data: bytes, filename: str | None = None) -> str:
        for sig, mime in MIME_SIGNATURES:
            if data[: len(sig)] == sig:
                return mime
        if filename:
            ext = filename.rsplit(".", 1)[-1].lower()
            ext_map = {
                "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                "gif": "image/gif", "pdf": "application/pdf", "zip": "application/zip",
                "json": "application/json", "txt": "text/plain", "html": "text/html",
                "mp3": "audio/mpeg", "mp4": "video/mp4",
            }
            return ext_map.get(ext, "application/octet-stream")
        return "application/octet-stream"

    def _generate_id(self) -> str:
        import os
        timestamp = hex(int(time.time() * 1000))[2:]
        random_part = os.urandom(8).hex()
        return f"{timestamp}-{random_part}"

    def _now(self) -> str:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()

    def _format_size(self, size: int) -> str:
        if size < 1024:
            return f"{size} B"
        if size < 1024 * 1024:
            return f"{size / 1024:.1f} KB"
        return f"{size / (1024 * 1024):.1f} MB"

    def _metadata_to_dict(self, m: BinaryMetadata) -> dict[str, Any]:
        return {
            "id": m.id, "filename": m.filename, "mime_type": m.mime_type,
            "size": m.size, "chunk_count": m.chunk_count, "chunk_size": m.chunk_size,
            "hash": m.hash, "uploaded_at": m.uploaded_at, "metadata": m.metadata,
            "repo": m.repo, "width": m.width, "height": m.height,
        }

    def _dict_to_metadata(self, d: dict[str, Any]) -> BinaryMetadata:
        return BinaryMetadata(
            id=d["id"], filename=d["filename"], mime_type=d["mime_type"],
            size=d["size"], chunk_count=d["chunk_count"], chunk_size=d["chunk_size"],
            hash=d["hash"], uploaded_at=d["uploaded_at"], metadata=d.get("metadata"),
            repo=d.get("repo", ""), width=d.get("width"), height=d.get("height"),
        )
