[README.md](https://github.com/user-attachments/files/31021269/README.md)
# PerfoTec Trial Workflow — board and tools

Kanban board plus the intake, proposal and report tools for PerfoTec packaging
trials. Static pages: no build step, no server, no backend.

## This repository holds no data

The board reads and writes a folder you choose yourself, through the browser's
File System Access API. That folder is the shared database — for PerfoTec it is
the SharePoint library **DataBase Trial WorkFlow**, synced locally. Nothing is
stored in this repository or on GitHub, and no data is sent anywhere.

## Using it

1. Sync the shared SharePoint folder to your computer (Teams → the library →
   *Sync* or *Add shortcut to OneDrive*).
2. Open the board, click **Choose project folder** and pick that synced folder.
3. Choose **Allow on every visit** when the browser asks, so the link survives a
   restart.

Requires Chrome or Edge: Safari and Firefox do not implement
`showDirectoryPicker()`.

## Generated

Built from a private source repository by `publish.mjs`. Edit it there, not
here — changes made in this repository are overwritten on the next release.
