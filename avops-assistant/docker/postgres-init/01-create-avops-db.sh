#!/bin/bash
# One Postgres instance, two databases: `outline` (POSTGRES_DB) and `avops`.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE avops WITH LOGIN PASSWORD '${AVOPS_DB_PASSWORD:-avops-password}';
    CREATE DATABASE avops OWNER avops;
EOSQL
