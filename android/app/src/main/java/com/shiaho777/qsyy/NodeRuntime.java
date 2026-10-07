package com.shiaho777.qsyy;

import android.content.Context;
import android.content.res.AssetManager;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Starts the same standalone server the desktop shell imports, inside this
 * process, bound to 127.0.0.1. The activity only displays that local URL.
 */
public final class NodeRuntime {

    public interface Listener {
        void onReady(String url);
        void onError(String message);
    }

    private static final Object LOCK = new Object();
    private static boolean started;
    private static boolean libsLoaded;
    private static String libsError;
    private static File logFile;

    private NodeRuntime() {}

    /**
     * nodejs-mobile's libnode.so is aligned to 4096-byte pages. A 16KB-page
     * phone cannot dlopen it; failing here keeps the process alive so the
     * activity can say why, instead of dying inside a static initializer.
     */
    private static String loadLibs() {
        synchronized (LOCK) {
            if (libsLoaded) return null;
            if (libsError != null) return libsError;
            long page = Os.sysconf(OsConstants._SC_PAGESIZE);
            if (page > 4096) {
                libsError = "这台手机的内存页是 " + page + " 字节，内嵌运行时只支持 4096 字节页，无法启动。";
                return libsError;
            }
            try {
                System.loadLibrary("node");
                System.loadLibrary("native-lib");
                libsLoaded = true;
                return null;
            } catch (UnsatisfiedLinkError error) {
                libsError = "无法加载内嵌运行时\n" + error.getMessage();
                return libsError;
            }
        }
    }

    public static native int startNodeWithArguments(String[] arguments);

    public static void ensureStarted(Context context, Listener listener) {
        Context app = context.getApplicationContext();
        final File files = app.getFilesDir();
        final File root = new File(files, "qsyy-app");
        final File boot = new File(root, "boot.mjs");
        logFile = new File(files, "qsyy-node.log");
        final String url = "http://127.0.0.1:18790/";
        String unsupported = loadLibs();
        if (unsupported != null) {
            listener.onError(unsupported);
            return;
        }
        synchronized (LOCK) {
            if (!started) {
                started = true;
                new Thread(() -> {
                    try {
                        if (logFile.exists() && !logFile.delete()) logFile.createNewFile();
                        copyAssetTree(app.getAssets(), "qsyy-app", root);
                        prepareEnv(files, root);
                        // Blocks until the embedded server exits.
                        startNodeWithArguments(new String[]{"node", boot.getAbsolutePath()});
                        appendLog("node exited");
                    } catch (Throwable error) {
                        appendLog(String.valueOf(error.getMessage() == null ? error : error));
                        if (error.getCause() != null) appendLog(String.valueOf(error.getCause()));
                    }
                }, "qsyy-node").start();
            }
        }
        new Thread(() -> {
            for (int attempt = 0; attempt < 80; attempt += 1) {
                if (probe(url)) {
                    listener.onReady(url);
                    return;
                }
                try { Thread.sleep(250); } catch (InterruptedException ignored) { return; }
            }
            String tail = readTail(logFile);
            listener.onError(tail.isEmpty()
                    ? "本机服务没有在 127.0.0.1:18790 起来"
                    : "本机服务没有起来\n" + tail);
        }, "qsyy-probe").start();
    }

    private static void prepareEnv(File files, File root) throws ErrnoException {
        File tmp = new File(files, "tmp");
        File home = files;
        if (!tmp.isDirectory() && !tmp.mkdirs()) {
            // mkdir failure surfaces when the server writes its first temp file
        }
        set("HOME", home.getAbsolutePath());
        set("TMPDIR", tmp.getAbsolutePath());
        set("QSYY_HOME", home.getAbsolutePath());
        set("QSYY_APP_ROOT", root.getAbsolutePath());
        set("QSYY_PLATFORM", "android");
        set("QSYY_HOST", "127.0.0.1");
        set("QSYY_PORT", "18790");
        set("QSYY_VERSION", BuildConfig.VERSION_NAME);
        set("QSYY_LOG", new File(files, "qsyy-node.log").getAbsolutePath());
        set("QSYY_DOWNLOAD_DIR", new File(home, "Downloads").getAbsolutePath());
        set("XDG_CACHE_HOME", new File(home, ".cache").getAbsolutePath());
        set("XDG_CONFIG_HOME", new File(home, ".config").getAbsolutePath());
    }

    private static void set(String key, String value) throws ErrnoException {
        Os.setenv(key, value, true);
    }

    private static boolean probe(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(800);
            connection.setReadTimeout(800);
            connection.setInstanceFollowRedirects(false);
            int code = connection.getResponseCode();
            return code >= 200 && code < 500;
        } catch (IOException ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void copyAssetTree(AssetManager assets, String assetPath, File dest) throws IOException {
        String[] children = assets.list(assetPath);
        if (children == null || children.length == 0) {
            File parent = dest.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw new IOException("mkdir " + parent);
            }
            try (InputStream in = assets.open(assetPath);
                 OutputStream out = new FileOutputStream(dest)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            }
            return;
        }
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("mkdir " + dest);
        for (String child : children) {
            copyAssetTree(assets, assetPath + "/" + child, new File(dest, child));
        }
    }

    private static void appendLog(String line) {
        if (logFile == null) return;
        try (FileOutputStream out = new FileOutputStream(logFile, true)) {
            out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {}
    }

    private static String readTail(File file) {
        if (file == null || !file.isFile()) return "";
        try {
            byte[] data = new byte[(int) Math.min(file.length(), 4000)];
            try (InputStream in = new java.io.FileInputStream(file)) {
                long skip = Math.max(0, file.length() - data.length);
                while (skip > 0) {
                    long n = in.skip(skip);
                    if (n <= 0) break;
                    skip -= n;
                }
                int read = in.read(data);
                if (read <= 0) return "";
                return new String(data, 0, read, StandardCharsets.UTF_8);
            }
        } catch (IOException ignored) {
            return "";
        }
    }
}
