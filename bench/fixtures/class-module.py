"""Module with classes, methods, and decorators."""

import logging
from dataclasses import dataclass
from functools import wraps
from typing import Any, Callable, Dict, List, Optional


logger = logging.getLogger(__name__)


def retry(max_attempts: int = 3):
    """Retry decorator for flaky operations."""
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            last_error: Optional[Exception] = None
            for attempt in range(max_attempts):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_error = e
                    logger.warning(f"Attempt {attempt + 1} failed: {e}")
            raise last_error  # type: ignore
        return wrapper
    return decorator


@dataclass
class Config:
    """Application configuration."""
    host: str = "localhost"
    port: int = 8080
    debug: bool = False
    max_connections: int = 100


class ConnectionPool:
    """Manages a pool of database connections."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._connections: List[Any] = []
        self._available: List[Any] = []

    def acquire(self) -> Any:
        """Acquire a connection from the pool."""
        if self._available:
            conn = self._available.pop()
            logger.debug("Reusing existing connection")
            return conn

        if len(self._connections) < self._config.max_connections:
            conn = self._create_connection()
            self._connections.append(conn)
            return conn

        raise RuntimeError("Connection pool exhausted")

    def release(self, conn: Any) -> None:
        """Return a connection to the pool."""
        self._available.append(conn)

    def _create_connection(self) -> Any:
        """Create a new database connection."""
        logger.info(f"Creating connection to {self._config.host}:{self._config.port}")
        return {"host": self._config.host, "port": self._config.port}

    @retry(max_attempts=3)
    def health_check(self) -> bool:
        """Check if the pool is healthy."""
        for conn in self._connections:
            if not self._ping(conn):
                return False
        return True

    def _ping(self, conn: Any) -> bool:
        """Ping a connection to verify it's alive."""
        return conn is not None


class QueryBuilder:
    """Fluent SQL query builder."""

    def __init__(self) -> None:
        self._table: str = ""
        self._conditions: List[str] = []
        self._order: Optional[str] = None
        self._limit: Optional[int] = None

    def from_table(self, table: str) -> "QueryBuilder":
        self._table = table
        return self

    def where(self, condition: str) -> "QueryBuilder":
        self._conditions.append(condition)
        return self

    def order_by(self, column: str, desc: bool = False) -> "QueryBuilder":
        self._order = f"{column} {'DESC' if desc else 'ASC'}"
        return self

    def limit(self, n: int) -> "QueryBuilder":
        self._limit = n
        return self

    def build(self) -> str:
        if not self._table:
            raise ValueError("Table name is required")

        query = f"SELECT * FROM {self._table}"

        if self._conditions:
            query += " WHERE " + " AND ".join(self._conditions)

        if self._order:
            query += f" ORDER BY {self._order}"

        if self._limit is not None:
            query += f" LIMIT {self._limit}"

        return query
