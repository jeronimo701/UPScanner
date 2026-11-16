package ru.upscanner.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import com.google.zxing.integration.android.IntentIntegrator;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

public final class MainActivity extends Activity {
    private static final int PICK = 11, EXPORT = 12;
    private static final String XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    private static final String XLS_TYPE = "application/vnd.ms-excel";
    private StateStore store;
    private FrameLayout root;
    private WebView web;
    private final java.util.ArrayList<String> pendingEvents = new java.util.ArrayList<>();
    private boolean ready;
    private int importBatches;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        PDFBoxResourceLoader.init(getApplicationContext());
        store = new StateStore(getFilesDir());
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(20, 33, 29));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(20, 33, 29));
        root.addView(web);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets safe = insets.getInsets(
                    android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(android.view.WindowInsets.Type.ime());
                v.setPadding(safe.left, safe.top, safe.right, Math.max(safe.bottom, ime.bottom));
                return insets;
            });
        }
        setContentView(root);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setBlockNetworkLoads(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public void onPageFinished(WebView view, String url) {
                ready = true;
                for (String script : pendingEvents) view.evaluateJavascript(script, null);
                pendingEvents.clear();
            }
        });
        web.addJavascriptInterface(new Bridge(), "Android");
        web.loadUrl("file:///android_asset/index.html");
        if (saved == null) receiveShare(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receiveShare(intent);
    }

    private void receiveShare(Intent intent) {
        if (intent == null || (!Intent.ACTION_SEND.equals(intent.getAction())
                && !Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))) return;
        var uris = new LinkedHashSet<Uri>();
        try {
            if (Intent.ACTION_SEND.equals(intent.getAction())) {
                if (intent.getParcelableExtra(Intent.EXTRA_STREAM) instanceof Uri uri) uris.add(uri);
            } else {
                var files = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (files != null) for (Object file : files) if (file instanceof Uri uri) uris.add(uri);
            }
            if (intent.getClipData() != null) {
                for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                    Uri uri = intent.getClipData().getItemAt(i).getUri();
                    if (uri != null) uris.add(uri);
                }
            }
        } catch (RuntimeException e) {
            emit("error", "Не удалось принять вложение");
            return;
        }
        uris.removeIf(uri -> !"content".equals(uri.getScheme()));
        if (uris.isEmpty()) {
            emit("error", "Передайте файл PDF, XLS или XLSX, а не ссылку или текст");
            return;
        }
        importDocuments(new ArrayList<>(uris));
    }

    private void emit(String event, String payload) {
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            String script = "window.receive(" + JSONObject.quote(event) + "," + JSONObject.quote(payload) + ")";
            if (ready) web.evaluateJavascript(script, null);
            else pendingEvents.add(script);
        });
    }

    final class Bridge {
        @JavascriptInterface public String loadState() { return store.read(); }

        @JavascriptInterface public boolean saveState(String data) { return store.write(data); }

        @JavascriptInterface public void setTheme(String theme) {
            runOnUiThread(() -> {
                int color = switch (theme) {
                    case "amoled" -> Color.BLACK;
                    case "dark" -> Color.rgb(16, 22, 20);
                    default -> Color.rgb(20, 33, 29);
                };
                root.setBackgroundColor(color);
                web.setBackgroundColor(color);
                getWindow().setStatusBarColor(color);
                getWindow().setNavigationBarColor(color);
            });
        }

        @JavascriptInterface public void scan() {
            runOnUiThread(() -> new IntentIntegrator(MainActivity.this)
                .setPrompt("Наведите камеру на штрихкод").setOrientationLocked(false)
                .setBeepEnabled(false).initiateScan());
        }

        @JavascriptInterface public void pick() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*");
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(intent, PICK);
            });
        }

        @JavascriptInterface public void exportCsv(String name, String content) {
            runOnUiThread(() -> {
                try (var out = openFileOutput("pending-export.csv", MODE_PRIVATE)) {
                    out.write(("\uFEFF" + content).getBytes(StandardCharsets.UTF_8));
                } catch (IOException e) {
                    emit("error", "Не удалось подготовить отчёт");
                    return;
                }
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("text/csv");
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_TITLE, name);
                startActivityForResult(intent, EXPORT);
            });
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        var scan = IntentIntegrator.parseActivityResult(request, result, data);
        if (scan != null) {
            if (scan.getContents() != null) emit("scan", scan.getContents());
            return;
        }
        if (request == EXPORT) {
            if (result != RESULT_OK || data == null) {
                deleteFile("pending-export.csv");
                return;
            }
            try (InputStream in = openFileInput("pending-export.csv");
                 OutputStream out = getContentResolver().openOutputStream(data.getData(), "wt")) {
                if (out == null) throw new IOException();
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) != -1;) out.write(buf, 0, n);
                emit("message", "Отчёт сохранён");
            } catch (IOException e) { emit("error", "Не удалось записать отчёт"); }
            finally { deleteFile("pending-export.csv"); }
            return;
        }
        if (request != PICK || result != RESULT_OK || data == null) return;
        var uris = new ArrayList<Uri>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                Uri uri = data.getClipData().getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        } else if (data.getData() != null) uris.add(data.getData());
        importDocuments(uris);
    }

    private void importDocuments(List<Uri> uris) {
        if (uris.isEmpty()) return;
        if (uris.size() > 30) {
            emit("error", "За один раз можно добавить до 30 документов");
            return;
        }
        if (importBatches++ == 0) emit("busy", "");
        worker.execute(() -> {
            try {
                for (Uri uri : uris) {
                    String name = "Документ";
                    try {
                        try (var cursor = getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)
                                    && !cursor.getString(0).trim().isEmpty()) name = cursor.getString(0).trim();
                        }
                        String lower = name.toLowerCase(Locale.ROOT);
                        if (!lower.endsWith(".pdf") && !lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
                            String type = getContentResolver().getType(uri);
                            if ("application/pdf".equals(type)) name += ".pdf";
                            if (XLSX_TYPE.equals(type)) name += ".xlsx";
                            if (XLS_TYPE.equals(type)) name += ".xls";
                            lower = name.toLowerCase(Locale.ROOT);
                        }
                        if (!lower.endsWith(".pdf") && !lower.endsWith(".xlsx") && !lower.endsWith(".xls")) throw new IOException("Поддерживаются PDF, XLS и XLSX");
                        try (InputStream in = getContentResolver().openInputStream(uri)) {
                            if (in == null) throw new IOException("Не удалось открыть файл");
                            if (lower.endsWith(".pdf")) {
                                emit("import", PdfInvoice.read(in, getCacheDir(), name).toString());
                            } else {
                                emit("import", Workbook.read(in, getCacheDir(), name).toString());
                            }
                        }
                    } catch (Exception e) { emit("error", name + ": " + (e.getMessage() == null ? "ошибка чтения" : e.getMessage())); }
                }
            } finally {
                runOnUiThread(() -> {
                    if (--importBatches == 0) emit("idle", "");
                });
            }
        });
    }

    @Override protected void onDestroy() {
        worker.shutdown();
        web.destroy();
        super.onDestroy();
    }
}
