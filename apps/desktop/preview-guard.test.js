import assert from "node:assert/strict";
import test from "node:test";
import {
  allowPreviewNavigation,
  configurePreviewSession,
  isAllowedPreviewRequest,
  PREVIEW_PARTITION,
} from "./preview-guard.js";

test("preview navigation allows only loopback http(s), never the control plane", () => {
  const notControlPlane = () => false;
  assert.equal(allowPreviewNavigation("http://localhost:5173/app", notControlPlane), true);
  assert.equal(allowPreviewNavigation("https://127.0.0.1:8443/", notControlPlane), true);
  assert.equal(allowPreviewNavigation("http://127.0.0.2:3000/", notControlPlane), true);
  assert.equal(allowPreviewNavigation("http://[::1]:3000/", notControlPlane), true);

  // A dev server redirecting/link-following out of loopback stays contained.
  assert.equal(allowPreviewNavigation("https://evil.example/", notControlPlane), false);
  assert.equal(allowPreviewNavigation("http://10.0.0.9:3000/", notControlPlane), false);
  assert.equal(allowPreviewNavigation("file:///etc/passwd", notControlPlane), false);
  assert.equal(allowPreviewNavigation("about:blank", notControlPlane), false);
  assert.equal(allowPreviewNavigation("data:text/html,hi", notControlPlane), false);
  assert.equal(allowPreviewNavigation("not a url", notControlPlane), false);

  // The app's own control-plane origin is denied even though it is loopback.
  const controlPlane = (parsed) => parsed.port === "4200";
  assert.equal(allowPreviewNavigation("http://127.0.0.1:4200/api", controlPlane), false);
  assert.equal(allowPreviewNavigation("http://localhost:5173/", controlPlane), true);
});

test("preview requests allow only loopback http(s)+ws(s), never the control plane", () => {
  const notControlPlane = () => false;
  // The page itself, its assets, and HMR websockets stay reachable.
  assert.equal(isAllowedPreviewRequest("http://localhost:5173/main.js", notControlPlane), true);
  assert.equal(isAllowedPreviewRequest("ws://localhost:5173/hmr", notControlPlane), true);
  assert.equal(isAllowedPreviewRequest("wss://127.0.0.1:8443/live", notControlPlane), true);

  // A subframe document or subresource pointed off-loopback is cancelled —
  // will-navigate never fires for these, so this filter is the real boundary.
  assert.equal(isAllowedPreviewRequest("https://evil.example/frame.html", notControlPlane), false);
  assert.equal(isAllowedPreviewRequest("http://10.0.0.9:3000/x.png", notControlPlane), false);
  assert.equal(isAllowedPreviewRequest("file:///etc/passwd", notControlPlane), false);
  assert.equal(isAllowedPreviewRequest("not a url", notControlPlane), false);

  // The unguarded control-plane REST must not be reachable even as a fetch/img.
  const controlPlane = (parsed) => parsed.port === "4200";
  assert.equal(isAllowedPreviewRequest("http://127.0.0.1:4200/api/x", controlPlane), false);
  assert.equal(isAllowedPreviewRequest("ws://localhost:4200/ws", controlPlane), false);
});

test("preview session denies permissions (request AND check), blocks downloads, filters requests", () => {
  const granted = [];
  let downloadListener = null;
  let requestFilter = null;
  const fakeSession = {
    setPermissionRequestHandler(handler) {
      this.permissionHandler = handler;
    },
    setPermissionCheckHandler(handler) {
      this.permissionCheck = handler;
    },
    on(event, listener) {
      if (event === "will-download") downloadListener = listener;
    },
    webRequest: {
      onBeforeRequest(listener) {
        requestFilter = listener;
      },
    },
  };
  configurePreviewSession(fakeSession, (parsed) => parsed.port === "4200");

  fakeSession.permissionHandler({}, "media", (allow) => granted.push(allow));
  fakeSession.permissionHandler({}, "notifications", (allow) => granted.push(allow));
  assert.deepEqual(granted, [false, false]);
  // The status-check sibling of the request handler must be equally closed.
  assert.equal(fakeSession.permissionCheck({}, "media"), false);

  let prevented = false;
  assert.ok(downloadListener, "a will-download listener must be installed");
  downloadListener({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);

  assert.ok(requestFilter, "an onBeforeRequest filter must be installed");
  const decide = (url) => {
    let out = null;
    requestFilter({ url }, (response) => {
      out = response;
    });
    return out;
  };
  assert.deepEqual(decide("http://localhost:5173/app.css"), { cancel: false });
  assert.deepEqual(decide("https://evil.example/frame.html"), { cancel: true });
  assert.deepEqual(decide("http://127.0.0.1:4200/api/x"), { cancel: true });
});

test("the partition constant matches the renderer's preview partition", () => {
  assert.equal(PREVIEW_PARTITION, "persist:agentdeck-preview");
});
