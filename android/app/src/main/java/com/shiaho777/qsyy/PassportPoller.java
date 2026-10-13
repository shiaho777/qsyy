package com.shiaho777.qsyy;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import org.json.JSONObject;

/**
 * Polls ByteDance passport from a WebView that looks like the official PC
 * security page: sdk-glue + CDN bdms.js add a_bogus, then XHR runs same-origin
 * at api.qishui.com. Unsigned Node polls stay at error_code=7 after scan, and
 * the session cookies live in this WebView jar, not in the JSON body.
 */
final class PassportPoller {
    private static final String PAGE = "https://api.qishui.com/qsyy-poll.html";
    private static final String PASSPORT_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "SodaMusic/3.2.1 Chrome/136.0.7103.59 Electron/36.4.0 Safari/537.36";

    interface Listener {
        void onResult(JSONObject result);
    }

    private final Activity activity;
    private final String local;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView webView;
    private boolean busy;
    private boolean pageReady;
    private long lastStart;
    private String token = "";
    private Listener listener;
    private JSONObject spec;
    private byte[] signerHtml;
    private byte[] glueJs;

    PassportPoller(Activity activity, String serverUrl) {
        this.activity = activity;
        this.local = serverUrl == null || serverUrl.isEmpty()
                ? "http://127.0.0.1:18790"
                : serverUrl.replaceAll("/+$", "");
    }

    boolean offer(String nextToken, Listener nextListener) {
        if (nextToken == null || nextToken.isEmpty()) return false;
        long now = System.currentTimeMillis();
        if (busy && now - lastStart < 8000) return false;
        if (!busy && now - lastStart < 2800) return false;
        busy = true;
        lastStart = now;
        token = nextToken;
        listener = nextListener;
        new Thread(() -> run(nextToken), "qsyy-passport-poll").start();
        return true;
    }

    void stop() {
        busy = false;
        token = "";
        pageReady = false;
        main.post(this::destroyView);
    }

    private void run(String pollToken) {
        try {
            ensureAssets();
            if (signerHtml == null || signerHtml.length == 0 || glueJs == null || glueJs.length == 0) {
                finish(json("error", "登录通道文件缺失"));
                return;
            }
            JSONObject spec = getJson(local + "/api/weblogin/poll-spec?token=" + Uri.encode(pollToken));
            if (spec == null || !spec.optBoolean("ok", false)) {
                finish(json("expired", "二维码已过期,请重新生成"));
                return;
            }
            this.spec = spec;
            main.post(() -> {
                if (webView != null && pageReady && pollToken.equals(token)) startPoll();
                else startWebView();
            });
        } catch (Exception error) {
            finish(json("error", String.valueOf(error.getMessage())));
        }
    }

