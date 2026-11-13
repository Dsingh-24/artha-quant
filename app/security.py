"""Security primitives: secret loading, password hashing, session management, CSRF, and rate limiting.

Follows mandatory secure web backend guidelines:
- Multi-tiered secret resolution with cryptographic ephemeral fallback (never hardcoded literals).
- Memory-hard scrypt password hashing (with OWASP 600k-iteration PBKDF2-SHA512 fallback if OS SSL lacks scrypt).
- Server-side session lifecycle with expiration, logout invalidation, and synchronizer CSRF tokens.
- Sliding-window per-client rate limiting.
"""

from __future__ import annotations

import collections
import hashlib
import hmac
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Deque, Dict, Optional, Tuple

logger = logging.getLogger("arthaquant.security")

SESSION_TTL_SECONDS = 60 * 60 * 4  # 4-hour inactivity / max session window
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128

# TODO(security): Integrate OAuth 2.0 / OIDC providers, Multi-Factor Authentication (MFA),
# and HaveIBeenPwned k-anonymity leaked-password checks when deploying beyond localhost.


def load_runtime_secret(env_name: str = "ARTHA_SECRET_KEY", secret_file: Optional[Path] = None) -> str:
    """Resolve runtime cryptographic secret without hardcoded literal fallbacks."""
    env_val = os.getenv(env_name)
    if env_val and len(env_val.strip()) >= 32:
        return env_val.strip()

    if secret_file is not None and secret_file.is_file():
        file_val = secret_file.read_text(encoding="utf-8").strip()
        if len(file_val) >= 32:
            return file_val

    logger.warning(
        "Generating ephemeral cryptographic secret for %s. "
        "Sessions are instance-isolated; configure KMS/env secret for multi-worker deployments.",
        env_name,
    )
    return secrets.token_hex(32)


RUNTIME_SECRET = load_runtime_secret()


def validate_password_strength(password: str) -> Optional[str]:
    """Validate password length rules (allow all characters including special characters)."""
    if not isinstance(password, str):
        return "Invalid password format."
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters (12+ recommended)."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Password must not exceed {MAX_PASSWORD_LENGTH} characters."
    return None


def hash_password(password: str) -> str:
    """Hash password with unique per-user salt using scrypt (or PBKDF2-SHA512 if LibreSSL lacks scrypt)."""
    salt = secrets.token_bytes(16)
    pw_bytes = password.encode("utf-8")
    if hasattr(hashlib, "scrypt"):
        digest = hashlib.scrypt(pw_bytes, salt=salt, n=2**14, r=8, p=1, dklen=32)
        return f"scrypt${salt.hex()}${digest.hex()}"
    digest = hashlib.pbkdf2_hmac("sha512", pw_bytes, salt, 600_000, dklen=32)
    return f"pbkdf2_sha512${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    """Constant-time verification of a password against its stored salted hash."""
    try:
        scheme, salt_hex, digest_hex = stored_hash.split("$", 2)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        pw_bytes = password.encode("utf-8")
        if scheme == "scrypt" and hasattr(hashlib, "scrypt"):
            actual = hashlib.scrypt(pw_bytes, salt=salt, n=2**14, r=8, p=1, dklen=len(expected))
        elif scheme == "pbkdf2_sha512":
            actual = hashlib.pbkdf2_hmac("sha512", pw_bytes, salt, 600_000, dklen=len(expected))
        else:
            return False
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def generate_session_tokens() -> Tuple[str, str]:
    """Generate cryptographically random (session_id, csrf_token)."""
    return secrets.token_urlsafe(32), secrets.token_urlsafe(32)


def hash_session_id(session_id: str) -> str:
    """Hash raw session token before storing in SQLite so DB dumps never leak live cookies."""
    return hmac.new(RUNTIME_SECRET.encode("utf-8"), session_id.encode("utf-8"), hashlib.sha256).hexdigest()


class SlidingWindowRateLimiter:
    """Thread-safe in-memory per-client rate limiter."""

    def __init__(self, max_requests: int = 120, window_seconds: int = 60) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: Dict[str, Deque[float]] = collections.defaultdict(collections.deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            bucket = self._hits[key]
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= self.max_requests:
                return False
            bucket.append(now)
            return True


def safe_sandbox_path(sandbox_dir: Path, untrusted_filename: str) -> Path:
    """Sanitize untrusted filename and verify strict containment inside sandbox_dir."""
    clean_name = os.path.basename(untrusted_filename.replace("\\", "/"))
    if not clean_name or clean_name in {".", ".."}:
        raise ValueError("Invalid filename.")
    resolved_sandbox = sandbox_dir.resolve()
    candidate = (resolved_sandbox / clean_name).resolve()
    if not str(candidate).startswith(str(resolved_sandbox) + os.sep):
        raise ValueError("Path escapes sandbox boundary.")
    return candidate
