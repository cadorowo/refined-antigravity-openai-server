import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ConfigurationError,
  expandPath,
  isLoopbackHost,
  loadConfigFromEnv,
  validateConfig,
} from "../src/server/config.js";

test("ServerConfig unit tests", async (t) => {
  await t.test("expandPath expands tilde correctly", () => {
    assert.equal(expandPath("~"), os.homedir());
    assert.equal(expandPath("~/test/path"), path.resolve(os.homedir(), "test/path"));
    assert.equal(expandPath("/absolute/path"), "/absolute/path");
  });

  await t.test("isLoopbackHost correctly identifies loopback addresses", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("127.0.0.2"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
    assert.equal(isLoopbackHost("192.168.1.1"), false);
    assert.equal(isLoopbackHost("10.0.0.1"), false);
  });

  await t.test("loads default configuration", () => {
    const config = loadConfigFromEnv({
      host: "127.0.0.1",
      port: 8787,
      bodyLimitBytes: 1048576,
    });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8787);
    assert.equal(config.bodyLimitBytes, 1048576);
    assert.equal(config.apiKey, undefined);
    assert.equal(config.shutdownGraceMs, 15000);
  });

  await t.test("validates port range", () => {
    assert.throws(
      () =>
        validateConfig({
          host: "127.0.0.1",
          port: -1,
          bodyLimitBytes: 1024,
          allowInsecureExternalBind: false,
          profiles: [],
          shutdownGraceMs: 15000,
        }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("Invalid server port"),
    );

    assert.throws(
      () =>
        validateConfig({
          host: "127.0.0.1",
          port: 70000,
          bodyLimitBytes: 1024,
          allowInsecureExternalBind: false,
          profiles: [],
          shutdownGraceMs: 15000,
        }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("Invalid server port"),
    );

    // Port 0 is valid for ephemeral testing
    assert.doesNotThrow(() =>
      validateConfig({
        host: "127.0.0.1",
        port: 0,
        bodyLimitBytes: 1024,
        allowInsecureExternalBind: false,
        profiles: [],
        shutdownGraceMs: 15000,
      }),
    );
  });

  await t.test("validates non-empty host", () => {
    assert.throws(
      () =>
        validateConfig({
          host: "",
          port: 8787,
          bodyLimitBytes: 1024,
          allowInsecureExternalBind: false,
          profiles: [],
          shutdownGraceMs: 15000,
        }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("host cannot be empty"),
    );
  });

  await t.test("validates positive body limit", () => {
    assert.throws(
      () =>
        validateConfig({
          host: "127.0.0.1",
          port: 8787,
          bodyLimitBytes: 0,
          allowInsecureExternalBind: false,
          profiles: [],
          shutdownGraceMs: 15000,
        }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("Invalid body limit"),
    );
  });

  await t.test("validates non-negative shutdownGraceMs", () => {
    assert.throws(
      () =>
        validateConfig({
          host: "127.0.0.1",
          port: 8787,
          bodyLimitBytes: 1024,
          allowInsecureExternalBind: false,
          profiles: [],
          shutdownGraceMs: -5,
        }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("Invalid shutdownGraceMs"),
    );
  });

  await t.test("fails closed on non-loopback host without API key", () => {
    assert.throws(
      () =>
        validateConfig({
          host: "0.0.0.0",
          port: 8787,
          bodyLimitBytes: 1024,
          allowInsecureExternalBind: false,
          profiles: [],
          shutdownGraceMs: 15000,
        }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("Security violation"),
    );

    // Allowed when API key is present
    assert.doesNotThrow(() =>
      validateConfig({
        host: "0.0.0.0",
        port: 8787,
        apiKey: "secret-key",
        bodyLimitBytes: 1024,
        allowInsecureExternalBind: false,
        profiles: [],
        shutdownGraceMs: 15000,
      }),
    );

    // Allowed when explicit override is enabled
    assert.doesNotThrow(() =>
      validateConfig({
        host: "0.0.0.0",
        port: 8787,
        bodyLimitBytes: 1024,
        allowInsecureExternalBind: true,
        profiles: [],
        shutdownGraceMs: 15000,
      }),
    );
  });

  await t.test("validates profile configurations", () => {
    assert.throws(
      () =>
        validateConfig({
          host: "127.0.0.1",
          port: 8787,
          bodyLimitBytes: 1024,
          allowInsecureExternalBind: false,
          profiles: [{ id: "", geminiHome: "/path" }],
          shutdownGraceMs: 15000,
        }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("Profile id cannot be empty"),
    );

    assert.throws(
      () =>
        validateConfig({
          host: "127.0.0.1",
          port: 8787,
          bodyLimitBytes: 1024,
          allowInsecureExternalBind: false,
          profiles: [{ id: "test", geminiHome: "" }],
          shutdownGraceMs: 15000,
        }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("empty geminiHome"),
    );
  });

  await t.test("rejects shared profile homes and GEMINI_HOME overrides", () => {
    const base = {
      host: "127.0.0.1",
      port: 8787,
      bodyLimitBytes: 1024,
      allowInsecureExternalBind: false,
      shutdownGraceMs: 15000,
    };
    assert.throws(
      () => validateConfig({
        ...base,
        profiles: [
          { id: "a", geminiHome: "/tmp/review-home" },
          { id: "b", geminiHome: "/tmp/../tmp/review-home" },
        ],
      }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("share GEMINI_HOME"),
    );
    assert.throws(
      () => validateConfig({
        ...base,
        profiles: [{ id: "a", geminiHome: "/tmp/review-home", env: { GEMINI_HOME: "/tmp/other" } }],
      }),
      (err: unknown) => err instanceof ConfigurationError && err.message.includes("cannot override GEMINI_HOME"),
    );

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "review-home-"));
    const alias = `${home}-alias`;
    try {
      fs.symlinkSync(home, alias);
      assert.throws(
        () => validateConfig({
          ...base,
          profiles: [{ id: "a", geminiHome: home }, { id: "b", geminiHome: alias }],
        }),
        (err: unknown) => err instanceof ConfigurationError && err.message.includes("share GEMINI_HOME"),
      );
    } finally {
      fs.rmSync(alias, { force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
