"""Tests for Gitnix Python SDK."""

import pytest
from gitnix import Gitnix, GitnixError, GitnixErrorCode
from gitnix.types import GitnixConfig
from gitnix.encryption import Encryption
from gitnix.query import QueryEngine


class TestEncryption:
    """Test encryption layer."""

    def test_encrypt_decrypt_roundtrip(self) -> None:
        enc = Encryption()
        key = enc.generate_key()
        plaintext = b"Hello, Gitnix!"

        encrypted = enc.encrypt(plaintext, key)
        decrypted = enc.decrypt(encrypted, key)

        assert decrypted == plaintext

    def test_encrypt_json_roundtrip(self) -> None:
        enc = Encryption()
        key = enc.generate_key()
        data = {"name": "Alice", "age": 30, "tags": ["admin"]}

        encrypted = enc.encrypt_json(data, key)
        decrypted = enc.decrypt_json(encrypted, key)

        assert decrypted == data

    def test_wrong_key_fails(self) -> None:
        enc = Encryption()
        key1 = enc.generate_key()
        key2 = enc.generate_key()

        encrypted = enc.encrypt(b"secret", key1)

        with pytest.raises(GitnixError) as exc_info:
            enc.decrypt(encrypted, key2)
        assert exc_info.value.code == GitnixErrorCode.DECRYPTION_FAILED

    def test_base64_roundtrip(self) -> None:
        enc = Encryption()
        key = enc.generate_key()
        data = {"hello": "world"}

        b64 = enc.encrypt_json_to_base64(data, key)
        assert isinstance(b64, str)

        result = enc.decrypt_json_from_base64(b64, key)
        assert result == data

    def test_key_wrapping(self) -> None:
        enc = Encryption()
        master = enc.generate_key()
        child = enc.generate_key()

        encrypted, nonce = enc.wrap_key(child, master)
        unwrapped = enc.unwrap_key(encrypted, nonce, master)

        assert unwrapped == child

    def test_verification_hash(self) -> None:
        enc = Encryption()
        key = enc.generate_key()

        hash_ = enc.create_verification_hash(key)
        assert enc.verify_master_key(key, hash_) is True

        wrong_key = enc.generate_key()
        assert enc.verify_master_key(wrong_key, hash_) is False


class TestQueryEngine:
    """Test query engine."""

    def setup_method(self) -> None:
        self.engine = QueryEngine()
        self.docs = [
            {"_id": "1", "name": "Alice", "age": 30, "city": "NYC"},
            {"_id": "2", "name": "Bob", "age": 25, "city": "LA"},
            {"_id": "3", "name": "Charlie", "age": 35, "city": "NYC"},
            {"_id": "4", "name": "Diana", "age": 28, "city": "Chicago"},
        ]

    def test_eq_filter(self) -> None:
        result = self.engine.filter(self.docs, {"name": "Alice"})
        assert len(result) == 1
        assert result[0]["_id"] == "1"

    def test_gt_filter(self) -> None:
        result = self.engine.filter(self.docs, {"age": {"$gt": 28}})
        assert len(result) == 2

    def test_in_filter(self) -> None:
        result = self.engine.filter(self.docs, {"city": {"$in": ["NYC", "LA"]}})
        assert len(result) == 3

    def test_and_filter(self) -> None:
        result = self.engine.filter(
            self.docs, {"$and": [{"city": "NYC"}, {"age": {"$gt": 30}}]}
        )
        assert len(result) == 1
        assert result[0]["name"] == "Charlie"

    def test_or_filter(self) -> None:
        result = self.engine.filter(
            self.docs, {"$or": [{"name": "Alice"}, {"name": "Bob"}]}
        )
        assert len(result) == 2

    def test_contains_filter(self) -> None:
        result = self.engine.filter(self.docs, {"name": {"$contains": "li"}})
        assert len(result) == 2  # Alice, Charlie

    def test_sort(self) -> None:
        sorted_docs = self.engine.sort(self.docs, {"age": 1})
        assert sorted_docs[0]["name"] == "Bob"
        assert sorted_docs[-1]["name"] == "Charlie"

    def test_sort_descending(self) -> None:
        sorted_docs = self.engine.sort(self.docs, {"age": -1})
        assert sorted_docs[0]["name"] == "Charlie"

    def test_projection(self) -> None:
        projected = self.engine.project(self.docs, ["name", "age"])
        assert "city" not in projected[0]
        assert "name" in projected[0]

    def test_apply_update_set(self) -> None:
        doc = {"_id": "1", "name": "Alice", "age": 30}
        updated = self.engine.apply_update(doc, {"$set": {"age": 31}})
        assert updated["age"] == 31

    def test_apply_update_inc(self) -> None:
        doc = {"_id": "1", "name": "Alice", "age": 30}
        updated = self.engine.apply_update(doc, {"$inc": {"age": 1}})
        assert updated["age"] == 31

    def test_apply_update_push(self) -> None:
        doc = {"_id": "1", "tags": ["a", "b"]}
        updated = self.engine.apply_update(doc, {"$push": {"tags": "c"}})
        assert updated["tags"] == ["a", "b", "c"]

    def test_execute_with_pagination(self) -> None:
        from gitnix.types import QueryOptions
        result = self.engine.execute(self.docs, {}, QueryOptions(skip=1, limit=2, count=True))
        assert len(result.docs) == 2
        assert result.total == 4


class TestConfig:
    """Test configuration validation."""

    def test_invalid_repo_raises(self) -> None:
        with pytest.raises(GitnixError) as exc_info:
            Gitnix(GitnixConfig(repo="invalid", token="tok", password="pass"))
        assert exc_info.value.code == GitnixErrorCode.INVALID_CONFIG

    def test_empty_token_raises(self) -> None:
        with pytest.raises(GitnixError) as exc_info:
            Gitnix(GitnixConfig(repo="owner/repo", token="", password="pass"))
        assert exc_info.value.code == GitnixErrorCode.INVALID_CONFIG

    def test_empty_password_raises(self) -> None:
        with pytest.raises(GitnixError) as exc_info:
            Gitnix(GitnixConfig(repo="owner/repo", token="tok", password=""))
        assert exc_info.value.code == GitnixErrorCode.INVALID_CONFIG
