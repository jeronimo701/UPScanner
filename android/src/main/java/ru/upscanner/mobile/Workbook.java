package ru.upscanner.mobile;

import android.util.Xml;
import org.json.*;
import org.xmlpull.v1.XmlPullParser;
import java.io.*;
import java.math.BigDecimal;
import java.util.*;
import java.util.zip.*;

final class Workbook {
    private static final int MAX_FILE = 25 * 1024 * 1024;
    private static final int MAX_XML = 20 * 1024 * 1024;
    private static final int MAX_ROWS = 12000;
    private record Merged(int row, int left, int right) {}

    static JSONObject read(InputStream input, File cache, String name) throws Exception {
        boolean legacy = name.toLowerCase(Locale.ROOT).endsWith(".xls");
        File file = File.createTempFile("act-", legacy ? ".xls" : ".xlsx", cache);
        try {
            try (OutputStream out = new FileOutputStream(file)) {
                byte[] buf = new byte[16384];
                int count = 0;
                for (int n; (n = input.read(buf)) != -1;) {
                    count += n;
                    if (count > MAX_FILE) throw new IOException("Файл больше 25 МБ");
                    out.write(buf, 0, n);
                }
            }
            if (legacy) return document(name, readLegacy(file));
            try (ZipFile zip = new ZipFile(file)) {
                List<String> strings = new ArrayList<>();
                if (zip.getEntry("xl/sharedStrings.xml") != null) {
                    try (var in = open(zip, "xl/sharedStrings.xml")) {
                        var x = parser(in);
                        while (next(x)) if (start(x, "si")) strings.add(elementText(x, "t"));
                    }
                }
                Map<String, String> links = new HashMap<>();
                try (var in = open(zip, "xl/_rels/workbook.xml.rels")) {
                    var x = parser(in);
                    while (next(x)) if (start(x, "Relationship")) {
                        String target = attr(x, "Target");
                        if (target.startsWith("/")) target = target.substring(1);
                        else target = "xl/" + target;
                        if (!target.contains("..") && target.startsWith("xl/worksheets/")) links.put(attr(x, "Id"), target);
                    }
                }
                JSONArray items = new JSONArray();
                try (var in = open(zip, "xl/workbook.xml")) {
                    var x = parser(in);
                    int sheets = 0;
                    while (next(x)) if (start(x, "sheet")) {
                        String path = links.get(attr(x, "id"));
                        if (path == null) continue;
                        if (++sheets > 40) throw new IOException("В книге больше 40 листов");
                        try (var sheet = open(zip, path)) { readSheet(sheet, strings, attr(x, "name"), items); }
                    }
                }
                return document(name, items);
            }
        } finally { file.delete(); }
    }

    private static JSONObject document(String name, JSONArray items) throws Exception {
        if (items.length() == 0) throw new IOException("Нет строк с кодом и положительным количеством");
        return new JSONObject().put("name", name).put("items", items);
    }

    private static JSONArray readLegacy(File file) throws Exception {
        var settings = new jxl.WorkbookSettings();
        settings.setSuppressWarnings(true);
        var workbook = jxl.Workbook.getWorkbook(file, settings);
        try {
            if (workbook.getNumberOfSheets() > 40) throw new IOException("В книге больше 40 листов");
            var items = new JSONArray();
            for (var sheet : workbook.getSheets()) {
                if (sheet.getRows() > MAX_ROWS) throw new IOException("На листе больше 12 000 строк");
                var rows = new TreeMap<Integer, TreeMap<Integer, String>>();
                for (int r = 0; r < sheet.getRows(); r++) {
                    var cells = new TreeMap<Integer, String>();
                    for (var cell : sheet.getRow(r)) {
                        String value = cell instanceof jxl.NumberCell number
                            ? BigDecimal.valueOf(number.getValue()).stripTrailingZeros().toPlainString()
                            : cell.getContents().trim();
                        if (!value.isEmpty()) cells.put(cell.getColumn() + 1, value);
                    }
                    if (!cells.isEmpty()) rows.put(r + 1, cells);
                }
                var merges = new ArrayList<Merged>();
                for (var range : sheet.getMergedCells()) {
                    var left = range.getTopLeft();
                    merges.add(new Merged(left.getRow() + 1, left.getColumn() + 1, range.getBottomRight().getColumn() + 1));
                }
                collectRows(rows, merges, sheet.getName(), items);
            }
            return items;
        } finally { workbook.close(); }
    }

    private static InputStream open(ZipFile zip, String path) throws IOException {
        ZipEntry entry = zip.getEntry(path);
        if (entry == null || entry.getSize() < 0 || entry.getSize() > MAX_XML) throw new IOException("Некорректная структура XLSX или слишком большой лист");
        return new FilterInputStream(zip.getInputStream(entry)) {
            int remaining = MAX_XML;
            private void charge(int n) throws IOException {
                if (n > 0 && (remaining -= n) < 0) throw new IOException("Слишком большой лист");
            }
            @Override public int read() throws IOException { int n = super.read(); if (n >= 0) charge(1); return n; }
            @Override public int read(byte[] b, int off, int len) throws IOException { int n = super.read(b, off, len); charge(n); return n; }
        };
    }

    private static XmlPullParser parser(InputStream in) throws Exception {
        var parser = Xml.newPullParser();
        parser.setInput(in, null);
        return parser;
    }

    private static boolean next(XmlPullParser x) throws Exception {
        int event = x.nextToken();
        if (event == XmlPullParser.DOCDECL) throw new IOException("DTD не поддерживается");
        return event != XmlPullParser.END_DOCUMENT;
    }

