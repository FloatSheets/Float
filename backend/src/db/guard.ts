/**
 * Integration tests truncate tables and insert synthetic rows. `bun test` sets
 * NODE_ENV=test, so refuse any test connection to a database whose name does
 * not mark it as a test database (for example floatsheets_test). This keeps a
 * production DATABASE_URL in a shell or .env file from being wiped by tests.
 */
export function assertTestDatabase(url: string, nodeEnv: string | undefined): void {
  if (nodeEnv !== "test") return;
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("Refusing to run tests: DATABASE_URL is not a valid connection URL");
  }
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to run tests against database "${name || "(default)"}": test database names must contain "test"`);
  }
}
