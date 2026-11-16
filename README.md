# ComfyFold

A touch front end for ComfyUI on Android (built for a Pixel Fold). It does not show the node
graph. You pick a workflow, edit its settings in a form, queue it, and browse the results.

## Build

Every push to `main` runs `.github/workflows/build.yml`, which builds the APK and publishes it
under **Releases**. On the phone: open the repo's Releases page, download the newest
`ComfyFold-N.apk`, and open it (Android asks once to allow installs from the browser).
New builds install over the old one and keep your saved workflows.

To build locally instead: open the folder in Android Studio and run the `app` configuration.

## ComfyUI side

- Start ComfyUI with `--listen` so other devices can reach it.
- For live previews while sampling, also add `--preview-method auto`.
- No CORS flags are needed.

## Using it

1. **Server** tab: add each machine by address, e.g. `100.101.102.103:8188`.
2. **Workflows** tab: everything saved in ComfyUI on that machine is listed by name. Tap one to open it.
3. **Edit** tab: change prompts and settings, tap **Generate**. Star a setting to pin it to Main.

Saved workflows are converted from ComfyUI's editor format on the phone. Workflows that use
subgraphs or group nodes cannot be converted; for those, run the workflow once on the PC and
add it with **Add from recent runs or a file**.

## Layout

- `app/src/main/assets/www/` - the whole UI (plain HTML/CSS/JS, no build step). It also opens
  in a desktop browser for testing if ComfyUI runs with `--enable-cors-header`.
- `app/src/main/java/app/comfyfold/MainActivity.java` - WebView shell and native bridge
  (HTTP, uploads, save to Pictures, share, back button, keep screen on).
- `signing/comfyfold.keystore` - fixed signing key so updates install cleanly. Keep the repo private.
