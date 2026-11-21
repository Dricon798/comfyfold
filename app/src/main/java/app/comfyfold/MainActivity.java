package app.comfyfold;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.Manifest;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
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

    // ---- app lock state ----
    private static final int AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    private SharedPreferences prefs;
    private View lockView;
    private boolean locked = false;
    private boolean prompting = false;
    private boolean autoPrompt = false;      // prompt once by itself after locking; afterwards only via the button
    private boolean expectingReturn = false;   // we launched a picker / share sheet ourselves
    private long backgroundedAt = 0;
    private static final int REQ_NOTIFY = 42;
    private String pendingWatchBase, pendingWatchIds;   // jobs waiting for the notification permission answer
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
        prefs = getSharedPreferences("lock", MODE_PRIVATE);
        lockView = buildLockView();
        root.addView(lockView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        applyRecentsSetting();
        setLocked(lockEnabled() && canLock() == null);
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
                    expectingReturn = true;
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
                () -> {
                    if (locked) { moveTaskToBack(true); return; }
                    web.evaluateJavascript("window.__cfBack ? window.__cfBack() : false", v -> {
                    if (!"true".equals(v)) moveTaskToBack(true);
                });
                });

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

    // ---- job notifications ---------------------------------------------------------------

    private boolean notifyEnabled() {
        return prefs.getBoolean("notify", true);
    }

    private boolean notifyPermitted() {
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void watchJobs(String base, String idsJson) {
        if (!notifyEnabled()) return;
        if (notifyPermitted()) {
            JobWatchService.watch(this, base, idsJson);
        } else if (!prefs.getBoolean("notifyAsked", false)) {
            pendingWatchBase = base;
            pendingWatchIds = idsJson;
            prefs.edit().putBoolean("notifyAsked", true).apply();
            expectingReturn = true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_NOTIFY) return;
        boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (ok && pendingWatchBase != null) JobWatchService.watch(this, pendingWatchBase, pendingWatchIds);
        pendingWatchBase = pendingWatchIds = null;
        web.evaluateJavascript("window.__cfNotifyChanged && window.__cfNotifyChanged()", null);
    }

    // ---- app lock ------------------------------------------------------------------------

    @Override
    protected void onStart() {
        super.onStart();
        JobWatchService.appVisible = true;
        JobWatchService.clearDone(this);
        if (backgroundedAt > 0 && !expectingReturn && lockEnabled() && canLock() == null) {
            long away = (SystemClock.elapsedRealtime() - backgroundedAt) / 1000;
            if (away >= prefs.getInt("grace", 0)) setLocked(true);
        }
        expectingReturn = false;
        backgroundedAt = 0;
    }

    @Override
    protected void onResume() {
        super.onResume();
        expectingReturn = false;   // the picker or share sheet is gone either way
    }

    @Override
    protected void onStop() {
        super.onStop();
        JobWatchService.appVisible = false;
        if (prompting || expectingReturn) return;
        backgroundedAt = SystemClock.elapsedRealtime();
        // lock right away so nothing is visible behind the lock screen when the app comes back
        if (lockEnabled() && prefs.getInt("grace", 0) == 0 && canLock() == null) setLocked(true);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && locked && !prompting && autoPrompt) {
            autoPrompt = false;
            authenticate();
        }
    }

    private boolean lockEnabled() {
        return prefs.getBoolean("enabled", true);
    }

    /** null when the phone can show the unlock prompt, otherwise a reason it cannot. */
    private String canLock() {
        int r;
        try {
            BiometricManager bm = getSystemService(BiometricManager.class);
            r = bm == null ? -1 : bm.canAuthenticate(AUTHENTICATORS);
        } catch (RuntimeException e) {
            Log.e(TAG, "Unlock check failed", e);
            return "The unlock check failed: " + describe(e);
        }
        if (r == BiometricManager.BIOMETRIC_SUCCESS) return null;
        if (r == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) return "Set up a screen lock or fingerprint on the phone first.";
        return "This phone cannot show an unlock prompt right now.";
    }

    private void applyRecentsSetting() {
        // Hides the app's content in the recent-apps switcher (Android 13+), without blocking screenshots.
        setRecentsScreenshotEnabled(!prefs.getBoolean("hideRecents", true));
    }

    private void setLocked(boolean on) {
        locked = on;
        if (on) autoPrompt = true;
        lockView.setVisibility(on ? View.VISIBLE : View.GONE);
        web.setVisibility(on ? View.INVISIBLE : View.VISIBLE);
        if (on) web.clearFocus();
    }

    private void authenticate() {
        if (prompting) return;
        if (canLock() != null) { setLocked(false); return; }
        prompting = true;
        try {
            showPrompt();
        } catch (RuntimeException e) {
            // never trap the user behind a lock screen we cannot open
            Log.e(TAG, "Unlock prompt failed", e);
            prompting = false;
            setLocked(false);
        }
    }

    private void showPrompt() {
        BiometricPrompt prompt = new BiometricPrompt.Builder(this)
                .setTitle("Unlock ComfyFold")
                .setSubtitle("Use your fingerprint or screen lock")
                .setAllowedAuthenticators(AUTHENTICATORS)
                .setConfirmationRequired(false)
                .build();
        prompt.authenticate(new CancellationSignal(), getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                prompting = false;
                setLocked(false);
            }

            @Override
            public void onAuthenticationError(int errorCode, CharSequence errString) {
                prompting = false;   // cancelled or too many tries: stay locked, the Unlock button retries
            }
        });
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private View buildLockView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(BG);
        box.setClickable(true);   // swallow touches meant for the page underneath
        box.setFocusable(true);
        ImageView lockIcon = new ImageView(this);
        lockIcon.setImageResource(R.drawable.ic_lock);
        box.addView(lockIcon, new LinearLayout.LayoutParams(dp(72), dp(72)));
        TextView title = new TextView(this);
        title.setText("ComfyFold is locked");
        title.setTextColor(Color.rgb(0xEC, 0xEE, 0xF2));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(20), 0, dp(28));
        box.addView(title);
        Button unlock = new Button(this);
        unlock.setText("Unlock");
        unlock.setAllCaps(false);
        unlock.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        unlock.setOnClickListener(v -> authenticate());
        box.addView(unlock, new LinearLayout.LayoutParams(dp(200), dp(56)));
        box.setVisibility(View.GONE);
        return box;
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

        /** multipart/form-data POST: text fields from fieldsJson plus one file part named "image". */
        @JavascriptInterface
        public void uploadForm(String id, String url, String base64, String filename, String mime, String fieldsJson) {
            io.execute(() -> {
                int status = 0;
                String text;
                HttpURLConnection c = null;
                try {
                    byte[] data = Base64.decode(base64, Base64.DEFAULT);
                    String boundary = "----ComfyFold" + System.nanoTime();
                    String name = safeName(filename).replace("\"", "_");
                    StringBuilder sb = new StringBuilder();
                    org.json.JSONObject fields = new org.json.JSONObject(fieldsJson == null || fieldsJson.isEmpty() ? "{}" : fieldsJson);
                    java.util.Iterator<String> keys = fields.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        sb.append("--").append(boundary).append("\r\n")
                          .append("Content-Disposition: form-data; name=\"").append(k.replace("\"", "_")).append("\"\r\n\r\n")
                          .append(fields.optString(k)).append("\r\n");
                    }
                    sb.append("--").append(boundary).append("\r\n")
                      .append("Content-Disposition: form-data; name=\"image\"; filename=\"").append(name).append("\"\r\n")
                      .append("Content-Type: ").append(mime).append("\r\n\r\n");
                    byte[] head = sb.toString().getBytes(StandardCharsets.UTF_8);
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

        /** Older entry point kept for compatibility: plain image upload to the input folder. */
        @JavascriptInterface
        public void upload(String id, String url, String base64, String filename, String mime) {
            uploadForm(id, url, base64, filename, mime, "{\"type\":\"input\"}");
        }

        /** GET a binary resource and hand it back as a data: URL (so the page can read its pixels). */
        @JavascriptInterface
        public void fetchDataUrl(String id, String url) {
            io.execute(() -> {
                int status = 0;
                String text;
                HttpURLConnection c = null;
                try {
                    c = open(url, "GET");
                    status = c.getResponseCode();
                    if (status != 200) {
                        text = readResponse(c);
                    } else {
                        byte[] data = readAll(c.getInputStream());
                        String type = c.getContentType();
                        if (type == null || type.isEmpty()) type = "application/octet-stream";
                        int semi = type.indexOf(';');
                        if (semi >= 0) type = type.substring(0, semi).trim();
                        text = "data:" + type + ";base64," + Base64.encodeToString(data, Base64.NO_WRAP);
                    }
                } catch (Exception e) {
                    status = 0;
                    text = describe(e);
                } finally {
                    if (c != null) c.disconnect();
                }
                deliver(id, status, text);
            });
        }

        /** Current lock settings as JSON: enabled, grace (seconds), hideRecents, problem (null when usable). */
        @JavascriptInterface
        public String lockInfo() {
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("enabled", lockEnabled());
                o.put("grace", prefs.getInt("grace", 0));
                o.put("hideRecents", prefs.getBoolean("hideRecents", true));
                String problem = canLock();
                o.put("problem", problem == null ? org.json.JSONObject.NULL : problem);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void setLock(boolean enabled, int graceSeconds, boolean hideRecents) {
            prefs.edit()
                    .putBoolean("enabled", enabled)
                    .putInt("grace", Math.max(0, graceSeconds))
                    .putBoolean("hideRecents", hideRecents)
                    .apply();
            runOnUiThread(MainActivity.this::applyRecentsSetting);
        }

        /** Jobs just queued from this phone; a background watcher posts "Job complete" when each finishes. */
        @JavascriptInterface
        public void watchJobs(String base, String idsJson) {
            runOnUiThread(() -> {
                try {
                    watchJobs(base, idsJson);
                } catch (RuntimeException e) {
                    Log.e(TAG, "could not start the job watcher", e);
                }
            });
        }

        /** JSON: enabled (the app setting), permitted (Android permission granted). */
        @JavascriptInterface
        public String notifyInfo() {
            return "{\"enabled\":" + notifyEnabled() + ",\"permitted\":" + notifyPermitted() + "}";
        }

        @JavascriptInterface
        public void setNotify(boolean enabled) {
            prefs.edit().putBoolean("notify", enabled).apply();
            if (enabled && !notifyPermitted()) runOnUiThread(() -> {
                if (shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS) || !prefs.getBoolean("notifyAsked", false)) {
                    prefs.edit().putBoolean("notifyAsked", true).apply();
                    expectingReturn = true;
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
                } else {
                    // Android will not ask again: open the app's notification settings instead
                    expectingReturn = true;
                    startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName()));
                }
            });
        }

        @JavascriptInterface
        public void lockNow() {
            runOnUiThread(() -> {
                if (canLock() == null) {
                    setLocked(true);
                    authenticate();
                }
            });
        }

        @JavascriptInterface
        public void copyText(String text) {
            runOnUiThread(() -> {
                android.content.ClipboardManager cm = getSystemService(android.content.ClipboardManager.class);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("ComfyFold", text));
            });
        }

        /** Share text as a .txt attachment, so long logs survive apps that cut off plain messages. */
        @JavascriptInterface
        public void shareText(String text, String filename) {
            io.execute(() -> {
                try {
                    File dir = new File(getCacheDir(), "share");
                    if (!dir.exists() && !dir.mkdirs()) throw new Exception("cache unavailable");
                    File[] old = dir.listFiles();
                    if (old != null) for (File f : old) f.delete();
                    File file = new File(dir, safeName(filename));
                    try (OutputStream out = new FileOutputStream(file)) {
                        out.write((text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
                    }
                    Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", file);
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.putExtra(Intent.EXTRA_SUBJECT, file.getName());
                    send.setClipData(ClipData.newRawUri(file.getName(), uri));
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    runOnUiThread(() -> {
                        expectingReturn = true;
                        startActivity(Intent.createChooser(send, "Share"));
                    });
                } catch (Exception e) {
                    toast("Share failed: " + describe(e), true);
                }
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
                    runOnUiThread(() -> {
                        expectingReturn = true;
                        startActivity(Intent.createChooser(send, "Share"));
                    });
                } catch (Exception e) {
                    toast("Share failed: " + describe(e), true);
                }
            });
        }
    }
}
