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
2. Run the workflow once in ComfyUI on the PC.
3. **Workflows > Add workflow > From recent runs**, pick that run, give it a name.
4. **Edit** tab: change prompts and settings, tap **Generate**. Star a setting to pin it to Main.

Workflows can also be imported from a file saved with ComfyUI's *Export (API)*. The normal
"Save" format from the ComfyUI editor is not supported.

## Layout

- `app/src/main/assets/www/` - the whole UI (plain HTML/CSS/JS, no build step). It also opens
  in a desktop browser for testing if ComfyUI runs with `--enable-cors-header`.
- `app/src/main/java/app/comfyfold/MainActivity.java` - WebView shell and native bridge
  (HTTP, uploads, save to Pictures, share, back button, keep screen on).
- `signing/comfyfold.keystore` - fixed signing key so updates install cleanly. Keep the repo private.
