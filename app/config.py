from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "Developer Ticket System"
    API_PREFIX: str = "/api/v1"
    DEBUG: bool = False

    DATABASE_URL: str = "sqlite:///./tickets.db"

    SECRET_KEY: str = "change-me"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 720

    UPLOAD_DIR: str = "uploads"
    MAX_UPLOAD_MB: int = 10
    MAX_FILES_PER_REQUEST: int = 10
    BLOCKED_EXTENSIONS: str = ".exe,.bat,.cmd,.com,.scr,.msi,.dll"

    CORS_ORIGINS: str = "*"

    FIRST_ADMIN_NAME: str = "Administrator"
    FIRST_ADMIN_EMAIL: str = "admin@example.com"
    FIRST_ADMIN_PASSWORD: str = "ChangeMe123!"

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024

    @property
    def blocked_extensions(self) -> set[str]:
        return {e.strip().lower() for e in self.BLOCKED_EXTENSIONS.split(",") if e.strip()}

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
