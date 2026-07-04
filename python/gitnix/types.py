"""Gitnix SDK - Type Definitions."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, TypedDict


# ─── Core Config ─────────────────────────────────────────────────────────────


@dataclass
class CacheConfig:
    max_size: int = 5000
    ttl: float = 300.0  # seconds
    persistent: bool = False
    persist_path: str = ".gitnix-cache"


@dataclass
class RateLimiterConfig:
    max_requests_per_hour: int = 5000
    max_concurrent: int = 10
    max_writes_per_minute: int = 20
    retry_attempts: int = 3
    retry_base_delay: float = 1.0  # seconds


@dataclass
class EncryptionConfig:
    argon2_memory_cost: int = 65536  # KiB
    argon2_time_cost: int = 3
    argon2_parallelism: int = 1
    enable_padding: bool = True
    padding_block_size: int = 256


@dataclass
class GitnixConfig:
    repo: str
    token: str
    password: str
    branch: str = "main"
    overflow_repos: list[str] = field(default_factory=list)
    cache: CacheConfig = field(default_factory=CacheConfig)
    rate_limiter: RateLimiterConfig = field(default_factory=RateLimiterConfig)
    encryption: EncryptionConfig = field(default_factory=EncryptionConfig)
    api_base_url: str = "https://api.github.com"
    auto_create: bool = False


# ─── Document Types ──────────────────────────────────────────────────────────


Document = dict[str, Any]


class FieldType(str, Enum):
    STRING = "string"
    NUMBER = "number"
    BOOLEAN = "boolean"
    ARRAY = "array"
    OBJECT = "object"
    DATE = "date"
    BINARY = "binary"


@dataclass
class FieldDefinition:
    type: FieldType
    default: Any = None
    min: float | None = None
    max: float | None = None
    pattern: str | None = None
    enum: list[Any] | None = None
    items: FieldDefinition | None = None
    properties: dict[str, FieldDefinition] | None = None


@dataclass
class IndexDefinition:
    fields: list[str]
    unique: bool = False
    name: str | None = None
    sparse: bool = False


@dataclass
class SchemaDefinition:
    fields: dict[str, FieldDefinition]
    required: list[str] = field(default_factory=list)
    additional_properties: bool = True


@dataclass
class CollectionOptions:
    name: str
    schema: SchemaDefinition | None = None
    indexes: list[IndexDefinition] = field(default_factory=list)
    max_doc_size: int = 1_048_576  # 1 MB
    timestamps: bool = True
    id_generator: Callable[[], str] | None = None


# ─── Query Types ─────────────────────────────────────────────────────────────

QueryFilter = dict[str, Any]
QueryValue = str | int | float | bool | None


@dataclass
class QueryOptions:
    fields: list[str] | None = None
    sort: dict[str, int] | None = None  # 1 = asc, -1 = desc
    skip: int = 0
    limit: int | None = None
    count: bool = False


@dataclass
class QueryResult:
    docs: list[Document]
    total: int | None = None
    has_more: bool = False
    execution_time: float = 0.0


UpdateOperator = dict[str, dict[str, Any]]


# ─── Binary Types ────────────────────────────────────────────────────────────


@dataclass
class BinaryMetadata:
    id: str
    filename: str
    mime_type: str
    size: int
    chunk_count: int
    chunk_size: int
    hash: str
    uploaded_at: str
    metadata: dict[str, Any] | None = None
    repo: str = ""
    width: int | None = None
    height: int | None = None


@dataclass
class UploadOptions:
    filename: str | None = None
    mime_type: str | None = None
    metadata: dict[str, Any] | None = None
    chunk_size: int = 524_288  # 512 KB
    on_progress: Callable[[float], None] | None = None


@dataclass
class DownloadOptions:
    on_progress: Callable[[float], None] | None = None
    range_start: int | None = None
    range_end: int | None = None


# ─── Transaction Types ───────────────────────────────────────────────────────


@dataclass
class TransactionOptions:
    max_retries: int = 3
    timeout: float = 30.0  # seconds
    conflict_strategy: str = "retry"  # retry | abort | merge | custom
    merge_fn: Callable[[Document, Document], Document] | None = None


# ─── Storage Types ───────────────────────────────────────────────────────────


@dataclass
class RepoInfo:
    name: str
    current_size: int
    max_size: int
    collection_count: int
    is_primary: bool
    last_sync: float


@dataclass
class StorageAllocation:
    repo: str
    path: str
    available_space: int
