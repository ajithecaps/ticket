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

    # Public address of the web app, used for ticket links in Slack messages.
    APP_BASE_URL: str = "http://localhost:8000"
    # Local time zone for the daily summary schedule and dates shown in Slack.
    TIMEZONE: str = "Asia/Kolkata"

    # Background jobs (overdue checks, daily Slack summary). One process per host runs them.
    SCHEDULER_ENABLED: bool = True
    OVERDUE_CHECK_MINUTES: int = 15

    # Slack: set SLACK_WEBHOOK_URL (simplest), or SLACK_BOT_TOKEN + SLACK_CHANNEL (enables @mentions).
    # Everything in this block (plus APP_BASE_URL and TIMEZONE) can also be changed from the admin
    # panel (Slack page); values saved there override these and need no restart.
    SLACK_ENABLED: bool = True
    SLACK_WEBHOOK_URL: str = ""
    SLACK_BOT_TOKEN: str = ""
    SLACK_CHANNEL: str = ""
    # Which in-app notification types are mirrored to Slack: "all", "none", or a comma list
    # (ticket_created,assigned,unassigned,status_changed,ticket_updated,comment,mention,project_member).
    SLACK_NOTIFY_TYPES: str = "all"
    # "HH:MM" in TIMEZONE; empty disables the daily summary.
    SLACK_DAILY_SUMMARY_TIME: str = "10:00"
    SLACK_DAILY_SUMMARY_DAYS: str = "mon,tue,wed,thu,fri,sat,sun"

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
    def slack_configured(self) -> bool:
        return bool(self.SLACK_WEBHOOK_URL or (self.SLACK_BOT_TOKEN and self.SLACK_CHANNEL))

    @property
    def slack_enabled(self) -> bool:
        return self.SLACK_ENABLED and self.slack_configured

    @property
    def slack_notify_types(self) -> set[str] | None:
        """None means every type."""
        raw = self.SLACK_NOTIFY_TYPES.strip().lower()
        if raw in ("", "all", "*"):
            return None
        if raw == "none":
            return set()
        return {t.strip() for t in raw.split(",") if t.strip()}

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
