import { afterEach, describe, expect, it } from "vitest";
import { parseMcpConfig, redactConfig, resolveRefs, validateRegistration } from "./config";

const clean: string[] = [];
afterEach(() => {
  for (const key of clean.splice(0)) delete process.env[key];
});

function setEnv(key: string, value: string) {
  process.env[key] = value;
  clean.push(key);
}

describe("MCP transport config", () => {
  it("accepts a URL transport and a stdio one", () => {
    expect(parseMcpConfig("streamable-http", { url: "https://pdu.local/mcp" })).toEqual({
      url: "https://pdu.local/mcp",
    });
    expect(parseMcpConfig("stdio", { command: "node", args: ["server.js"] })).toEqual({
      command: "node",
      args: ["server.js"],
    });
  });

  it("explains what is missing rather than handing back a Zod tree", () => {
    expect(() => parseMcpConfig("sse", { url: "not-a-url" })).toThrow(/full http/i);
    expect(() => parseMcpConfig("stdio", {})).toThrow(/command/i);
  });

  it("refuses a literal credential, whichever half of the config it is in", () => {
    // The whole point: these rows are rendered in an admin panel and dumped in
    // every backup, so a token must never become a value in them.
    expect(() => parseMcpConfig("streamable-http", { url: "https://x/mcp", headers: { Authorization: "Bearer sk-live-123" } })).toThrow(
      /env:VARIABLE_NAME/,
    );
    expect(() => parseMcpConfig("stdio", { command: "node", env: { PDU_API_KEY: "hunter2" } })).toThrow(
      /env:VARIABLE_NAME/,
    );
  });

  it("accepts the same fields written as env refs", () => {
    expect(() =>
      parseMcpConfig("streamable-http", { url: "https://x/mcp", headers: { Authorization: "env:PDU_TOKEN" } }),
    ).not.toThrow();
  });

  it("leaves ordinary headers alone", () => {
    expect(() => parseMcpConfig("sse", { url: "https://x/mcp", headers: { "X-Venue": "ilumina" } })).not.toThrow();
  });
});

describe("resolveRefs", () => {
  it("swaps env refs for their values at connect time", () => {
    setEnv("PDU_TOKEN", "s3cret");
    expect(resolveRefs({ Authorization: "env:PDU_TOKEN", "X-Venue": "ilumina" })).toEqual({
      Authorization: "s3cret",
      "X-Venue": "ilumina",
    });
  });

  it("refuses to connect with the ref itself as the value", () => {
    // Otherwise this fails later as somebody else's 401, which is a much worse
    // error message than our own.
    expect(() => resolveRefs({ Authorization: "env:NOT_SET_ANYWHERE" })).toThrow(/not set/i);
  });

  it("treats an empty env var as missing", () => {
    setEnv("EMPTY_TOKEN", "");
    expect(() => resolveRefs({ Authorization: "env:EMPTY_TOKEN" })).toThrow(/not set/i);
  });
});

describe("redactConfig", () => {
  it("masks a literal in a credential field but keeps an env ref readable", () => {
    // A ref names a variable, not a value — hiding it would only stop an admin
    // seeing which variable to set.
    expect(
      redactConfig({ url: "https://x/mcp", headers: { Authorization: "env:PDU_TOKEN", "X-Api-Key": "leaked" } }),
    ).toEqual({
      url: "https://x/mcp",
      headers: { Authorization: "env:PDU_TOKEN", "X-Api-Key": "••••" },
    });
  });

  it("survives a row that isn't an object", () => {
    expect(redactConfig(null)).toEqual({});
  });
});

describe("validateRegistration", () => {
  it("checks the name and the transport before the config", () => {
    expect(() => validateRegistration({ name: "Bad Name", transport: "sse", config: { url: "https://x" } })).toThrow(
      /lowercase/,
    );
    expect(() => validateRegistration({ name: "pdu", transport: "carrier-pigeon", config: {} })).toThrow(
      /Unknown transport/,
    );
  });

  it("returns the parsed triple when everything holds", () => {
    expect(validateRegistration({ name: "pdu", transport: "stdio", config: { command: "node" } })).toEqual({
      name: "pdu",
      transport: "stdio",
      config: { command: "node" },
    });
  });
});