    private void ensureAssets() {
        if (signerHtml != null && glueJs != null) return;
        signerHtml = getBytes(local + "/qr-signer.html");
        glueJs = getBytes(local + "/security/sdk-glue.js");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void startWebView() {
        if (activity.isFinishing() || activity.isDestroyed()) {
            finish(json("error", "界面已关闭"));
            return;
        }
        pageReady = false;
        destroyView();
        webView = new WebView(activity);
        ViewGroup root = activity.findViewById(android.R.id.content);
        if (root != null) root.addView(webView, new ViewGroup.LayoutParams(1, 1));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setBlockNetworkImage(true);
        settings.setUserAgentString(PASSPORT_UA);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);
        JSONObject jar = spec == null ? null : spec.optJSONObject("cookies");
        if (jar != null) {
            Iterator<String> keys = jar.keys();
            while (keys.hasNext()) {
                String name = keys.next();
                String value = jar.optString(name, "");
                if (name.startsWith("sessionid")) continue;
                String pair = name + "=" + value + "; Path=/; Domain=.qishui.com";
                cookies.setCookie("https://api.qishui.com", pair);
                cookies.setCookie("https://bff-pc.qishui.com", pair);
            }
        }
        cookies.flush();
        webView.addJavascriptInterface(new Bridge(), "QsyyQr");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url == null) return super.shouldInterceptRequest(view, request);
                String path = url.getPath() == null ? "" : url.getPath();
                if ("/qsyy-poll.html".equals(path)) {
                    return new WebResourceResponse(
                            "text/html",
                            "utf-8",
                            new ByteArrayInputStream(signerHtml));
                }
                if (path.endsWith("/sdk-glue.js")) {
                    return new WebResourceResponse(
                            "text/javascript",
                            "utf-8",
                            new ByteArrayInputStream(glueJs));
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                view.evaluateJavascript(
                        "window.qsyyWhenReady().then(function(){QsyyQr.arm && QsyyQr.arm()})"
                                + ".catch(function(e){QsyyQr.onPoll(JSON.stringify({status:0,error:String(e)}));})",
                        null);
            }
        });
        webView.loadUrl(PAGE);
    }

    private void startPoll() {
        if (webView == null) {
            startWebView();
            return;
        }
        webView.evaluateJavascript(
                "window.qsyyWhenReady().then(function(){QsyyQr.arm && QsyyQr.arm()})"
                        + ".catch(function(e){QsyyQr.onPoll(JSON.stringify({status:0,error:String(e)}));})",
                null);
    }

    private void finish(JSONObject result) {
        busy = false;
        String status = result == null ? "" : result.optString("status");
        if ("success".equals(status) || "expired".equals(status)) {
            pageReady = false;
            token = "";
            main.post(this::destroyView);
        }
        Listener target = listener;
        if (target != null) target.onResult(result);
    }

    private void destroyView() {
        if (webView == null) return;
        if (webView.getParent() instanceof ViewGroup) {
            ((ViewGroup) webView.getParent()).removeView(webView);
        }
        webView.stopLoading();
        webView.loadUrl("about:blank");
        webView.destroy();
        webView = null;
        pageReady = false;
    }

    final class Bridge {
        @JavascriptInterface
        public void arm() {
            JSONObject current = spec;
            if (current == null) return;
            JSONObject opts = new JSONObject();
            try {
                opts.put("postUrl", current.optString("postUrl"));
                opts.put("getUrl", current.optString("getUrl"));
                opts.put("body", current.optString("body"));
                JSONObject headers = current.optJSONObject("headers");
                if (headers != null) {
                    headers.remove("cookie");
                    headers.remove("Cookie");
                    opts.put("headers", headers);
                }
            } catch (Exception ignored) {}
            String js = "qsyyPassportPoll(" + opts + ").then(function(r){QsyyQr.onPoll(JSON.stringify(r));})"
                    + ".catch(function(e){QsyyQr.onPoll(JSON.stringify({status:0,error:String(e)}));});";
            main.post(() -> {
                if (webView != null) webView.evaluateJavascript(js, null);
            });
        }

        @JavascriptInterface
        public void onPoll(String raw) {
            new Thread(() -> postResult(raw), "qsyy-passport-result").start();
        }
    }

    private void postResult(String raw) {
        try {
            JSONObject payload = new JSONObject(raw == null || raw.isEmpty() ? "{}" : raw);
            payload.put("token", token);
            payload.put("httpStatus", payload.optInt("status", 0));
            payload.put("signed", true);
            String harvested = harvestedCookies();
            if (!harvested.isEmpty()) payload.put("cookie", harvested);
            JSONObject adopted = postJson(local + "/api/weblogin/poll-result", payload);
            finish(adopted != null ? adopted : json("error", "回写轮询结果失败"));
        } catch (Exception error) {
            finish(json("error", String.valueOf(error.getMessage())));
        }
    }

    private static String harvestedCookies() {
        CookieManager cookies = CookieManager.getInstance();
        String a = cookies.getCookie("https://api.qishui.com");
        String b = cookies.getCookie("https://bff-pc.qishui.com");
        if (a == null || a.isEmpty()) return b == null ? "" : b;
        if (b == null || b.isEmpty() || b.equals(a)) return a;
        return a + "; " + b;
    }

    private static JSONObject json(String status, String message) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("status", status);
            obj.put("message", message);
        } catch (Exception ignored) {}
        return obj;
    }

    private static byte[] getBytes(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            try (InputStream in = connection.getInputStream()) {
                return readBytes(in);
            }
        } catch (Exception error) {
            return new byte[0];
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static JSONObject getJson(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        try (InputStream in = connection.getInputStream()) {
            return new JSONObject(new String(readBytes(in), StandardCharsets.UTF_8));
        } catch (Exception error) {
            return null;
        } finally {
            connection.disconnect();
        }
    }

    private static JSONObject postJson(String url, JSONObject body) throws IOException {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        connection.setDoOutput(true);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("content-type", "application/json");
        try (OutputStream out = connection.getOutputStream()) {
            out.write(bytes);
        }
        try (InputStream in = connection.getInputStream()) {
            return new JSONObject(new String(readBytes(in), StandardCharsets.UTF_8));
        } catch (Exception error) {
            return null;
        } finally {
            connection.disconnect();
        }
    }

    private static byte[] readBytes(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int n;
        while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
        return out.toByteArray();
    }
}
