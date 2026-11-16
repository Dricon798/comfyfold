package app.comfyfold;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import androidx.core.content.FileProvider;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Thin native shell. The whole UI lives in assets/www and runs in a WebView.
 * HTTP calls to ComfyUI go through {@link Bridge} so the page is not subject to
 * browser cross-origin rules and the server needs no extra flags.
 */
public class MainActivity extends Activity {
    private static final String TAG = "ComfyFold";
    private static final int REQ_FILE = 41;
    private static final int BG = Color.rgb(0x12, 0x13, 0x16);

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, String> results = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setDecorFitsSystemWindows(false);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Keep the page clear of the status bar, gesture bar, cutouts and the on-screen keyboard.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.addJavascriptInterface(new Bridge(), "ComfyBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("file".equals(u.getScheme())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "No app can open " + u);
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });

        // Back: let the page close its viewer / sheet first; otherwise send the app to the background.
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                () -> web.evaluateJavascript("window.__cfBack ? window.__cfBack() : false", v -> {
                    if (!"true".equals(v)) moveTaskToBack(true);
                }));

        if (savedInstanceState == null) web.loadUrl("file:///android_asset/www/index.html");
        else web.restoreState(savedInstanceState);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    // ---- helpers -------------------------------------------------------------------------

    private void deliver(String id, int status, String text) {
        results.put(id, text == null ? "" : text);
        runOnUiThread(() -> web.evaluateJavascript(
                "window.__cfCb && window.__cfCb('" + id + "'," + status + ")", null));
    }

    private void toast(String msg, boolean bad) {
        String js = "window.__cfToast && window.__cfToast(" + org.json.JSONObject.quote(msg) + "," + bad + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
    }

    private static HttpURLConnection open(String url, String method) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000);
        c.setReadTimeout(120000);
        c.setRequestProperty("Accept", "*/*");
        return c;
    }

    private static String readResponse(HttpURLConnection c) throws Exception {
        InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream();
        return in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
    }

    private static String describe(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    private static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
        return n.isEmpty() ? "comfyui_output.png" : n;
    }

    private static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return mime != null ? mime : "application/octet-stream";
    }

    // ---- JavaScript bridge (methods run on a WebView background thread) --------------------

    private class Bridge {
        /** Plain HTTP request. The result is announced with __cfCb(id, status) and fetched with take(id). */
        @JavascriptInterface
        public void request(String id, String method, String url, String body) {
            io.execute(() -> {
                int status = 0;
                String text;
                HttpURLConnection c = null;
                try {
                    c = open(url, method);
                    if ("POST".equals(method)) {
                        byte[] b = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                        c.setDoOutput(true);
                        c.setRequestProperty("Content-Type", "application/json");
                        c.setFixedLengthStreamingMode(b.length);
                        try (OutputStream o = c.getOutputStream()) {
                            o.write(b);
                        }
                    }
                    status = c.getResponseCode();
                    text = readResponse(c);
                } catch (Exception e) {
                    status = 0;
                    text = describe(e);
                } finally {
                    if (c != null) c.disconnect();
                }
                deliver(id, status, text);
            });
        }

        @JavascriptInterface
        public String take(String id) {
            String r = results.remove(id);
            return r == null ? "" : r;
        }

        /** multipart/form-data upload to ComfyUI's /upload/image. */
        @JavascriptInterface
        public void upload(String id, String url, String base64, String filename, String mime) {
            io.execute(() -> {
                int status = 0;
                String text;
                HttpURLConnection c = null;
                try {
                    byte[] data = Base64.decode(base64, Base64.DEFAULT);
                    String boundary = "----ComfyFold" + System.nanoTime();
                    String name = safeName(filename).replace("\"", "_");
                    byte[] head = ("--" + boundary + "\r\n"
                            + "Content-Disposition: form-data; name=\"type\"\r\n\r\ninput\r\n"
                            + "--" + boundary + "\r\n"
                            + "Content-Disposition: form-data; name=\"image\"; filename=\"" + name + "\"\r\n"
                            + "Content-Type: " + mime + "\r\n\r\n").getBytes(StandardCharsets.UTF_8);
                    byte[] tail = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
                    c = open(url, "POST");
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                    c.setFixedLengthStreamingMode(head.length + data.length + tail.length);
                    try (OutputStream o = c.getOutputStream()) {
                        o.write(head);
                        o.write(data);
                        o.write(tail);
                    }
                    status = c.getResponseCode();
                    text = readResponse(c);
                } catch (Exception e) {
                    status = 0;
                    text = describe(e);
                } finally {
                    if (c != null) c.disconnect();
                }
                deliver(id, status, text);
            });
        }

        @JavascriptInterface
        public void keepAwake(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        /** Download an output and put it in Pictures/ComfyFold (or Movies/ComfyFold for video). */
        @JavascriptInterface
        public void saveMedia(String url, String filename) {
            io.execute(() -> {
                Uri item = null;
                try {
                    String name = safeName(filename);
                    String mime = mimeOf(name);
                    boolean video = mime.startsWith("video/");
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, (video ? "Movies" : "Pictures") + "/ComfyFold");
                    v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri collection = video
                            ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                            : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                    item = getContentResolver().insert(collection, v);
                    if (item == null) throw new Exception("storage unavailable");
                    HttpURLConnection c = open(url, "GET");
                    try (InputStream in = c.getInputStream();
                         OutputStream out = getContentResolver().openOutputStream(item)) {
                        if (out == null) throw new Exception("storage unavailable");
                        copy(in, out);
                    } finally {
                        c.disconnect();
                    }
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    getContentResolver().update(item, done, null, null);
                    toast("Saved to " + (video ? "Movies" : "Pictures") + "/ComfyFold", false);
                } catch (Exception e) {
                    if (item != null) {
                        try {
                            getContentResolver().delete(item, null, null);
                        } catch (Exception ignored) {
                            // nothing else to clean up
                        }
                    }
                    toast("Save failed: " + describe(e), true);
                }
            });
        }

        /** Download an output to the app cache and open the Android share sheet. */
        @JavascriptInterface
        public void shareMedia(String url, String filename) {
            io.execute(() -> {
                try {
                    String name = safeName(filename);
                    File dir = new File(getCacheDir(), "share");
                    if (!dir.exists() && !dir.mkdirs()) throw new Exception("cache unavailable");
                    File[] old = dir.listFiles();
                    if (old != null) for (File f : old) f.delete();
                    File file = new File(dir, name);
                    HttpURLConnection c = open(url, "GET");
                    try (InputStream in = c.getInputStream();
                         OutputStream out = new FileOutputStream(file)) {
                        copy(in, out);
                    } finally {
                        c.disconnect();
                    }
                    Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", file);
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType(mimeOf(name));
                    send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.setClipData(ClipData.newRawUri(name, uri));
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    runOnUiThread(() -> startActivity(Intent.createChooser(send, "Share")));
                } catch (Exception e) {
                    toast("Share failed: " + describe(e), true);
                }
            });
        }
    }
}
