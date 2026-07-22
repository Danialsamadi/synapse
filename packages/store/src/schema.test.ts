import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS, runMigrations } from "./schema.js";

describe("runMigrations", () => {
  it("stamps a fresh DB to the latest version", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.length);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    assert.ok(tables.includes("memories"));
    assert.ok(tables.includes("links"));
  });

  it("adopts a legacy pre-versioning DB (tables exist, user_version 0)", () => {
    const db = new Database(":memory:");
    for (const m of MIGRATIONS) db.exec(m); // legacy path: applied without stamping
    assert.equal(db.pragma("user_version", { simple: true }), 0);
    runMigrations(db);
    assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.length);
  });

  it("is idempotent", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    runMigrations(db);
    assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.length);
  });

  it("fails closed on a DB from a newer version of the code", () => {
    const db = new Database(":memory:");
    db.pragma(`user_version = ${MIGRATIONS.length + 5}`);
    assert.throws(() => runMigrations(db), /newer/i);
  });
});
