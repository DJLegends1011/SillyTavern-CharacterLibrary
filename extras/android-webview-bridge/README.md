# Character Library Browser Bridge (Android prototype)

This prototype keeps JanitorAI login and Hampter requests inside Android WebView. It does **not** export JanitorAI or Cloudflare cookies to SillyTavern's Node backend.

## Build

The included PowerShell build script uses the Android 34 SDK tools directly and does not require Gradle:

```powershell
.\build-debug.ps1
```

The default output is `CharacterLibraryBridge-debug.apk` beside the build script.

## Test on the Android device running SillyTavern in Termux

1. Install and open the APK.
2. Log into JanitorAI in the embedded page, allow notifications, then return to Chrome.
3. Tap **Copy key** in the APK. The key stays hidden on screen to avoid accidental screenshot leaks.
4. Open SillyTavern through `http://127.0.0.1` or `http://localhost` on the same Android device.
5. In Character Library, open **Settings → Online → DataCat → Android WebView Bridge**.
6. Enter `http://127.0.0.1:17863`, paste the bridge key, and press **Test Bridge**.
7. In DataCat, select **Trending** or **Popular**.

The bridge is loopback-only and requires its random key on every non-preflight request. Only the fixed JanitorAI Hampter operation is implemented; it is not an open URL proxy.

When signed in inside the APK, the bridge reads JanitorAI's Supabase session cookie internally and attaches its access token to same-origin Hampter requests. This unlocks Trending/Popular page 2+ without using Character Library's manual **JanitorAI Login (Hampter pagination)** cookie field. Neither the cookie nor token leaves the APK.

Transient Android WebView network rejections are retried twice with short backoff. If all three attempts fail during pagination, Character Library keeps the cards already loaded and rolls the page number back so **Load More** retries the same page.

## Background operation

The APK starts an Android foreground service and holds a partial wake lock while the bridge is active. Its persistent notification has a **Stop** action that closes the local server and removes the app task. Swiping the app away from Android's recent-apps screen also stops the service.

This substantially reduces background suspension, but Android System WebView or device-specific battery management can still reject an occasional request. The existing retries and page rollback handle those failures without skipping pagination.

## Diagnostics

- The APK shows the latest sanitized bridge event in its **Last request** line. If it remains `none yet`, Chrome did not reach the loopback server.
- Enable **Settings -> Developer -> Debug Mode** in Character Library to print `[AndroidBridge]` request IDs, origins, response codes, and network failures in the browser console.
- With Android platform tools installed, run `adb logcat -s CLBridge` for the APK's detailed lifecycle and request log.

Pairing keys, cookies, request bodies, search text, and JanitorAI response bodies are never logged.

## Prototype limitations

- The embedded WebView must remain on a `janitorai.com` page while Character Library requests data.
- WebView and Chrome have separate cookie stores, so login must happen inside the APK.
- Device-specific battery managers can still suspend a foreground service; the notification makes its state visible.
- Some Cloudflare configurations may still reject Android WebView.
- A debug signing key is generated for every local build, so install updates may require uninstalling the prior debug APK first.
