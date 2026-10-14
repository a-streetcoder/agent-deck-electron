/**
 * Help > Check for Updates (DST-04, Windows NSIS builds). electron-updater
 * reads the GitHub feed from the packaged app-update.yml, verifies the
 * download against latest.yml's sha512, and on Windows rejects an installer
 * whose Authenticode publisher differs from the `publisherName` the signed
 * build wrote there. This module only drives the user-facing flow; `updater`
 * and `dialog` are injected so the flow is testable without Electron.
 */

let checking = false;

export async function checkForUpdates({ updater, dialog, window, currentVersion }) {
  if (checking) return;
  checking = true;
  try {
    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) {
      await dialog.showMessageBox(window, {
        type: "info",
        message: "Agent Deck is up to date.",
        detail: `Version ${currentVersion}`,
      });
      return;
    }
    // autoDownload is on by default, so the check already started the download.
    await result.downloadPromise;
    const { response } = await dialog.showMessageBox(window, {
      type: "info",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Agent Deck ${result.updateInfo.version} is ready to install.`,
      detail: "Restart now, or it installs the next time you quit Agent Deck.",
    });
    if (response === 0) updater.quitAndInstall();
  } catch (error) {
    dialog.showErrorBox("Update check failed", String(error?.message ?? error));
  } finally {
    checking = false;
  }
}
