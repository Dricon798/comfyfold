package app.comfyfold;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Watches jobs queued from this phone and posts "Job complete" when they finish.
 * Runs as a short-lived foreground service because Android pauses the app (and its live
 * connection to ComfyUI) once it is in the background. Polls ComfyUI's /history/{id} and /queue,
 * and stops itself as soon as nothing is left to watch.
 */
public class JobWatchService extends Service {
    private static final String TAG = "ComfyFoldJobs";
    static final String EXTRA_BASE = "base";
    static final String EXTRA_IDS = "ids";
    private static final String CH_WATCH = "watching";
    private static final String CH_DONE = "done";
    private static final int ID_WATCH = 1;
    private static final int ID_DONE = 2;
    private static final long POLL_SECONDS = 4;
    private static final long GIVE_UP_MS = 30 * 60 * 1000;   // server unreachable this long: stop watching

    /** Set by MainActivity: no "Job complete" pop-up while the app is on screen. */
    static volatile boolean appVisible = false;

    private final Map<String, Integer> jobs = new LinkedHashMap<>();   // prompt id -> times seen missing
    private String base;
    private ScheduledExecutorService poller;
    private long lastContact;
    private static int finishedUnseen = 0;   // since the user last opened the app
    private static boolean anyFailed = false;

    static void watch(Context ctx, String base, String idsJson) {
        Intent i = new Intent(ctx, JobWatchService.class);
        i.putExtra(EXTRA_BASE, base);
        i.putExtra(EXTRA_IDS, idsJson);
        ctx.startForegroundService(i);
    }

    /** Called when the user opens the app: the finished-count starts again from zero. */
    static void clearDone(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(ID_DONE);
        finishedUnseen = 0;
        anyFailed = false;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel watch = new NotificationChannel(CH_WATCH, "Watching jobs", NotificationManager.IMPORTANCE_MIN);
        watch.setDescription("Shown while ComfyFold waits for queued jobs to finish");
        watch.setShowBadge(false);
        NotificationChannel done = new NotificationChannel(CH_DONE, "Job complete", NotificationManager.IMPORTANCE_DEFAULT);
        done.setDescription("A job you queued has finished");
        nm.createNotificationChannel(watch);
        nm.createNotificationChannel(done);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(ID_WATCH, watchingNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        if (intent != null) {
            String b = intent.getStringExtra(EXTRA_BASE);
            if (b != null && !b.isEmpty()) {
                synchronized (jobs) {
                    if (base != null && !base.equals(b)) jobs.clear();   // switched server
                    base = b;
                }
            }
            try {
                JSONArray ids = new JSONArray(intent.getStringExtra(EXTRA_IDS));
                synchronized (jobs) {
                    for (int k = 0; k < ids.length(); k++) jobs.put(ids.getString(k), 0);
                }
            } catch (Exception e) {
                Log.w(TAG, "bad job list", e);
            }
        }
        lastContact = SystemClock.elapsedRealtime();
        if (poller == null) {
            poller = Executors.newSingleThreadScheduledExecutor();
            poller.scheduleWithFixedDelay(this::poll, POLL_SECONDS, POLL_SECONDS, TimeUnit.SECONDS);
        }
        stopIfIdle();
        return START_NOT_STICKY;
    }

    private void poll() {
        try {
            String[] ids;
            String b;
            synchronized (jobs) {
                ids = jobs.keySet().toArray(new String[0]);
                b = base;
            }
            if (ids.length == 0 || b == null) { stopIfIdle(); return; }
            String queue;
            try {
                queue = get(b + "/queue");
                lastContact = SystemClock.elapsedRealtime();
            } catch (Exception e) {
                if (SystemClock.elapsedRealtime() - lastContact > GIVE_UP_MS) {
                    Log.w(TAG, "server unreachable for too long, giving up");
                    synchronized (jobs) { jobs.clear(); }
                    stopIfIdle();
                }
                return;
            }
            for (String id : ids) {
                if (queue.contains(id)) {
                    synchronized (jobs) { jobs.put(id, 0); }
                    continue;
                }
                JSONObject hist = new JSONObject(get(b + "/history/" + URLEncoder.encode(id, "UTF-8")));
                JSONObject entry = hist.optJSONObject(id);
                if (entry != null) {
                    synchronized (jobs) { jobs.remove(id); }
                    JSONObject status = entry.optJSONObject("status");
                    String s = status == null ? "success" : status.optString("status_str", "success");
                    boolean interrupted = status != null && status.toString().contains("execution_interrupted");
                    if (interrupted) continue;            // you stopped it yourself: no notification
                    announce(!"success".equals(s));
                } else {
                    // neither queued nor in history: deleted from the queue, or ComfyUI restarted
                    synchronized (jobs) {
                        int misses = jobs.getOrDefault(id, 0) + 1;
                        if (misses >= 3) jobs.remove(id); else jobs.put(id, misses);
                    }
                }
            }
            stopIfIdle();
        } catch (Exception e) {
            Log.w(TAG, "poll failed", e);
        }
    }

    private void announce(boolean failed) {
        if (appVisible) return;
        finishedUnseen++;
        anyFailed |= failed;
        String title = finishedUnseen == 1
                ? (failed ? "Job failed" : "Job complete")
                : finishedUnseen + " jobs finished" + (anyFailed ? " (some failed)" : "");
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CH_DONE)
                .setSmallIcon(R.drawable.ic_stat_done)
                .setContentTitle(title)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .build();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && nm.areNotificationsEnabled()) nm.notify(ID_DONE, n);
    }

    private Notification watchingNotification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CH_WATCH)
                .setSmallIcon(R.drawable.ic_stat_done)
                .setContentTitle("Watching for finished jobs")
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void stopIfIdle() {
        boolean empty;
        synchronized (jobs) { empty = jobs.isEmpty(); }
        if (!empty) return;
        if (poller != null) { poller.shutdownNow(); poller = null; }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (poller != null) poller.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(6000);
        c.setReadTimeout(15000);
        try {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return out.toString(StandardCharsets.UTF_8.name());
        } finally {
            c.disconnect();
        }
    }
}
