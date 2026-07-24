import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectSecret } from "./secrets.js";

describe("detectSecret", () => {
  it("detects each credential kind", () => {
    const cases: Array<[string, string]> = [
      ["my key is AKIAABCDEFGHIJKLMNOP", "aws-access-key"],
      ["use sk-abcdefghijklmnopqrstuv12 for the api", "api-key"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github-token"],
      ["github_pat_abcdefghijklmnopqrstuv_more", "github-token"],
      ["xoxb-1234567890-abcdefghij", "slack-token"],
      ["AIzaAbCdEfGhIjKlMnOpQrStUvWxYz012345678", "google-api-key"], // exactly 35 chars after AIza
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij_ABCDEFGHIJ", "jwt"],
      ["-----BEGIN RSA PRIVATE KEY-----", "private-key"],
      ["password = hunter2hunter2", "assignment"],
      ["API_KEY: zzzzyyyyxxxx1234", "assignment"],
    ];
    for (const [content, kind] of cases) {
      assert.equal(detectSecret(content)?.kind, kind, `expected ${kind} for: ${content}`);
    }
  });

  it("returns null for near-misses and ordinary prose", () => {
    const negatives = [
      "AKIA is a prefix Amazon uses",              // bare AKIA, no 16-char tail
      "I forgot my password again",                // prose, no assignment
      "the sk-launch project ships tomorrow",      // sk- with < 20 chars after
      "eyJabc.eyJdef",                             // two-segment, not a JWT
      "token: short",                              // assignment value < 8 chars
      "we store the public key in the repo",       // no pattern at all
      "",                                          // empty
    ];
    for (const content of negatives) {
      assert.equal(detectSecret(content), null, `false positive on: ${content}`);
    }
  });

  it("returns only the kind, never the matched text", () => {
    const hit = detectSecret("AKIAABCDEFGHIJKLMNOP");
    assert.deepEqual(hit, { kind: "aws-access-key" });
    assert.ok(!JSON.stringify(hit).includes("AKIAABCDEFGHIJKLMNOP"));
  });
});
