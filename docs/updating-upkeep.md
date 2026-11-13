# Updating Upkeep

Upkeep updates itself the way it updates everything else: it tells you, you decide, and the version it replaces can come back. This page says what happens at each step and what is left on disk.

## What you see

When a newer version of Upkeep is released, a row appears above the app list:

| The row says                                                         | What it means                                                                                            | What you can press                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------- |
| A new version of Upkeep is ready.                                    | A newer release exists. Nothing was downloaded yet.                                                      | **Update Upkeep**, **What's new** |
| Downloading and testing                                              | Upkeep is downloading the new version and starting it once as a test.                                    | nothing                           |
| Restart Upkeep to finish.                                            | The new version is downloaded, verified and has started correctly once.                                  | **Restart now**, **What's new**   |
| Restarting                                                           | The swap is under way. The window closes and comes back.                                                 | nothing                           |
| Upkeep was updated to 0.1.1.                                         | You are on the new version.                                                                              | **What's new**, **Dismiss**       |
| Could not download the update. Nothing was changed.                  | The download failed or did not match its checksum.                                                       | **Try again**                     |
| Upkeep 0.1.1 failed its start test, so nothing was changed.          | The new version did not come up when tested. You are still on the version you had, and it never stopped. | **Try again**                     |
| Upkeep 0.1.1 would not start, so the version before it was put back. | The new version was swapped in and then did not start. The start script put the old one back.            | **Try again**, **Dismiss**        |

The tray menu also gets a line, "Upkeep 0.1.1 is ready", and you get one notification per new version. The tray number counts your apps only.

Upkeep's own update waits while anything else is running: a check, an install, a system install, a cleanup, a restore. The buttons are off until it ends.

## What an update does

1. **Check.** Upkeep asks its own release address for the latest version, each time it checks your apps. Only a version newer than the one running is offered. An older or equal one is ignored, whatever the files say.
2. **Download and verify.** The new version is downloaded beside the running one, as a small patch when the release has one for your version and as the full archive otherwise. Its SHA-256 and size must match what the release lists. A download that fails or does not match is thrown away.
3. **Start test.** The downloaded version is started once from where it was put, while the version you have keeps running. It gets copies of your app list and settings, never the real files. It has to load every app in your list, open its window (hidden) and have its view answer, within 60 seconds. If it exits, hangs or loses an app from the list, the update stops there. Nothing of yours was touched and the version you have never stopped.
4. **Restart.** Only now is anything swapped: when you press **Restart now**, or on its own if you switched that on (below). First the running version is copied to a kept copy, and your app list and settings are copied beside it. Then Upkeep closes, the new version takes its place and starts. The window comes back if it was open and stays in the tray if it was not. On a normal machine this takes about a second.
5. **Confirm.** The new version marks itself as started and removes the kept copy.

## If the new version does not start after the swap

The start test catches a broken release before anything is swapped. For the rest, the menu entry and the login entry do not start Upkeep directly. They run a small script, `upkeep-start.sh`, kept beside the app folder, which looks at three things before it starts anything:

- **The app folder is missing** (the machine lost power in the middle of the swap): the old version is put back.
- **A new version was swapped in, never marked itself as started, and is not running**: the kept copy is put back, with your app list and settings as the old version last wrote them. The row then says which version would not start.
- **Otherwise**: Upkeep starts.

So if Upkeep ever disappears after an update, start it again from the menu. That is the repair.

The script never deletes anything, never waits and never ends a process. The tree that would not start is kept as `app.failed` until the next update, for a bug report. If the script itself is missing, the entries start Upkeep directly.

A version that failed its start test or was rolled back is not tried again on its own. **Try again** still works, and the next release gets its own chance.

## Updating automatically

**Update Upkeep automatically**, in Settings under About, is off by default. With it on, Upkeep does all of the above by itself, but only while its window is hidden and nothing is running, and it restarts itself in the tray. With it off, Upkeep tells you and waits.

## Where updates come from

From the latest release of [Upkeep's repo](https://github.com/lcestou/upkeep/releases), over HTTPS. There is no account and nothing is sent except the request for the files. The download is trusted the way every app in your list is: the files and their checksums come from the same release page.

## What is kept on disk

Beside the app folder, in `~/.local/share/dev.afk.upkeep/stable/`:

| Name                   | What it is                                                          | When it goes                                        |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `upkeep-start.sh`      | the start script the menu and login entries run                     | rewritten at start when it differs                  |
| `app.prepared-<id>`    | a downloaded version, verified, waiting for its restart             | swapped in, or removed when it fails its start test |
| `app.keep`             | a copy of the version being replaced                                | when the new version has started                    |
| `.upkeep-config-keep/` | copies of your app list, state and extras from just before the swap | with `app.keep`                                     |
| `.upkeep-update.json`  | the attempt under way: from which version to which                  | when the next Upkeep that starts has settled it     |
| `app.failed`           | a version that would not start after the swap                       | at the next update                                  |
| `.upkeep-ok-<id>`      | a marker: this version has started                                  | replaced by the next version's                      |

An update needs room for three copies of the app folder (about 450 MB). With less, Upkeep says so and downloads nothing.

The log is `~/.local/state/upkeep/self-update.log`. Attach it to a bug report about an update.

## The way out that needs no working Upkeep

The installer on the [release page](https://github.com/lcestou/upkeep/releases) always works and replaces whatever is there. Your app list, settings, history and restore points live outside the app folder (`~/.config/upkeep`, `~/.local/state/upkeep`, `~/.local/share/upkeep`) and are not touched by it.

## What does not update itself

- A build run from a checkout (`bun run dev`).
- An install made before Upkeep could update itself. Run the installer once; from then on it updates itself.

## How this is tested

`scripts/self-update-trial/trial.sh` builds six real versions, installs them in throwaway home folders on a hidden display and updates them from a local address. Its cases: a good update in the tray; a new version that exits at once; one that hangs; a corrupted archive; a download cut halfway and tried again; an older version offered; a disk with no room; a version that passes its start test and dies after the swap; an app folder missing after an interrupted swap; the menu entry with and without the start script; two updates in a row; an update pressed in the open window; and a restart the system refuses. Every case ends on the same check: an Upkeep that has started is installed, running, and still holds the app list. It runs before each release.
