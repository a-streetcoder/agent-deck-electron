import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdates } from "./update-check.js";

function fakeDialog(response = 0) {
  const calls = [];
  return {
    calls,
    showMessageBox: async (_window, options) => {
      calls.push(["message", options.message]);
      return { response };
    },
    showErrorBox: (title, detail) => calls.push(["error", title, detail]),
  };
}

test("no update: says so and does not install", async () => {
  const dialog = fakeDialog();
  let installed = false;
  const updater = {
    checkForUpdates: async () => ({ isUpdateAvailable: false }),
    quitAndInstall: () => (installed = true),
  };
  await checkForUpdates({ updater, dialog, window: null, currentVersion: "1.0.0" });
  assert.deepEqual(dialog.calls, [["message", "Agent Deck is up to date."]]);
  assert.equal(installed, false);
});

test("update: waits for the verified download, installs only on Restart Now", async () => {
  for (const [response, expectInstall] of [
    [0, true],
    [1, false],
  ]) {
    const dialog = fakeDialog(response);
    let installed = false;
    let downloaded = false;
    const updater = {
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: "1.1.0" },
        downloadPromise: Promise.resolve().then(() => (downloaded = true)),
      }),
      quitAndInstall: () => {
        assert.equal(downloaded, true);
        installed = true;
      },
    };
    await checkForUpdates({ updater, dialog, window: null, currentVersion: "1.0.0" });
    assert.deepEqual(dialog.calls, [["message", "Agent Deck 1.1.0 is ready to install."]]);
    assert.equal(installed, expectInstall);
  }
});

test("a failed check or a rejected download (bad sha512 or publisher) is reported", async () => {
  for (const updater of [
    { checkForUpdates: async () => Promise.reject(new Error("net::ERR_INTERNET_DISCONNECTED")) },
    {
      checkForUpdates: async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: "1.1.0" },
        downloadPromise: Promise.reject(
          new Error("New version is not signed by the application owner"),
        ),
      }),
    },
  ]) {
    const dialog = fakeDialog();
    await checkForUpdates({ updater, dialog, window: null, currentVersion: "1.0.0" });
    assert.equal(dialog.calls.length, 1);
    assert.equal(dialog.calls[0][0], "error");
  }
});
