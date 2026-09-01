#!/usr/bin/env python3
"""Assemble docs/index.html from the four source files in src/.

Keeping the CSS, the markup and the script apart makes them editable; the app
ships as one file so the page needs a single request.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
OUT = os.path.join(HERE, "docs", "index.html")

SHELL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Pre-sail float plan for Pier 66 on the Hudson. Live NOAA tide and current, live NWS wind.">
<style>*{{box-sizing:border-box}}body{{margin:0}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
{head}
</head>
<body>
{body}
<script>
{js}
</script>
</body>
</html>
"""


def read(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return f.read()


def main():
    html = SHELL.format(head=read("head.html"), body=read("body.html"),
                        js=read("model.js") + "\n" + read("app.js"))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"built {OUT} ({len(html)} bytes)")


if __name__ == "__main__":
    main()
