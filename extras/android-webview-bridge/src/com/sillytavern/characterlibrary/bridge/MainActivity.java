package com.sillytavern.characterlibrary.bridge;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.security.SecureRandom;
import java.util.Locale;
import java.util.UUID;

public final class MainActivity extends Activity {
    private static final String LOG_TAG = "CLBridge";
    static final int BRIDGE_PORT = 17863;
    private static final String JANITOR_ORIGIN = "https://janitorai.com";
    private static final long FETCH_TIMEOUT_MS = 45_000L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private TextView pageStatus;
    private TextView bridgeStatus;
    private TextView requestStatus;
    private LocalBridgeServer bridgeServer;
    private String bridgeKey;
    private volatile String currentPageUrl = "";

    interface FetchCallback {
        void complete(FetchResult result);
    }

    static final class FetchResult {
        final int status;
        final String contentType;
        final String body;
        final String error;

        FetchResult(int status, String contentType, String body, String error) {
            this.status = status;
            this.contentType = contentType == null ? "" : contentType;
            this.body = body == null ? "" : body;
            this.error = error == null ? "" : error;
        }

        static FetchResult error(int status, String message) {
            return new FetchResult(status, "application/json; charset=utf-8", "", message);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridgeKey = loadOrCreateBridgeKey();
        buildUi();
        configureWebView();
        startBridge();

        if (savedInstanceState == null) {
            webView.loadUrl(JANITOR_ORIGIN + "/");
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        if (bridgeServer != null) bridgeServer.close();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    String getBridgeKey() {
        return bridgeKey;
    }

    String getCurrentPageUrl() {
        return currentPageUrl;
    }

    boolean isJanitorReady() {
        return isJanitorUrl(getCurrentPageUrl());
    }

    void fetchHampter(String sort, int page, String search, boolean nsfw, FetchCallback callback) {
        Log.i(LOG_TAG, "WebView Hampter fetch requested: sort=" + sort + ", page=" + page
            + ", nsfw=" + nsfw + ", searchLength=" + search.length());
        mainHandler.post(() -> {
            if (!isJanitorReady()) {
                Log.w(LOG_TAG, "WebView Hampter fetch rejected: JanitorAI page is not ready");
                callback.complete(FetchResult.error(409,
                    "Open JanitorAI in the bridge and finish logging in before retrying."));
                return;
            }

            Uri.Builder builder = Uri.parse(JANITOR_ORIGIN + "/hampter/characters").buildUpon()
                .appendQueryParameter("sort", sort)
                .appendQueryParameter("page", String.valueOf(page));
            if (!search.isEmpty()) builder.appendQueryParameter("search", search);
            if (!nsfw) builder.appendQueryParameter("mode", "sfw");

            String requestId = "r" + UUID.randomUUID().toString().replace("-", "");
            String resultKey = JSONObject.quote(requestId);
            String targetUrl = JSONObject.quote(builder.build().toString());
            String script = "(function(){"
                + "window.__clBridgeResults=window.__clBridgeResults||{};"
                + "window.__clBridgeResults[" + resultKey + "]=null;"
                + "fetch(" + targetUrl + ",{credentials:'include',headers:{Accept:'application/json'}})"
                + ".then(async function(r){var b=await r.text();window.__clBridgeResults[" + resultKey + "]="
                + "JSON.stringify({status:r.status,contentType:r.headers.get('content-type')||'',body:b});})"
                + ".catch(function(e){window.__clBridgeResults[" + resultKey + "]="
                + "JSON.stringify({status:0,contentType:'',body:'',error:String(e&&e.message||e)});});"
                + "return true;})()";

            long deadline = System.currentTimeMillis() + FETCH_TIMEOUT_MS;
            webView.evaluateJavascript(script, ignored -> pollFetchResult(requestId, deadline, callback));
        });
    }

    private void pollFetchResult(String requestId, long deadline, FetchCallback callback) {
        if (System.currentTimeMillis() >= deadline) {
            Log.w(LOG_TAG, "WebView Hampter fetch timed out");
            callback.complete(FetchResult.error(504, "Timed out waiting for the JanitorAI WebView request."));
            return;
        }

        String key = JSONObject.quote(requestId);
        String pollScript = "(function(){var m=window.__clBridgeResults||{};var v=m[" + key + "];"
            + "if(v){delete m[" + key + "];return v;}return null;})()";
        webView.evaluateJavascript(pollScript, encoded -> {
            String decoded = decodeJavascriptString(encoded);
            if (decoded == null || decoded.isEmpty()) {
                mainHandler.postDelayed(() -> pollFetchResult(requestId, deadline, callback), 200L);
                return;
            }
            try {
                JSONObject result = new JSONObject(decoded);
                Log.i(LOG_TAG, "WebView Hampter fetch completed: status="
                    + result.optInt("status", 0) + ", contentType="
                    + result.optString("contentType", "") + ", bodyChars="
                    + result.optString("body", "").length() + ", hasError="
                    + !result.optString("error", "").isEmpty());
                callback.complete(new FetchResult(
                    result.optInt("status", 0),
                    result.optString("contentType", ""),
                    result.optString("body", ""),
                    result.optString("error", "")
                ));
            } catch (Exception e) {
                Log.e(LOG_TAG, "Could not decode the WebView response", e);
                callback.complete(FetchResult.error(502, "Could not decode the WebView response."));
            }
        });
    }

    private static String decodeJavascriptString(String encoded) {
        if (encoded == null || "null".equals(encoded)) return null;
        try {
            Object value = new JSONTokener(encoded).nextValue();
            return value instanceof String ? (String) value : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(20, 22, 27));

        TextView title = text("Character Library Browser Bridge", 19, Color.WHITE);
        title.setPadding(dp(14), dp(12), dp(14), dp(4));
        root.addView(title);

        TextView help = text(
            "Log in normally below, then leave this app open while DataCat loads Trending or Popular.",
            13, Color.rgb(205, 209, 218));
        help.setPadding(dp(14), 0, dp(14), dp(8));
        root.addView(help);

        LinearLayout keyRow = new LinearLayout(this);
        keyRow.setOrientation(LinearLayout.HORIZONTAL);
        keyRow.setPadding(dp(14), dp(4), dp(14), dp(6));
        TextView keyView = text("Pairing key hidden - use Copy key", 12, Color.rgb(138, 180, 248));
        keyRow.addView(keyView, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button copy = new Button(this);
        copy.setText("Copy key");
        copy.setOnClickListener(v -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("CL bridge key", bridgeKey));
            Toast.makeText(this, "Bridge key copied", Toast.LENGTH_SHORT).show();
        });
        keyRow.addView(copy);
        root.addView(keyRow);

        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setPadding(dp(10), 0, dp(10), dp(4));
        Button openJanitor = new Button(this);
        openJanitor.setText("Open JanitorAI");
        openJanitor.setOnClickListener(v -> webView.loadUrl(JANITOR_ORIGIN + "/"));
        controls.addView(openJanitor, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button back = new Button(this);
        back.setText("Back");
        back.setOnClickListener(v -> { if (webView.canGoBack()) webView.goBack(); });
        controls.addView(back);
        root.addView(controls);

        bridgeStatus = text("Bridge starting...", 12, Color.rgb(245, 166, 35));
        bridgeStatus.setPadding(dp(14), 0, dp(14), dp(2));
        root.addView(bridgeStatus);
        requestStatus = text("Last request: none yet", 12, Color.LTGRAY);
        requestStatus.setPadding(dp(14), 0, dp(14), dp(2));
        root.addView(requestStatus);

        pageStatus = text("JanitorAI page loading...", 12, Color.LTGRAY);
        pageStatus.setPadding(dp(14), 0, dp(14), dp(6));
        root.addView(pageStatus);

        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                currentPageUrl = url == null ? "" : url;
                Log.i(LOG_TAG, "WebView page finished: host=" + safeHost(url)
                    + ", janitorReady=" + isJanitorUrl(url));
                pageStatus.setText(isJanitorUrl(url)
                    ? "JanitorAI context ready. Log in if needed, then test from Character Library."
                    : "Return to JanitorAI before Character Library sends a request.");
                pageStatus.setTextColor(isJanitorUrl(url)
                    ? Color.rgb(129, 199, 132) : Color.rgb(245, 166, 35));
                CookieManager.getInstance().flush();
            }
        });
    }

