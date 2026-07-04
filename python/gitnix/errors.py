"""Gitnix SDK - Error Types."""

from __future__ import annotations

from enum import Enum
from typing import Any


class GitnixErrorCode(str, Enum):
    # Transport
    NETWORK_ERROR = "NETWORK_ERROR"
    RATE_LIMITED = "RATE_LIMITED"
    AUTH_FAILED = "AUTH_FAILED"
    REPO_NOT_FOUND = "REPO_NOT_FOUND"
    API_ERROR = "API_ERROR"

    # Encryption
    ENCRYPTION_FAILED = "ENCRYPTION_FAILED"
    DECRYPTION_FAILED = "DECRYPTION_FAILED"
    INVALID_PASSWORD = "INVALID_PASSWORD"
    KEY_NOT_FOUND = "KEY_NOT_FOUND"
    KDF_FAILED = "KDF_FAILED"

    # Storage
    STORAGE_FULL = "STORAGE_FULL"
    REPO_OVERFLOW = "REPO_OVERFLOW"
    FILE_TOO_LARGE = "FILE_TOO_LARGE"

    # Collection
    COLLECTION_NOT_FOUND = "COLLECTION_NOT_FOUND"
    DOCUMENT_NOT_FOUND = "DOCUMENT_NOT_FOUND"
    DUPLICATE_ID = "DUPLICATE_ID"
    SCHEMA_VIOLATION = "SCHEMA_VIOLATION"
    VALIDATION_ERROR = "VALIDATION_ERROR"

    # Query
    INVALID_QUERY = "INVALID_QUERY"
    INVALID_OPERATOR = "INVALID_OPERATOR"

    # Transaction
    TRANSACTION_CONFLICT = "TRANSACTION_CONFLICT"
    TRANSACTION_TIMEOUT = "TRANSACTION_TIMEOUT"
    TRANSACTION_ABORTED = "TRANSACTION_ABORTED"

    # Binary
    CHUNK_MISSING = "CHUNK_MISSING"
    UPLOAD_FAILED = "UPLOAD_FAILED"
    DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
    INVALID_FILE_TYPE = "INVALID_FILE_TYPE"

    # General
    NOT_CONNECTED = "NOT_CONNECTED"
    ALREADY_CONNECTED = "ALREADY_CONNECTED"
    INVALID_CONFIG = "INVALID_CONFIG"


class GitnixError(Exception):
    """Base exception for all Gitnix SDK errors."""

    def __init__(
        self,
        message: str,
        code: GitnixErrorCode,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}

    def __repr__(self) -> str:
        return f"GitnixError(code={self.code.value}, message={self.args[0]!r})"
