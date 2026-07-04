"""Gitnix SDK - Encryption Layer.

Zero-knowledge client-side encryption using:
- XSalsa20-Poly1305 (via PyNaCl SecretBox)
- Per-record random nonces (24 bytes)
- Fixed-size padding to prevent size analysis
"""

from __future__ import annotations

import json
import struct
from base64 import b64decode, b64encode
from hashlib import sha512
from typing import Any

import nacl.secret
import nacl.utils
from nacl.exceptions import CryptoError

from gitnix.errors import GitnixError, GitnixErrorCode
from gitnix.types import EncryptionConfig

# Constants
BLOB_VERSION = 1
KEY_SIZE = 32
NONCE_SIZE = 24


class Encryption:
    """Handles all encryption/decryption operations."""

    def __init__(self, config: EncryptionConfig | None = None) -> None:
        self._config = config or EncryptionConfig()

    # ─── Core Encrypt/Decrypt ────────────────────────────────────────────

    def encrypt(self, plaintext: bytes, key: bytes) -> bytes:
        """Encrypt plaintext with key. Returns: version(1) + nonce(24) + ciphertext."""
        if len(key) != KEY_SIZE:
            raise GitnixError(
                f"Invalid key size: expected {KEY_SIZE}, got {len(key)}",
                GitnixErrorCode.ENCRYPTION_FAILED,
            )

        padded = self._pad(plaintext) if self._config.enable_padding else plaintext
        box = nacl.secret.SecretBox(key)
        encrypted = box.encrypt(padded)  # nonce + ciphertext

        # Format: [version(1)] [nonce(24)] [ciphertext(N)]
        return bytes([BLOB_VERSION]) + encrypted

    def decrypt(self, blob: bytes, key: bytes) -> bytes:
        """Decrypt an encrypted blob."""
        if len(key) != KEY_SIZE:
            raise GitnixError(
                f"Invalid key size: expected {KEY_SIZE}, got {len(key)}",
                GitnixErrorCode.DECRYPTION_FAILED,
            )

        if len(blob) < 1 + NONCE_SIZE + 16:
            raise GitnixError("Encrypted blob too short", GitnixErrorCode.DECRYPTION_FAILED)

        version = blob[0]
        if version != BLOB_VERSION:
            raise GitnixError(
                f"Unsupported blob version: {version}",
                GitnixErrorCode.DECRYPTION_FAILED,
            )

        # The rest is nonce + ciphertext (PyNaCl format)
        encrypted = blob[1:]
        box = nacl.secret.SecretBox(key)

        try:
            decrypted = box.decrypt(encrypted)
        except CryptoError:
            raise GitnixError(
                "Decryption failed: invalid key or tampered data",
                GitnixErrorCode.DECRYPTION_FAILED,
            )

        return self._unpad(decrypted) if self._config.enable_padding else decrypted

    # ─── JSON Helpers ────────────────────────────────────────────────────

    def encrypt_json(self, data: Any, key: bytes) -> bytes:
        """Encrypt a JSON-serializable object."""
        plaintext = json.dumps(data, separators=(",", ":")).encode("utf-8")
        return self.encrypt(plaintext, key)

    def decrypt_json(self, blob: bytes, key: bytes) -> Any:
        """Decrypt to a JSON object."""
        decrypted = self.decrypt(blob, key)
        try:
            return json.loads(decrypted.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise GitnixError(
                "Failed to parse decrypted data as JSON",
                GitnixErrorCode.DECRYPTION_FAILED,
            )

    # ─── Base64 Helpers ──────────────────────────────────────────────────

    def encrypt_to_base64(self, plaintext: bytes, key: bytes) -> str:
        """Encrypt and return as base64."""
        return b64encode(self.encrypt(plaintext, key)).decode("ascii")

    def decrypt_from_base64(self, b64: str, key: bytes) -> bytes:
        """Decrypt from base64 string."""
        return self.decrypt(b64decode(b64), key)

    def encrypt_json_to_base64(self, data: Any, key: bytes) -> str:
        """Encrypt JSON and return as base64."""
        return b64encode(self.encrypt_json(data, key)).decode("ascii")

    def decrypt_json_from_base64(self, b64: str, key: bytes) -> Any:
        """Decrypt base64 to JSON."""
        return self.decrypt_json(b64decode(b64), key)

    # ─── Key Operations ──────────────────────────────────────────────────

    def generate_key(self) -> bytes:
        """Generate a random 256-bit key."""
        return nacl.utils.random(KEY_SIZE)

    def wrap_key(self, key: bytes, master_key: bytes) -> tuple[bytes, bytes]:
        """Encrypt a key with the master key. Returns (encrypted, nonce)."""
        box = nacl.secret.SecretBox(master_key)
        encrypted = box.encrypt(key)
        # PyNaCl prepends nonce to ciphertext
        nonce = encrypted[:NONCE_SIZE]
        ciphertext = encrypted[NONCE_SIZE:]
        return ciphertext, nonce

    def unwrap_key(self, encrypted_key: bytes, nonce: bytes, master_key: bytes) -> bytes:
        """Decrypt a wrapped key."""
        box = nacl.secret.SecretBox(master_key)
        try:
            return box.decrypt(encrypted_key, nonce)
        except CryptoError:
            raise GitnixError(
                "Failed to unwrap key: invalid master key",
                GitnixErrorCode.INVALID_PASSWORD,
            )

    def create_verification_hash(self, master_key: bytes) -> bytes:
        """Create a hash to verify the master password."""
        constant = b"GITNIX_KEY_VERIFICATION_v1"
        box = nacl.secret.SecretBox(master_key)
        nonce = b"\x00" * NONCE_SIZE
        return box.encrypt(constant, nonce)[NONCE_SIZE:]  # Skip prepended nonce

    def verify_master_key(self, master_key: bytes, verification_hash: bytes) -> bool:
        """Verify a master key against stored hash."""
        constant = b"GITNIX_KEY_VERIFICATION_v1"
        box = nacl.secret.SecretBox(master_key)
        nonce = b"\x00" * NONCE_SIZE
        try:
            result = box.decrypt(verification_hash, nonce)
            return result == constant
        except CryptoError:
            return False

    # ─── Hashing ─────────────────────────────────────────────────────────

    def hash_string(self, s: str) -> str:
        """Hash a string for filename obfuscation (URL-safe base64)."""
        digest = sha512(s.encode("utf-8")).digest()[:32]
        return b64encode(digest).decode("ascii").replace("+", "-").replace("/", "_").rstrip("=")

    # ─── Padding ─────────────────────────────────────────────────────────

    def _pad(self, data: bytes) -> bytes:
        """PKCS7-style padding to fixed block size."""
        block_size = self._config.padding_block_size
        padded_size = ((len(data) + 4 + block_size - 1) // block_size) * block_size
        length_prefix = struct.pack(">I", len(data))
        padding = nacl.utils.random(padded_size - 4 - len(data))
        return length_prefix + data + padding

    def _unpad(self, data: bytes) -> bytes:
        """Remove padding."""
        if len(data) < 4:
            raise GitnixError("Invalid padded data", GitnixErrorCode.DECRYPTION_FAILED)
        original_length = struct.unpack(">I", data[:4])[0]
        if original_length > len(data) - 4:
            raise GitnixError(
                "Invalid padding: claimed length exceeds data",
                GitnixErrorCode.DECRYPTION_FAILED,
            )
        return data[4 : 4 + original_length]
