import { expect, test } from "bun:test";

import { assertTestDatabase } from "../src/db/guard";

test("refuses test runs against databases not named as test databases", () => {
  expect(() => assertTestDatabase("postgresql://u:p@db.example.com:5432/floatsheets", "test")).toThrow('Refusing to run tests against database "floatsheets"');
  expect(() => assertTestDatabase("postgresql://u:p@db.example.com:5432/postgres?sslmode=require", "test")).toThrow("Refusing to run tests");
  expect(() => assertTestDatabase("not a url", "test")).toThrow("not a valid connection URL");
  expect(() => assertTestDatabase("postgresql://postgres:postgres@localhost:5432/floatsheets_test", "test")).not.toThrow();
  // Outside tests the guard never applies.
  expect(() => assertTestDatabase("postgresql://u:p@db.example.com:5432/floatsheets", "production")).not.toThrow();
});
