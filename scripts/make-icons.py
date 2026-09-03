#!/usr/bin/env python3
"""qsyy 图标生成管线:从矢量源一键产出三端全部图标。

源: docs/assets/icon-source.svg (优先 docs/assets/icon-source.png, 若存在则用它,
    方便以后直接替换原图高清版而不改管线)。

产物:
  PWA      app/standalone/public/icons/{favicon.svg,icon-32.png,icon-192.png,
           icon-512.png,maskable-512.png,apple-touch-icon.png}
  Desktop  desktop/assets/{icon.png(1024 master),icon.icns,icon.ico}
  Android  android/app/src/main/res/mipmap-*/{ic_launcher.png,
           ic_launcher_foreground.png} (+ 更新 ic_launcher.xml / colors.xml 由人执行,
           见下方打印的接线提示)

依赖: python3 + PIL(Pillow); SVG 光栅需要 resvg-py(pip install resvg-py),
      缺失时回退到 ImageMagick(magick, 质量较差仅应急)。
提交: 产物全部入库(构建机直接用,不重新生成)。
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_SVG = os.path.join(ROOT, "docs", "assets", "icon-source.svg")
SRC_PNG = os.path.join(ROOT, "docs", "assets", "icon-source.png")
BG = (11, 13, 19, 255)  # #0B0D13, 与 manifest theme_color 同系

try:
    from PIL import Image
except ImportError:
    sys.exit("需要 Pillow: pip3 install Pillow")


def load_master(px=1024):
    """返回 px*px 的 RGBA master 图。"""
    if os.path.exists(SRC_PNG):
        img = Image.open(SRC_PNG).convert("RGBA")
        return img.resize((px, px), Image.LANCZOS)
    try:
        from resvg_py import svg_to_bytes

        raw = svg_to_bytes(
            svg_string=open(SRC_SVG, encoding="utf-8").read(),
            width=px,
            height=px,
        )
        import io

        return Image.open(io.BytesIO(raw)).convert("RGBA")
    except ImportError:
        pass
    # 应急回退:ImageMagick 内置 SVG 渲染(渐变/描边可能失真,仅应急)
    print("!! 未找到 resvg-py, 回退 magick(质量可能差)", file=sys.stderr)
    out = "/tmp/qsyy-icon-master.png"
    subprocess.run(
        ["magick", "-background", "none", "-density", "384",
         SRC_SVG, "-resize", f"{px}x{px}", out],
        check=True,
    )
    return Image.open(out).convert("RGBA")


def save(img, *parts):
    p = os.path.join(ROOT, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)
    print("wrote", os.path.relpath(p, ROOT), img.size)


def centered(base, icon, scale):
    """把 icon 按 scale 缩放居中贴到 base 上。"""
    w = int(base.width * scale)
    h = int(base.height * scale)
    icon = icon.resize((w, h), Image.LANCZOS)
    base = base.copy()
    base.alpha_composite(icon, ((base.width - w) // 2, (base.height - h) // 2))
    return base


def solid(size, color=BG):
    return Image.new("RGBA", (size, size), color)


def main():
    master = load_master()

    # ---- PWA ----
    save(master.resize((32, 32), Image.LANCZOS),
         "app", "standalone", "public", "icons", "icon-32.png")
    save(master.resize((192, 192), Image.LANCZOS),
         "app", "standalone", "public", "icons", "icon-192.png")
    save(master.resize((512, 512), Image.LANCZOS),
         "app", "standalone", "public", "icons", "icon-512.png")
    # maskable: 安全区内(62%) + 深色底, 圆形裁剪不切到罐身
    save(centered(solid(512), master, 0.62),
         "app", "standalone", "public", "icons", "maskable-512.png")
    # iOS 不认透明: 深色底 + 88% 全 bleed
    save(centered(solid(180), master, 0.88),
         "app", "standalone", "public", "icons", "apple-touch-icon.png")
    fav = os.path.join(ROOT, "app", "standalone", "public", "icons", "favicon.svg")
    os.makedirs(os.path.dirname(fav), exist_ok=True)
    shutil.copyfile(SRC_SVG, fav)
    print("wrote", os.path.relpath(fav, ROOT))

    # ---- Desktop ----
    save(master, "desktop", "assets", "icon.png")
    try:
        master.save(os.path.join(ROOT, "desktop", "assets", "icon.ico"),
                    sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
        print("wrote desktop/assets/icon.ico")
    except Exception as e:  # noqa: BLE001
        print("!! icon.ico 失败:", e, file=sys.stderr)
    # .icns: iconset + iconutil(macOS 自带;其他平台跳过,CI mac job 可补)
    iconset = os.path.join(ROOT, "desktop", "assets", "icon.iconset")
    if shutil.which("iconutil"):
        sizes = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1),
                 (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]
        names = {16: "16x16", 32: "32x32", 128: "128x128",
                 256: "256x256", 512: "512x512"}
        os.makedirs(iconset, exist_ok=True)
        for base, retina in sizes:
            px = base * retina
            tag = names[base] + ("@2x" if retina == 2 else "")
            master.resize((px, px), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{tag}.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset,
                        "-o", os.path.join(ROOT, "desktop", "assets", "icon.icns")],
                       check=True)
        shutil.rmtree(iconset)
        print("wrote desktop/assets/icon.icns")
    else:
        print("!! 无 iconutil, 跳过 .icns(mac 上重跑本脚本即可)", file=sys.stderr)

    # ---- Android ----
    # legacy: 全 bleed; adaptive foreground: 60% 居中(进圆形安全区)
    densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96,
                 "xxhdpi": 144, "xxxhdpi": 192}
    fg_base = {"mdpi": 108, "hdpi": 162, "xhdpi": 216,
               "xxhdpi": 324, "xxxhdpi": 432}
    res = os.path.join(ROOT, "android", "app", "src", "main", "res")
    for d, px in densities.items():
        save(master.resize((px, px), Image.LANCZOS),
             "android", "app", "src", "main", "res",
             f"mipmap-{d}", "ic_launcher.png")
        fg = Image.new("RGBA", (fg_base[d], fg_base[d]), (0, 0, 0, 0))
        save(centered(fg, master, 0.60),
             "android", "app", "src", "main", "res",
             f"mipmap-{d}", "ic_launcher_foreground.png")
    # adaptive xml 改指 foreground 到 mipmap;删掉旧 vector drawable(重名冲突)。
    # 纯文本替换,保持原文件格式逐字节稳定。
    def sub(path, old, new):
        with open(path, encoding="utf-8") as f:
            text = f.read()
        assert old in text, f"pattern not found in {path}"
        with open(path, "w", encoding="utf-8") as f:
            f.write(text.replace(old, new))
        print("patched", os.path.relpath(path, ROOT))

    sub(os.path.join(res, "mipmap-anydpi-v26", "ic_launcher.xml"),
        '<foreground android:drawable="@drawable/ic_launcher_foreground" />',
        '<foreground android:drawable="@mipmap/ic_launcher_foreground" />')
    vec = os.path.join(res, "drawable", "ic_launcher_foreground.xml")
    if os.path.exists(vec):
        os.remove(vec)
        print("removed", os.path.relpath(vec, ROOT))
    sub(os.path.join(res, "values", "colors.xml"),
        '<color name="ic_launcher_background">#E8ECF3</color>',
        '<color name="ic_launcher_background">#0B0D13</color>')


if __name__ == "__main__":
    main()
