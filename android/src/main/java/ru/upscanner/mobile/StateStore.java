package ru.upscanner.mobile;

import android.util.AtomicFile;
import android.util.Log;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

final class StateStore {
    private static final int MAX_BYTES = 32 * 1024 * 1024;
    private final AtomicFile file;

    StateStore(File directory) {
        file = new AtomicFile(new File(directory, "scanner-state.json"));
    }

    synchronized String read() {
        try (var in = file.openRead()) {
            if (in.getChannel().size() > MAX_BYTES) throw new IOException("State file is too large");
            var out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) != -1;) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (FileNotFoundException e) {
            return file.getBaseFile().exists() ? "" : null;
        } catch (IOException e) {
            Log.e("UPScanner", "Cannot read state", e);
            return "";
        }
    }

    synchronized boolean write(String data) {
        if (data == null || data.isEmpty() || data.length() > MAX_BYTES) return false;
        byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) return false;
        FileOutputStream stream = null;
        try {
            stream = file.startWrite();
            stream.write(bytes);
            file.finishWrite(stream);
            return true;
        } catch (IOException e) {
            if (stream != null) file.failWrite(stream);
            Log.e("UPScanner", "Cannot save state", e);
            return false;
        }
    }
}
