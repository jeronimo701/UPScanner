package ru.upscanner.mobile;

import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.text.PDFTextStripper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.regex.Pattern;

final class PdfInvoice {
    private static final int MAX_INPUT = 25 * 1024 * 1024;
    private static final Pattern ROW = Pattern.compile("^(\\d+)\\s+((?:[Уу][Пп]|[Uu][Pp])-\\d{8}|\\d{6,})(?:\\s+(.*))?$");
    private static final Pattern QTY = Pattern.compile("^(.+?)\\s+(\\d+(?:[,.]\\d+)?)\\s*шт\\.?(?=\\s|$)", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern STOP = Pattern.compile("^(?:итого|в том числе|всего наименований|товарно-материальные|сдал:|принял:)", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern HEADER = Pattern.compile("^(?:№\\s*)?код\\s+.*колич", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern SPACE = Pattern.compile("[\\s\\p{Zs}]+");

    static JSONObject read(InputStream input, File cache, String name) throws Exception {
        try (PDDocument pdf = PDDocument.load(new LimitedInput(input),
                MemoryUsageSetting.setupMixed(4 * 1024 * 1024L, 100 * 1024 * 1024L).setTempDir(cache))) {
            int pages = pdf.getNumberOfPages();
            if (pages > 250) throw new IOException("В PDF больше 250 страниц");
            PDFTextStripper stripper = new PDFTextStripper();
            stripper.setLineSeparator("\n");
            JSONArray items = new JSONArray();
            JSONArray warnings = new JSONArray();
            boolean hasText = false;
            String ref = "", code = "";
            StringBuilder description = new StringBuilder();
            for (int page = 1; page <= pages; page++) {
                stripper.setStartPage(page);
                stripper.setEndPage(page);
                String text = stripper.getText(pdf);
                if (text.length() > 500000) throw new IOException("Слишком много текста на странице PDF");
                hasText |= !text.trim().isEmpty();
                for (String raw : text.split("\\R")) {
                    String line = SPACE.matcher(raw).replaceAll(" ").trim();
                    if (line.isEmpty() || HEADER.matcher(line).find()) continue;
                    var matcher = ROW.matcher(line);
                    if (matcher.matches() || STOP.matcher(line).find()) {
                        if (!code.isEmpty()) add(items, warnings, ref, code, description.toString());
                        code = "";
                        description.setLength(0);
                        if (matcher.matches()) {
                            ref = matcher.group(1);
                            code = matcher.group(2).toUpperCase(Locale.ROOT).replaceFirst("^UP-", "УП-");
                            if (matcher.group(3) != null) description.append(matcher.group(3));
                        }
                    } else if (!code.isEmpty()) {
                        if (description.length() > 16000) throw new IOException("Слишком длинная строка накладной");
                        if (description.length() > 0) description.append(' ');
                        description.append(line);
                    }
                }
            }
            if (!code.isEmpty()) add(items, warnings, ref, code, description.toString());
            if (!hasText) throw new IOException("В PDF нет текстового слоя. Для скана сначала распознайте текст (OCR)");
            if (items.length() == 0) throw new IOException("В PDF не найдены строки накладной с номером и кодом");
            return new JSONObject().put("name", name).put("items", items).put("warnings", warnings);
        }
    }

    private static void add(JSONArray items, JSONArray warnings, String ref, String code, String text) throws Exception {
        if (items.length() >= 12000) throw new IOException("В PDF больше 12 000 позиций");
        var m = QTY.matcher(text);
        String name = text;
        double quantity = 1;
        if (m.find()) {
            name = m.group(1).trim();
            double parsed = Double.parseDouble(m.group(2).replace(',', '.'));
            if (Double.isFinite(parsed) && parsed > 0) quantity = parsed;
            else warnings.put(code + ": количество не распознано, подставлено 1");
        } else warnings.put(code + ": количество не распознано, подставлено 1");
        items.put(new JSONObject().put("code", code).put("qty", quantity).put("ref", ref).put("name", name).put("comment", ""));
    }

    private static final class LimitedInput extends FilterInputStream {
        private int remaining = MAX_INPUT;
        LimitedInput(InputStream source) { super(source); }
        private void charge(int n) throws IOException {
            if (n > 0 && (remaining -= n) < 0) throw new IOException("PDF больше 25 МБ");
        }
        @Override public int read() throws IOException {
            int value = in.read();
            if (value != -1) charge(1);
            return value;
        }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            int n = in.read(bytes, offset, length);
            charge(n);
            return n;
        }
    }
}
