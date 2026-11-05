import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://u:p@127.0.0.1:5433/db" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(4000);
    expect(c.HOST).toBe("127.0.0.1");
    expect(c.MCP_ALLOWED_HOSTS).toEqual(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => loadConfig({ DATABASE_URL: "mysql://u:p@localhost/db" })).toThrow(/postgres/);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ ...base, PORT: "99999" })).toThrow(/PORT/);
  });

  it("normalises the MCP host allowlist", () => {
    expect(loadConfig({ ...base, MCP_ALLOWED_HOSTS: " LocalHost , example.test ," }).MCP_ALLOWED_HOSTS).toEqual([
      "localhost",
      "example.test",
    ]);
  });
});
