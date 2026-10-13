package com.shiaho777.qsyy;

import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import org.json.JSONObject;

/**
 * Looks for the 汽水 app the same way the desktop shell looks for SodaMusic
 * under the current OS user. On Android that "user" is a different Linux UID
 * per app, so this mostly reports installed-but-unreadable and copies a
 * Cookies file only when the OS actually lets us read it (shared storage or
 * a folder the user picked).
 */
final class SodaProbe {
    static final String PACKAGE = "com.luna.music";
    private static final String[] COOKIE_NAMES = {
        "Cookies", "cookies", "Cookies.db", "cookies.db"
    };

    private SodaProbe() {}

    static boolean installed(Context context) {
        try {
            context.getPackageManager().getPackageInfo(PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException error) {
            return false;
        }
    }

    static File importedCookiesFile(Context context) {
        File dir = new File(context.getFilesDir(), "soda-import");
        return new File(dir, "Cookies");
    }

    static File dataDir() {
        File[] roots = {
            Environment.getExternalStorageDirectory(),
            new File("/storage/emulated/0"),
            new File("/sdcard"),
        };
        File fallback = new File("/storage/emulated/0/Android/data/" + PACKAGE);
        for (File root : roots) {
            if (root == null) continue;
            File dir = new File(new File(new File(root, "Android"), "data"), PACKAGE);
            if (dir.exists()) return dir;
        }
        return fallback;
    }

    static boolean readable(File dir) {
        if (dir == null || !dir.isDirectory()) return false;
        return dir.list() != null;
    }

    static File privateDataDir(Context context) {
        try {
            Context other = context.createPackageContext(PACKAGE, Context.CONTEXT_IGNORE_SECURITY);
            if (Build.VERSION.SDK_INT >= 24) return other.getDataDir();
        } catch (PackageManager.NameNotFoundException ignored) {
        }
        return new File("/data/data/" + PACKAGE);
    }

    static boolean copyFile(File src, File dest) {
        if (src == null || !src.isFile()) return false;
        File parent = dest.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return false;
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dest)) {
            transfer(in, out);
            return dest.isFile() && dest.length() > 0;
        } catch (IOException error) {
            return false;
        }
    }

    static boolean importFromReadableRoots(Context context) {
        File dest = importedCookiesFile(context);
        File shared = dataDir();
        File priv = privateDataDir(context);
        File[] roots = { shared, priv };
        for (File root : roots) {
            if (!readable(root)) continue;
            File hit = findCookiesFile(root, 0);
            if (hit != null && copyFile(hit, dest)) return true;
        }
        return dest.isFile() && dest.length() > 0;
    }

    static File findCookiesFile(File dir, int depth) {
        if (dir == null || depth > 5) return null;
        File[] children = dir.listFiles();
        if (children == null) return null;
        for (File child : children) {
            if (child.isFile() && isCookiesName(child.getName())) return child;
        }
        for (File child : children) {
            if (!child.isDirectory()) continue;
            File hit = findCookiesFile(child, depth + 1);
            if (hit != null) return hit;
        }
        return null;
    }

    static boolean isCookiesName(String name) {
        if (name == null) return false;
        for (String candidate : COOKIE_NAMES) {
            if (candidate.equalsIgnoreCase(name)) return true;
        }
        return false;
    }

    static boolean importFromTree(Context context, Uri tree) {
        if (tree == null) return false;
        File dest = importedCookiesFile(context);
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(
                tree, DocumentsContract.getTreeDocumentId(tree));
        return walkTree(context, tree, doc, dest, 0);
    }

    private static boolean walkTree(Context context, Uri tree, Uri doc, File dest, int depth) {
        if (depth > 5) return false;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
                tree, DocumentsContract.getDocumentId(doc));
        try (Cursor cursor = context.getContentResolver().query(
                children,
                new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                },
                null, null, null)) {
            if (cursor == null) return false;
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                Uri child = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                boolean isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);
                if (!isDir && isCookiesName(name)) {
                    return copyUri(context, child, dest);
                }
                if (isDir && walkTree(context, tree, child, dest, depth + 1)) return true;
            }
        } catch (RuntimeException ignored) {
        }
        return dest.isFile() && dest.length() > 0;
    }

    private static boolean copyUri(Context context, Uri src, File dest) {
        File parent = dest.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return false;
        try (InputStream in = context.getContentResolver().openInputStream(src);
             OutputStream out = new FileOutputStream(dest)) {
            if (in == null) return false;
            transfer(in, out);
            return dest.isFile() && dest.length() > 0;
        } catch (IOException error) {
            return false;
        }
    }

    private static void transfer(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[65536];
        int read;
        while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
    }

    static String statusJson(Context context) {
        JSONObject json = new JSONObject();
        try {
            boolean haveApp = installed(context);
            File shared = dataDir();
            File priv = privateDataDir(context);
            boolean sharedReadable = readable(shared);
            boolean privateReadable = readable(priv);
            importFromReadableRoots(context);
            File imported = importedCookiesFile(context);
            json.put("installed", haveApp);
            json.put("found", shared.exists() || (priv != null && priv.exists()));
            json.put("readable", sharedReadable || privateReadable);
            json.put("imported", imported.isFile() && imported.length() > 0);
            json.put("path", shared.getAbsolutePath());
            json.put("privatePath", priv == null ? "" : priv.getAbsolutePath());
            if (!haveApp) json.put("reason", "soda-missing");
            else if (imported.isFile() && imported.length() > 0) json.put("reason", "imported");
            else if (sharedReadable || privateReadable) json.put("reason", "readable");
            else json.put("reason", "uid-sandbox");
        } catch (Exception ignored) {}
        return json.toString();
    }
}
