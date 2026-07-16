package com.sillytavern.characterlibrary.bridge;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

final class LocalBridgeServer {
    private static final int MAX_BODY_BYTES = 32 * 1024;
    private static final int SOCKET_TIMEOUT_MS = 50_000;

    interface StartCallback {
        void complete(boolean ok, String message);
    }

    private final MainActivity activity;
    private final int port;
    private final ExecutorService clients = Executors.newCachedThreadPool();
    private final AtomicLong requestSequence = new AtomicLong();
    private volatile boolean running;
    private ServerSocket serverSocket;

    LocalBridgeServer(MainActivity activity, int port) {
        this.activity = activity;
        this.port = port;
    }

    void start(StartCallback callback) {
        running = true;
        Thread acceptThread = new Thread(() -> {
            try {
                serverSocket = new ServerSocket();
                serverSocket.setReuseAddress(true);
                serverSocket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
                callback.complete(true, "Bridge listening on http://127.0.0.1:" + port);
                while (running) {
                    Socket socket = serverSocket.accept();
                    clients.execute(() -> handle(socket));
                }
            } catch (IOException e) {
                if (running) callback.complete(false, "Bridge failed: " + e.getMessage());
            }
        }, "cl-bridge-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    void close() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) {}
        clients.shutdownNow();
    }

    private void handle(Socket socket) {
        String requestLabel = "request";
        try (Socket client = socket;
             InputStream input = new BufferedInputStream(client.getInputStream());
             BufferedOutputStream output = new BufferedOutputStream(client.getOutputStream())) {
            client.setSoTimeout(SOCKET_TIMEOUT_MS);
            Request request = readRequest(input);
            if (request == null) {
                activity.reportBridgeRequest("Malformed HTTP request", true);
                writeJson(output, 400, "Bad Request", "", errorBody("Malformed HTTP request."));
                return;
            }

            String origin = request.headers.getOrDefault("origin", "");
            String suppliedRequestId = request.headers.getOrDefault("x-cl-bridge-request-id", "");
            String requestId = safeRequestId(suppliedRequestId);
            if (requestId.isEmpty()) requestId = String.valueOf(requestSequence.incrementAndGet());
            requestLabel = "#" + requestId + " " + request.method + " " + request.path;
            activity.reportBridgeRequest(requestLabel + " received from " + safeOrigin(origin), false);
            if ("OPTIONS".equals(request.method)) {
                write(output, 204, "No Content", origin, "text/plain; charset=utf-8", new byte[0]);
                activity.reportBridgeRequest(requestLabel + " preflight allowed", false);
                return;
            }

            String suppliedKey = request.headers.getOrDefault("x-cl-bridge-key", "");
            if (!constantTimeEquals(activity.getBridgeKey(), suppliedKey)) {
                writeJson(output, 401, "Unauthorized", origin, errorBody("Invalid bridge key."));
                activity.reportBridgeRequest(requestLabel + " rejected: invalid pairing key", true);
                return;
            }

            if ("GET".equals(request.method) && "/v1/status".equals(request.path)) {
                JSONObject status = new JSONObject();
                status.put("ok", true);
                status.put("version", 1);
                status.put("janitorReady", activity.isJanitorReady());
                status.put("currentUrl", activity.getCurrentPageUrl());
                writeJson(output, 200, "OK", origin, status.toString());
                activity.reportBridgeRequest(requestLabel + " responded 200 (janitorReady="
                    + activity.isJanitorReady() + ")", false);
                return;
            }

            if ("POST".equals(request.method) && "/v1/janitor/hampter".equals(request.path)) {
                handleHampter(output, origin, request.body, requestLabel);
                return;
            }

            writeJson(output, 404, "Not Found", origin, errorBody("Unknown bridge route."));
            activity.reportBridgeRequest(requestLabel + " responded 404", true);
        } catch (Exception error) {
            activity.reportBridgeException(requestLabel + " socket failure", error);
        }
    }

    private void handleHampter(BufferedOutputStream output, String origin, String body,
                               String requestLabel) throws Exception {
        JSONObject input;
        try { input = new JSONObject(body.isEmpty() ? "{}" : body); }
        catch (Exception e) {
            writeJson(output, 400, "Bad Request", origin, errorBody("Request body must be JSON."));
            return;
        }

        String sort = input.optString("sort", "trending");
        if (!"trending".equals(sort)
                && !"popular".equals(sort)
                && !"latest".equals(sort)
                && !"trending24".equals(sort)
                && !"relevance".equals(sort)) {
            writeJson(output, 400, "Bad Request", origin, errorBody("Unsupported Hampter sort."));
            return;
        }
        int page = input.optInt("page", 1);
        if (page < 1 || page > 1000) {
            writeJson(output, 400, "Bad Request", origin, errorBody("Page is out of range."));
            return;
        }
        String search = input.optString("search", "");
        if (search.length() > 200) {
            writeJson(output, 400, "Bad Request", origin, errorBody("Search text is too long."));
            return;
        }
        boolean nsfw = input.optBoolean("nsfw", true);
        activity.reportBridgeRequest(requestLabel + " dispatching WebView fetch (sort=" + sort
            + ", page=" + page + ", nsfw=" + nsfw + ", searchLength=" + search.length() + ")", false);

        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<MainActivity.FetchResult> resultRef = new AtomicReference<>();
        activity.fetchHampter(sort, page, search, nsfw, result -> {
            resultRef.set(result);
            latch.countDown();
        });

        if (!latch.await(48, TimeUnit.SECONDS)) {
            activity.reportBridgeRequest(requestLabel + " timed out waiting for WebView", true);
            writeJson(output, 504, "Gateway Timeout", origin, errorBody("WebView request timed out."));
            return;
        }
        MainActivity.FetchResult result = resultRef.get();
        if (result == null) {
            activity.reportBridgeRequest(requestLabel + " failed: WebView returned no result", true);
            writeJson(output, 502, "Bad Gateway", origin, errorBody("WebView returned no result."));
            return;
        }
        if (!result.error.isEmpty()) {
            activity.reportBridgeRequest(requestLabel + " WebView error (status=" + result.status + ")", true);
            writeJson(output, result.status > 0 ? result.status : 502, "Bridge Error", origin,
                errorBody(result.error));
            return;
        }
        int status = result.status > 0 ? result.status : 502;
        String contentType = result.contentType.isEmpty()
            ? "application/octet-stream" : result.contentType;
        write(output, status, reasonFor(status), origin, contentType,
            result.body.getBytes(StandardCharsets.UTF_8));
        activity.reportBridgeRequest(requestLabel + " responded " + status + " (contentType="
            + contentType + ", bodyChars=" + result.body.length() + ")", status < 200 || status >= 300);
    }

    private static Request readRequest(InputStream input) throws IOException {
        String requestLine = readLine(input);
        if (requestLine == null || requestLine.isEmpty()) return null;
        String[] parts = requestLine.split(" ", 3);
        if (parts.length < 2) return null;

        Map<String, String> headers = new HashMap<>();
        String line;
        while ((line = readLine(input)) != null && !line.isEmpty()) {
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                line.substring(colon + 1).trim());
        }

        int contentLength = 0;
        try { contentLength = Integer.parseInt(headers.getOrDefault("content-length", "0")); }
        catch (NumberFormatException ignored) { return null; }
        if (contentLength < 0 || contentLength > MAX_BODY_BYTES) return null;

        byte[] body = new byte[contentLength];
        int offset = 0;
        while (offset < contentLength) {
            int read = input.read(body, offset, contentLength - offset);
            if (read < 0) return null;
            offset += read;
        }
        String path = parts[1].split("\\?", 2)[0];
        return new Request(parts[0].toUpperCase(Locale.ROOT), path, headers,
            new String(body, StandardCharsets.UTF_8));
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) >= 0) {
            if (value == '\n') break;
            if (value != '\r') bytes.write(value);
            if (bytes.size() > 8192) throw new IOException("HTTP line too long");
        }
        if (value < 0 && bytes.size() == 0) return null;
        return bytes.toString("UTF-8");
    }

    private static void writeJson(BufferedOutputStream output, int status, String reason,
                                  String origin, String body) throws IOException {
        write(output, status, reason, origin, "application/json; charset=utf-8",
            body.getBytes(StandardCharsets.UTF_8));
    }

    private static void write(BufferedOutputStream output, int status, String reason,
                              String origin, String contentType, byte[] body) throws IOException {
        String allowedOrigin = isWebOrigin(origin) ? origin : "null";
        String headers = "HTTP/1.1 " + status + " " + reason + "\r\n"
            + "Content-Type: " + contentType + "\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Cache-Control: no-store\r\n"
            + "Access-Control-Allow-Origin: " + allowedOrigin + "\r\n"
            + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            + "Access-Control-Allow-Headers: Content-Type, X-CL-Bridge-Key, X-CL-Bridge-Request-Id\r\n"
            + "Access-Control-Allow-Private-Network: true\r\n"
            + "Vary: Origin\r\n"
            + "Connection: close\r\n\r\n";
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        output.write(body);
        output.flush();
    }

    private static boolean isWebOrigin(String origin) {
        return origin != null && (origin.startsWith("http://") || origin.startsWith("https://"));
    }

    private static String safeOrigin(String origin) {
        if (origin == null || origin.isEmpty()) return "(none)";
        if (!isWebOrigin(origin) || origin.length() > 200) return "(invalid)";
        return origin.replaceAll("[^A-Za-z0-9:/._-]", "?");
    }

    private static String safeRequestId(String value) {
        if (value == null) return "";
        String cleaned = value.replaceAll("[^A-Za-z0-9_-]", "");
        return cleaned.length() > 24 ? cleaned.substring(0, 24) : cleaned;
    }

    private static String errorBody(String message) {
        try { return new JSONObject().put("ok", false).put("error", message).toString(); }
        catch (Exception ignored) { return "{\"ok\":false,\"error\":\"Bridge error\"}"; }
    }

    private static boolean constantTimeEquals(String expected, String supplied) {
        if (expected == null || supplied == null) return false;
        int diff = expected.length() ^ supplied.length();
        int max = Math.max(expected.length(), supplied.length());
        for (int i = 0; i < max; i++) {
            char a = i < expected.length() ? expected.charAt(i) : 0;
            char b = i < supplied.length() ? supplied.charAt(i) : 0;
            diff |= a ^ b;
        }
        return diff == 0;
    }

    private static String reasonFor(int status) {
        if (status >= 200 && status < 300) return "OK";
        if (status == 400) return "Bad Request";
        if (status == 401) return "Unauthorized";
        if (status == 403) return "Forbidden";
        if (status == 404) return "Not Found";
        if (status == 409) return "Conflict";
        if (status == 429) return "Too Many Requests";
        if (status >= 500) return "Bad Gateway";
        return "Upstream Response";
    }

    private static final class Request {
        final String method;
        final String path;
        final Map<String, String> headers;
        final String body;

        Request(String method, String path, Map<String, String> headers, String body) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }
    }
}
