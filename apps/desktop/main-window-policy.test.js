import assert from "node:assert/strict";
import test from "node:test";
import { loopbackHttpUrl, mainWindowNavigation } from "./main-window-policy.js";

test("loopbackHttpUrl accepts only http loopback URLs with an explicit valid port", () => {
  const V = "AGENT_DECK_RENDERER_URL";
  assert.equal(loopbackHttpUrl("http://127.0.0.1:5199", V).origin, "http://127.0.0.1:5199");
  assert.equal(loopbackHttpUrl("http://localhost:4200/x", V).port, "4200");
  for (const bad of [
    "https://deck.example.com",
    "http://deck.example.com:80",
    "http://127.0.0.1",
    "https://127.0.0.1:5199",
    "http://127.0.0.1.evil.test:5199",
    "not a url",
  ]) {
    assert.throws(() => loopbackHttpUrl(bad, V), /AGENT_DECK_RENDERER_URL must be a loopback/, bad);
  }
  assert.throws(() => loopbackHttpUrl("http://127.0.0.1:0", V), /invalid port/);
});

test("the main window stays on the renderer origin; other web URLs go to the browser", () => {
  const origin = "http://127.0.0.1:4200";
  assert.equal(mainWindowNavigation("http://127.0.0.1:4200/settings", origin), "allow");
  assert.equal(mainWindowNavigation("https://deck.example.com/", origin), "external");
  assert.equal(mainWindowNavigation("http://127.0.0.1:5199/", origin), "external");
  assert.equal(mainWindowNavigation("file:///C:/x.html", origin), "deny");
  assert.equal(mainWindowNavigation("javascript:alert(1)", origin), "deny");
  assert.equal(mainWindowNavigation("not a url", origin), "deny");
  // Before startup there is no renderer origin: nothing is allowed in-window.
  assert.equal(mainWindowNavigation("http://127.0.0.1:4200/", null), "external");
});
