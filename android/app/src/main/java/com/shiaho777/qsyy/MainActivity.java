package com.shiaho777.qsyy;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Single-activity WebView shell. The qsyy server runs on the user's desktop
 * machine; this app just points at it (address asked on first launch, stored
 * in default SharedPreferences). MediaSession controls from the web page are
 * bridged to a foreground service so playback survives backgrounding.
 */
public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "qsyy";
    private static final String KEY_SERVER = "serverUrl";

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String saved = prefs.getString(KEY_SERVER, "");
        if (saved.isEmpty()) { askForServer(prefs); return; }
        launch(saved);
    }

    private void askForServer(SharedPreferences prefs) {
        // sensible default: the LAN address pattern the server prints
        final android.widget.EditText input = new android.widget.EditText(this);
        input.setHint("http://192.168.x.x:18790");
        input.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        ViewGroup.LayoutParams lp = new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        ViewGroup container = new ViewGroup(this) {
            @Override protected void onLayout(boolean c, int l, int t, int r, int b) {}
        };
        container.addView(input, lp);
        container.setPadding(pad, pad, pad, 0);

        new AlertDialog.Builder(this)
                .setTitle("qsyy 服务端地址")
                .setMessage("在电脑上运行 qsyy 并开启局域网访问后,填入它打印的地址")
                .setView(container)
                .setCancelable(false)
                .setPositiveButton("连接", (d, w) -> {
                    String url = input.getText().toString().trim();
                    if (!url.startsWith("http")) url = "http://" + url;
                    url = url.replaceAll("/+$", "");
                    prefs.edit().putString(KEY_SERVER, url).apply();
                    launch(url);
                })
                .show();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void launch(String serverUrl) {
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri uri = r.getUrl();
                // keep the app in-shell; everything else (GitHub links) goes out
                if (uri.toString().startsWith(serverUrl)) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient());
        webView.loadUrl(serverUrl);

        startForegroundService(new Intent(this, PlaybackService.class));
    }

    @Override
    protected void onDestroy() {
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
}
