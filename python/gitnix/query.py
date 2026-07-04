"""Gitnix SDK - Query Engine.

MongoDB-style query operators for filtering, sorting, and pagination.
"""

from __future__ import annotations

import re
import time
from typing import Any

from gitnix.errors import GitnixError, GitnixErrorCode
from gitnix.types import Document, QueryFilter, QueryOptions, QueryResult, UpdateOperator


class QueryEngine:
    """MongoDB-style query engine for in-memory document filtering."""

    def execute(
        self,
        documents: list[Document],
        filter_: QueryFilter,
        options: QueryOptions | None = None,
    ) -> QueryResult:
        """Execute a query against documents."""
        opts = options or QueryOptions()
        start = time.perf_counter()

        # 1. Filter
        results = self.filter(documents, filter_)

        # 2. Sort
        if opts.sort:
            results = self.sort(results, opts.sort)

        # 3. Count
        total = len(results)

        # 4. Skip
        if opts.skip > 0:
            results = results[opts.skip :]

        # 5. Limit
        has_more = opts.limit is not None and len(results) > opts.limit
        if opts.limit is not None:
            results = results[: opts.limit]

        # 6. Projection
        if opts.fields:
            results = self.project(results, opts.fields)

        execution_time = time.perf_counter() - start

        return QueryResult(
            docs=results,
            total=total if opts.count else None,
            has_more=has_more,
            execution_time=execution_time,
        )

    def filter(self, documents: list[Document], filter_: QueryFilter) -> list[Document]:
        """Filter documents matching the query."""
        if not filter_:
            return list(documents)
        return [doc for doc in documents if self.matches(doc, filter_)]

    def matches(self, doc: Document, filter_: QueryFilter) -> bool:
        """Check if a document matches a filter."""
        # Top-level logical operators
        if "$and" in filter_:
            return all(self.matches(doc, cond) for cond in filter_["$and"])
        if "$or" in filter_:
            return any(self.matches(doc, cond) for cond in filter_["$or"])
        if "$not" in filter_:
            return not self.matches(doc, filter_["$not"])

        # Field conditions
        for field, condition in filter_.items():
            if field.startswith("$"):
                continue
            value = self._get_nested(doc, field)
            if isinstance(condition, dict) and any(k.startswith("$") for k in condition):
                if not self._eval_operator(value, condition):
                    return False
            else:
                if not self._is_equal(value, condition):
                    return False
        return True

    def _eval_operator(self, value: Any, ops: dict[str, Any]) -> bool:
        """Evaluate query operators against a value."""
        for op, operand in ops.items():
            match op:
                case "$eq":
                    if not self._is_equal(value, operand):
                        return False
                case "$ne":
                    if self._is_equal(value, operand):
                        return False
                case "$gt":
                    if not self._compare(value, operand, ">"):
                        return False
                case "$gte":
                    if not self._compare(value, operand, ">="):
                        return False
                case "$lt":
                    if not self._compare(value, operand, "<"):
                        return False
                case "$lte":
                    if not self._compare(value, operand, "<="):
                        return False
                case "$in":
                    if value not in operand:
                        return False
                case "$nin":
                    if value in operand:
                        return False
                case "$exists":
                    if operand and value is None:
                        return False
                    if not operand and value is not None:
                        return False
                case "$type":
                    if type(value).__name__ != operand:
                        return False
                case "$regex":
                    if not isinstance(value, str) or not re.search(operand, value):
                        return False
                case "$contains":
                    if not isinstance(value, str) or operand.lower() not in value.lower():
                        return False
                case "$startsWith":
                    if not isinstance(value, str) or not value.startswith(operand):
                        return False
                case "$endsWith":
                    if not isinstance(value, str) or not value.endswith(operand):
                        return False
                case "$size":
                    if not isinstance(value, list) or len(value) != operand:
                        return False
                case "$elemMatch":
                    if not isinstance(value, list):
                        return False
                    if not any(self.matches(item, operand) for item in value):
                        return False
                case "$not":
                    if self._eval_operator(value, operand):
                        return False
                case _:
                    raise GitnixError(
                        f"Unknown operator: {op}", GitnixErrorCode.INVALID_OPERATOR
                    )
        return True

    def sort(self, documents: list[Document], sort_spec: dict[str, int]) -> list[Document]:
        """Sort documents by multiple fields."""
        import functools

        def compare(a: Document, b: Document) -> int:
            for field, direction in sort_spec.items():
                a_val = self._get_nested(a, field)
                b_val = self._get_nested(b, field)

                # Handle None
                if a_val is None and b_val is None:
                    continue
                if a_val is None:
                    return -1 * direction
                if b_val is None:
                    return 1 * direction

                if a_val < b_val:
                    return -1 * direction
                if a_val > b_val:
                    return 1 * direction
            return 0

        return sorted(documents, key=functools.cmp_to_key(compare))

    def project(self, documents: list[Document], fields: list[str]) -> list[Document]:
        """Project only specific fields."""
        results = []
        for doc in documents:
            projected: Document = {"_id": doc.get("_id")}
            for field in fields:
                val = self._get_nested(doc, field)
                if val is not None:
                    self._set_nested(projected, field, val)
            results.append(projected)
        return results

    def apply_update(self, doc: Document, update: UpdateOperator) -> Document:
        """Apply update operators to a document."""
        result = dict(doc)

        if "$set" in update:
            for key, value in update["$set"].items():
                self._set_nested(result, key, value)

        if "$unset" in update:
            for key in update["$unset"]:
                self._delete_nested(result, key)

        if "$inc" in update:
            for key, amount in update["$inc"].items():
                current = self._get_nested(result, key)
                self._set_nested(result, key, (current or 0) + amount)

        if "$push" in update:
            for key, value in update["$push"].items():
                current = self._get_nested(result, key)
                if isinstance(current, list):
                    current.append(value)
                else:
                    self._set_nested(result, key, [value])

        if "$pull" in update:
            for key, value in update["$pull"].items():
                current = self._get_nested(result, key)
                if isinstance(current, list):
                    self._set_nested(result, key, [x for x in current if x != value])

        if "$addToSet" in update:
            for key, value in update["$addToSet"].items():
                current = self._get_nested(result, key)
                if isinstance(current, list):
                    if value not in current:
                        current.append(value)
                else:
                    self._set_nested(result, key, [value])

        return result

    # ─── Helpers ─────────────────────────────────────────────────────────

    def _get_nested(self, obj: Any, path: str) -> Any:
        """Get nested value using dot notation."""
        parts = path.split(".")
        current = obj
        for part in parts:
            if not isinstance(current, dict):
                return None
            current = current.get(part)
        return current

    def _set_nested(self, obj: dict[str, Any], path: str, value: Any) -> None:
        """Set nested value using dot notation."""
        parts = path.split(".")
        current = obj
        for part in parts[:-1]:
            if part not in current or not isinstance(current[part], dict):
                current[part] = {}
            current = current[part]
        current[parts[-1]] = value

    def _delete_nested(self, obj: dict[str, Any], path: str) -> None:
        """Delete nested value."""
        parts = path.split(".")
        current = obj
        for part in parts[:-1]:
            if part not in current:
                return
            current = current[part]
        current.pop(parts[-1], None)

    def _is_equal(self, a: Any, b: Any) -> bool:
        """Deep equality."""
        return a == b

    def _compare(self, value: Any, operand: Any, op: str) -> bool:
        """Compare values."""
        if value is None or operand is None:
            return False
        try:
            match op:
                case ">":
                    return value > operand
                case ">=":
                    return value >= operand
                case "<":
                    return value < operand
                case "<=":
                    return value <= operand
        except TypeError:
            return False
        return False