    private static boolean start(XmlPullParser x, String tag) throws Exception {
        return x.getEventType() == XmlPullParser.START_TAG && tag.equals(x.getName());
    }

    private static String attr(XmlPullParser x, String name) {
        for (int i = 0; i < x.getAttributeCount(); i++) if (name.equals(x.getAttributeName(i))) return x.getAttributeValue(i);
        return "";
    }

    private static String elementText(XmlPullParser x, String tag) throws Exception {
        int depth = x.getDepth();
        StringBuilder value = new StringBuilder();
        while (next(x) && x.getDepth() > depth) {
            if (start(x, tag)) value.append(x.nextText());
        }
        return value.toString();
    }

    private static int column(String address) {
        int result = 0;
        for (int i = 0; i < address.length(); i++) {
            char c = address.charAt(i);
            if (c < 'A' || c > 'Z') break;
            result = result * 26 + c - 'A' + 1;
            if (result > 16384) return 0;
        }
        return result;
    }

    private static int row(String address, int fallback) {
        try { return Integer.parseInt(address.replaceFirst("^[A-Z]*", "")); }
        catch (NumberFormatException e) { return fallback; }
    }

    private static void readSheet(InputStream in, List<String> strings, String sheet, JSONArray items) throws Exception {
        var x = parser(in);
        var rows = new TreeMap<Integer, TreeMap<Integer, String>>();
        var merges = new ArrayList<Merged>();
        TreeMap<Integer, String> cells = null;
        int rowNumber = 0, col = 0;
        while (next(x)) {
            if (start(x, "row")) {
                if (rows.size() >= MAX_ROWS) throw new IOException("На листе больше 12 000 строк");
                rowNumber = row(attr(x, "r"), rowNumber + 1);
                cells = new TreeMap<>();
                rows.put(rowNumber, cells);
                col = 0;
            } else if (start(x, "mergeCell")) {
                String[] ends = attr(x, "ref").split(":");
                if (ends.length == 2) merges.add(new Merged(row(ends[0], 0), column(ends[0]), column(ends[1])));
            }
            else if (cells != null && start(x, "c")) {
                int n = column(attr(x, "r"));
                col = n == 0 ? col + 1 : n;
                String type = attr(x, "t");
                String value = elementText(x, "inlineStr".equals(type) ? "t" : "v").trim();
                if (type.equals("s") && !value.isEmpty()) value = strings.get(Integer.parseInt(value)).trim();
                if (!value.isEmpty()) cells.put(col, value);
            }
        }

        collectRows(rows, merges, sheet, items);
    }

    private static void collectRows(TreeMap<Integer, TreeMap<Integer, String>> rows, List<Merged> merges,
                                    String sheet, JSONArray items) throws Exception {
        int[] fields = new int[4];
        int header = 0;
        for (int r = 1; r <= 30; r++) {
            Arrays.fill(fields, 0);
            for (var nearby : rows.subMap(Math.max(1, r - 1), true, r + 1, true).values()) {
                nearby.forEach((c, v) -> {
                    String k = v.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim();
                    if (k.equals("код") || k.startsWith("код товар") || k.startsWith("артикул") || k.equals("штрихкод")) fields[0] = c;
                    else if (k.startsWith("наимен") || k.equals("товар") || k.equals("оборудование")) fields[1] = c;
                    else if (k.contains("колич") || k.startsWith("кол-во") || k.equals("qty")) fields[2] = c;
                    else if (k.startsWith("комментар") || k.startsWith("примеч")) fields[3] = c;
                });
            }
            if (fields[0] > 0 && fields[2] > 0) { header = r; break; }
        }
        if (header == 0) return;
        for (int i = 0; i < fields.length; i++) {
            int field = fields[i];
            if (field == 0) continue;
            for (Merged range : merges) {
                if (range.left() != field || range.row() < header - 1 || range.row() > header + 1) continue;
                int score = 0;
                for (int c = field; c <= range.right(); c++) {
                    final int candidate = c;
                    int hits = (int) rows.subMap(header, false, header + 20, true).values().stream().filter(cellsInRow -> cellsInRow.containsKey(candidate)).count();
                    if (hits > score) { score = hits; fields[i] = c; }
                }
                break;
            }
        }
        for (var entry : rows.tailMap(header, false).entrySet()) {
            var cellsInRow = entry.getValue();
            String code = cellsInRow.getOrDefault(fields[0], "").toUpperCase(Locale.ROOT)
                .replaceFirst("^UP-", "УП-").replaceFirst("(?<=\\d)\\.0+$", "");
            if (!code.matches("(?:УП-\\d{8}|\\d{6,})")) continue;
            double qty;
            try { qty = new BigDecimal(cellsInRow.getOrDefault(fields[2], "").replace(" ", "").replace("\u00a0", "").replace(',', '.')).doubleValue(); }
            catch (NumberFormatException e) { continue; }
            if (!Double.isFinite(qty) || qty <= 0) continue;
            if (items.length() >= MAX_ROWS) throw new IOException("В книге больше 12 000 позиций");
            String ref = sheet + "!" + entry.getKey();
            int refColumn = 0;
            for (var left : cellsInRow.headMap(fields[0], false).descendingMap().entrySet()) {
                if (left.getValue().matches("\\d+")) {
                    ref = left.getValue();
                    refColumn = left.getKey();
                    break;
                }
            }
            String comment = fields[3] == refColumn ? "" : cellsInRow.getOrDefault(fields[3], "");
            items.put(new JSONObject().put("code", code).put("qty", qty).put("ref", ref)
                .put("name", cellsInRow.getOrDefault(fields[1], "")).put("comment", comment));
        }
    }
}