    private void startBridge() {
        bridgeServer = new LocalBridgeServer(this, BRIDGE_PORT);
        bridgeServer.start((ok, message) -> mainHandler.post(() -> {
            bridgeStatus.setText(message);
            bridgeStatus.setTextColor(ok ? Color.rgb(129, 199, 132) : Color.rgb(239, 83, 80));
            Log.i(LOG_TAG, "Bridge startup result: ok=" + ok + ", message=" + message);
        }));
    }

    void reportBridgeRequest(String message, boolean error) {
        if (error) Log.w(LOG_TAG, message);
        else Log.i(LOG_TAG, message);
        mainHandler.post(() -> {
            if (requestStatus == null) return;
            requestStatus.setText("Last request: " + message);
            requestStatus.setTextColor(error
                ? Color.rgb(239, 83, 80) : Color.rgb(129, 199, 132));
        });
    }

    void reportBridgeException(String message, Throwable error) {
        Log.e(LOG_TAG, message, error);
        reportBridgeRequest(message + " (" + error.getClass().getSimpleName() + ")", true);
    }

    private String loadOrCreateBridgeKey() {
        SharedPreferences prefs = getSharedPreferences("bridge", MODE_PRIVATE);
        String saved = prefs.getString("key", "");
        if (!saved.isEmpty()) return saved;
        byte[] random = new byte[24];
        new SecureRandom().nextBytes(random);
        String generated = Base64.encodeToString(random, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        prefs.edit().putString("key", generated).apply();
        return generated;
    }

    private static boolean isJanitorUrl(String value) {
        if (value == null || value.isEmpty()) return false;
        try {
            String host = Uri.parse(value).getHost();
            return host != null && (host.equalsIgnoreCase("janitorai.com")
                || host.toLowerCase(Locale.ROOT).endsWith(".janitorai.com"));
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String safeHost(String value) {
        if (value == null || value.isEmpty()) return "(none)";
        try {
            String host = Uri.parse(value).getHost();
            return host == null || host.isEmpty() ? "(unknown)" : host;
        } catch (Exception ignored) {
            return "(invalid)";
        }
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
