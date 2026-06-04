"""Centralized config loaded from .env."""
from __future__ import annotations
import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    anthropic_api_key: str
    model: str

    # Snowflake
    sf_account: str
    sf_user: str
    sf_password: str
    sf_role: str
    sf_warehouse: str
    sf_database: str
    sf_schema: str

    # dbt-mcp
    dbt_project_dir: str
    dbt_profiles_dir: str
    dbt_path: str

    # Optional dbt Cloud (enables Semantic Layer + Discovery in dbt-mcp)
    dbt_host: str | None
    dbt_token: str | None
    dbt_prod_env_id: str | None
    dbt_dev_env_id: str | None
    dbt_user_id: str | None

    def dbt_mcp_env(self) -> dict[str, str]:
        """Env vars to inject when spawning dbt-mcp via stdio."""
        env = {
            "DBT_PROJECT_DIR": self.dbt_project_dir,
            "DBT_PROFILES_DIR": os.path.expanduser(self.dbt_profiles_dir),
            "DBT_PATH": self.dbt_path,
            # Pass Snowflake creds through so dbt picks them up via env_var()
            "SNOWFLAKE_ACCOUNT": self.sf_account,
            "SNOWFLAKE_USER": self.sf_user,
            "SNOWFLAKE_PASSWORD": self.sf_password,
            "SNOWFLAKE_ROLE": self.sf_role,
            "SNOWFLAKE_WAREHOUSE": self.sf_warehouse,
            "SNOWFLAKE_DATABASE": self.sf_database,
            "SNOWFLAKE_SCHEMA": self.sf_schema,
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", ""),
        }
        for k, v in [
            ("DBT_HOST", self.dbt_host),
            ("DBT_TOKEN", self.dbt_token),
            ("DBT_PROD_ENV_ID", self.dbt_prod_env_id),
            ("DBT_DEV_ENV_ID", self.dbt_dev_env_id),
            ("DBT_USER_ID", self.dbt_user_id),
        ]:
            if v:
                env[k] = v
        return env


def load_config() -> Config:
    g = os.environ.get
    return Config(
        anthropic_api_key=g("ANTHROPIC_API_KEY", ""),
        model=g("MODEL", "claude-opus-4-7"),
        sf_account=g("SNOWFLAKE_ACCOUNT", ""),
        sf_user=g("SNOWFLAKE_USER", ""),
        sf_password=g("SNOWFLAKE_PASSWORD", ""),
        sf_role=g("SNOWFLAKE_ROLE", ""),
        sf_warehouse=g("SNOWFLAKE_WAREHOUSE", ""),
        sf_database=g("SNOWFLAKE_DATABASE", ""),
        sf_schema=g("SNOWFLAKE_SCHEMA", ""),
        dbt_project_dir=os.path.abspath(g("DBT_PROJECT_DIR", "./dbt_project_snowflake")),
        dbt_profiles_dir=g("DBT_PROFILES_DIR", "~/.dbt"),
        dbt_path=g("DBT_PATH", "dbt"),
        dbt_host=g("DBT_HOST"),
        dbt_token=g("DBT_TOKEN"),
        dbt_prod_env_id=g("DBT_PROD_ENV_ID"),
        dbt_dev_env_id=g("DBT_DEV_ENV_ID"),
        dbt_user_id=g("DBT_USER_ID"),
    )
