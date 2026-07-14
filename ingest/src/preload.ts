/**
 * Must be imported before @ai-sdk/openai. That package creates a default
 * provider at module load which reads OPENAI_BASE_URL from the environment;
 * an empty string (which docker-compose's `${VAR:-}` produces for an unset
 * var) fails its non-empty-string check and crashes the process at startup.
 * Normalise "" → unset for the env vars that are read eagerly.
 */
for (const key of ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"]) {
  if (process.env[key] === "") delete process.env[key];
}
