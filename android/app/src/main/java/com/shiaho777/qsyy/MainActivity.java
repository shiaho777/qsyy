package com.shiaho777.qsyy;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.Gravity;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * Single-activity WebView shell. NodeRuntime runs the standalone server in
 * this process and the window opens http://127.0.0.1 — the same shape as the
 * desktop shell, with no address to type.
 */
public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private TextView status;
    private ValueCallback<Uri[]> fileCallback;

    private final ActivityResultLauncher<Intent> fileChooser =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                ValueCallback<Uri[]> callback = fileCallback;
                fileCallback = null;
                if (callback == null) return;
                callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(
                        result.getResultCode(), result.getData()));
            });

    private final ActivityResultLauncher<String> notifyPermission =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (granted) startPlaybackService();
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        status = new TextView(this);
        status.setText("正在本机启动…");
        status.setGravity(Gravity.CENTER);
        status.setTextColor(Color.WHITE);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        status.setPadding(pad, pad, pad, pad);
        setContentView(status);
        NodeRuntime.ensureStarted(this, new NodeRuntime.Listener() {
            @Override public void onReady(String url) {
                runOnUiThread(() -> launch(url));
            }
            @Override public void onError(String message) {
                runOnUiThread(() -> status.setText(message));
            }
        });
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void launch(String serverUrl) {
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri uri = r.getUrl();
                if (uri.toString().startsWith(serverUrl)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {}
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    fileChooser.launch(params.createIntent());
                    return true;
                } catch (ActivityNotFoundException error) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                request.setMimeType(mimeType);
                request.setTitle(name);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "qsyy/" + name);
                if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
                DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (manager != null) manager.enqueue(request);
            } catch (RuntimeException ignored) {}
        });
        // Only this origin is loaded. The bridge copies an app-private export
        // into the system Downloads collection; it refuses any other path.
        webView.addJavascriptInterface(new AndroidBridge(this), "QsyyAndroid");
        webView.loadUrl(serverUrl);
        ensurePlaybackService();
    }

    private void ensurePlaybackService() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            notifyPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS);
            return;
        }
        startPlaybackService();
    }

    private void startPlaybackService() {
        try {
            startForegroundService(new Intent(this, PlaybackService.class));
        } catch (RuntimeException ignored) {}
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) finishAfterTransition();
        else super.onBackPressed();
    }

    static final class AndroidBridge {
        private final Activity activity;

        AndroidBridge(Activity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public String publishDownload(String path) {
            if (path == null || path.isEmpty()) return "没有文件路径";
            File file = new File(path);
            if (!file.isFile()) return "文件不存在";
            if (!allowed(file)) return "拒绝导出应用目录以外的文件";
            try {
                if (Build.VERSION.SDK_INT >= 29) return publishMediaStore(file);
                return publishLegacy(file);
            } catch (IOException error) {
                return error.getMessage() == null ? "写入下载目录失败" : error.getMessage();
            }
        }

        @JavascriptInterface
        public void openDownloads() {
            activity.runOnUiThread(() -> {
                if (activity.isFinishing() || activity.isDestroyed()) return;
                try {
                    activity.startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
                } catch (ActivityNotFoundException ignored) {}
            });
        }

        private boolean allowed(File file) {
            try {
                String canon = file.getCanonicalPath();
                File files = activity.getFilesDir();
                File cache = activity.getCacheDir();
                File external = activity.getExternalFilesDir(null);
                return under(canon, files) || under(canon, cache) || under(canon, external);
            } catch (IOException error) {
                return false;
            }
        }

        private static boolean under(String canon, File root) throws IOException {
            if (root == null) return false;
            String prefix = root.getCanonicalPath();
            return canon.equals(prefix) || canon.startsWith(prefix + File.separator);
        }

        private String publishMediaStore(File file) throws IOException {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, file.getName());
            values.put(MediaStore.Downloads.MIME_TYPE, mime(file.getName()));
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/qsyy");
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) return "系统没有接受这个下载";
            try {
                copyInto(file, uri);
            } catch (IOException error) {
                activity.getContentResolver().delete(uri, null, null);
                throw error;
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            activity.getContentResolver().update(uri, values, null, null);
            return "";
        }

        private String publishLegacy(File file) throws IOException {
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "qsyy");
            if (!dir.isDirectory() && !dir.mkdirs()) return "无法创建下载目录";
            File dest = new File(dir, file.getName());
            try (InputStream in = new FileInputStream(file); OutputStream out = new java.io.FileOutputStream(dest)) {
                transfer(in, out);
            }
            return "";
        }

        private void copyInto(File file, Uri uri) throws IOException {
            try (InputStream in = new FileInputStream(file);
                 OutputStream out = activity.getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new IOException("无法写入下载目录");
                transfer(in, out);
            }
        }

        private static void transfer(InputStream in, OutputStream out) throws IOException {
            byte[] buffer = new byte[65536];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }

        private static String mime(String name) {
            String lower = name.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".zip")) return "application/zip";
            if (lower.endsWith(".m4a")) return "audio/mp4";
            if (lower.endsWith(".mp3")) return "audio/mpeg";
            if (lower.endsWith(".flac")) return "audio/flac";
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
            if (lower.endsWith(".png")) return "image/png";
            if (lower.endsWith(".webp")) return "image/webp";
            if (lower.endsWith(".txt") || lower.endsWith(".lrc")) return "text/plain";
            return "application/octet-stream";
        }
    }
}
