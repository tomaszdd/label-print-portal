import base64
import io
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from flask import Flask, request, render_template_string, send_from_directory, jsonify
from PIL import Image

app = Flask(__name__)

PTOUCH = "/usr/local/bin/ptouch-print"
USB_ID = "04f9:202c"
MAX_ATTEMPTS = 3
DESIGNS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "designs.json")
HISTORY_MAX = 30
print_lock = threading.Lock()
designs_lock = threading.Lock()

# ptouch-print sometimes prints one of these and still exits 0 (a bug in the
# tool: print_img()'s return value isn't checked before reporting success) —
# treat their presence in stdout as a real failure regardless of exit code.
FAILURE_MARKERS = [
    "sendraster() failed",
    "interface claim error",
    "write error",
    "could not render",
    "failed to load image",
    "ptouch_finalize",
]

PAGE = """
<!doctype html>
<html>
<head>
<title>Label Print Portal</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: sans-serif; max-width: 480px; margin: 2em auto; padding: 0 1em; }
  h1 { font-size: 1.3em; }
  textarea { width: 100%; font-size: 1.1em; padding: 0.5em; box-sizing: border-box; }
  label { display: block; margin-top: 0.8em; font-size: 0.9em; }
  input[type=file] { margin-top: 0.3em; }
  button { margin-top: 1em; font-size: 1.1em; padding: 0.6em 1.5em; width: 100%; }
  .msg { margin-top: 1em; padding: 0.8em; border-radius: 6px; }
  .ok { background: #d4edda; color: #155724; }
  .warn { background: #fff3cd; color: #856404; }
  .err { background: #f8d7da; color: #721c24; white-space: pre-wrap; }
  hr { margin: 1.5em 0; border: none; border-top: 1px solid #ddd; }
  #spinner { display: none; margin-top: 1em; padding: 0.8em; border-radius: 6px;
             background: #e2e3e5; color: #383d41; text-align: center; }
</style>
</head>
<body>
<h1>&#127991;&#65039; Label Print Portal</h1>
<p><a href="/">&larr; Back to the label designer</a></p>
<form method="post" enctype="multipart/form-data" id="printForm">
  <label for="text">Label text (up to 4 lines, one per line)</label>
  <textarea name="text" id="text" rows="4" maxlength="200">{{ text or '' }}</textarea>

  <label for="align">Alignment</label>
  <select name="align" id="align">
    <option value="l" {{ 'selected' if align=='l' else '' }}>Left</option>
    <option value="c" {{ 'selected' if align=='c' else '' }}>Center</option>
    <option value="r" {{ 'selected' if align=='r' else '' }}>Right</option>
  </select>

  <hr>

  <label for="image">Or upload an image instead (auto-converted to black &amp; white and scaled to fit the tape)</label>
  <input type="file" name="image" id="image" accept="image/*">

  <hr>

  <label><input type="checkbox" name="cutmark" {{ 'checked' if cutmark else '' }}> Print cut mark</label>

  <button type="submit" id="printBtn">Print Label</button>
</form>
<div id="spinner">&#9203; Printing&hellip; <span id="elapsed">0s</span> (can take up to ~30s, retries automatically if the connection blips)</div>
{% if message %}
<div class="msg {{ status }}">{{ message }}</div>
{% endif %}
<script>
document.getElementById('printForm').addEventListener('submit', function() {
  document.getElementById('printBtn').disabled = true;
  document.getElementById('printBtn').textContent = 'Printing...';
  document.getElementById('spinner').style.display = 'block';
  var start = Date.now();
  setInterval(function() {
    document.getElementById('elapsed').textContent = Math.floor((Date.now() - start) / 1000) + 's';
  }, 1000);
});
</script>
</body>
</html>
"""


def usb_present():
    try:
        out = subprocess.run(
            ["lsusb"], capture_output=True, text=True, timeout=5
        ).stdout
        return USB_ID in out
    except Exception:
        return False


def wait_for_usb(tries=3, delay=1.5):
    for _ in range(tries):
        if usb_present():
            return True
        time.sleep(delay)
    return False


def get_tape_height_px():
    """Query the printer for the current tape's active print height in px."""
    info = subprocess.run(
        [PTOUCH, "--info"], capture_output=True, text=True, timeout=10
    )
    m = re.search(r"maximum printing width for this tape is (\d+)px", info.stdout)
    if m:
        return int(m.group(1))
    return None


def image_to_label_png(file_storage, height_px):
    """Convert an uploaded image to a scaled 2-color (black/white) PNG."""
    img = Image.open(file_storage.stream)
    img = img.convert("L")

    w, h = img.size
    new_w = max(1, int(w * (height_px / h)))
    img = img.resize((new_w, height_px), Image.LANCZOS)

    # Dithered 1-bit conversion (Floyd-Steinberg, PIL's default for convert('1'))
    img = img.convert("1")

    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False, dir="/tmp")
    img.save(tmp.name, "PNG")
    return tmp.name


def do_print(cmd):
    """Run one print attempt + a post-print status check. Returns (ok, detail)."""
    if not wait_for_usb():
        return False, "Printer not detected on USB before sending."

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    combined_output = result.stdout + result.stderr
    if result.returncode != 0:
        return False, "ptouch-print failed:\n" + combined_output

    for marker in FAILURE_MARKERS:
        if marker in combined_output:
            return False, (
                f"ptouch-print reported '{marker}' but still exited 0 (known "
                "tool quirk — this means the print genuinely failed, likely a "
                "mid-transfer USB drop):\n" + combined_output
            )

    # Verify the printer is still responsive right after — catches a
    # disconnect-during-transfer that the print command itself didn't error on.
    info = subprocess.run(
        [PTOUCH, "--info"], capture_output=True, text=True, timeout=10
    )
    if info.returncode != 0 or "error = 0x0000" not in info.stdout:
        return False, (
            "Print command reported success but the printer isn't responding "
            "normally right after — it may have dropped off USB mid-print "
            "(known issue: printer + WiFi share the Pi Zero W's power rail).\n"
            + result.stdout
        )

    return True, result.stdout


def run_with_retries(cmd):
    attempts_log = []
    ok = False
    detail = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        ok, detail = do_print(cmd)
        attempts_log.append(f"Attempt {attempt}: {'OK' if ok else 'failed'}")
        if ok:
            break
        time.sleep(2)
    return ok, detail, attempts_log


@app.route("/simple", methods=["GET", "POST"])
def simple():
    text = ""
    align = "c"
    cutmark = True
    message = None
    status = None

    if request.method == "POST":
        text = request.form.get("text", "")
        align = request.form.get("align", "c")
        cutmark = request.form.get("cutmark") == "on"
        image_file = request.files.get("image")
        has_image = image_file is not None and image_file.filename != ""

        lines = [line for line in text.split("\n") if line.strip() != ""][:4]

        if not has_image and not lines:
            message = "Enter some text or upload an image."
            status = "err"
        else:
            tmp_png = None
            try:
                if has_image:
                    what = f'image "{image_file.filename}"'
                    height_px = get_tape_height_px()
                    if not height_px:
                        message = "Could not read tape height from the printer — check it's connected."
                        status = "err"
                    else:
                        tmp_png = image_to_label_png(image_file, height_px)
                        cmd = [PTOUCH, f"--image={tmp_png}"]
                        if cutmark:
                            cmd.append("--cutmark")
                        ok, detail, attempts_log = run_with_retries(cmd)
                else:
                    what = "text: " + " / ".join(lines)
                    cmd = [PTOUCH]
                    for i, line in enumerate(lines):
                        flag = "--text" if i == 0 else "--newline"
                        cmd += [f"{flag}={line}"]
                    cmd += [f"--align={align}"]
                    if cutmark:
                        cmd.append("--cutmark")
                    ok, detail, attempts_log = run_with_retries(cmd)

                if message is None:
                    if ok:
                        status = "ok" if len(attempts_log) == 1 else "warn"
                        message = f"Printed {what}"
                        if len(attempts_log) > 1:
                            message += f" (took {len(attempts_log)} attempts — printer connection is flaky)"
                        message += ":\n" + detail
                    else:
                        status = "err"
                        message = f"Failed to print {what}, after retries:\n" + "\n".join(attempts_log) + "\n\n" + detail
            except subprocess.TimeoutExpired:
                message = "Timed out talking to the printer."
                status = "err"
            except FileNotFoundError:
                message = "ptouch-print binary not found."
                status = "err"
            except Exception as e:
                message = f"Error processing image: {e}"
                status = "err"
            finally:
                if tmp_png and os.path.exists(tmp_png):
                    os.remove(tmp_png)

    return render_template_string(
        PAGE, text=text, align=align, cutmark=cutmark, message=message, status=status
    )


# ---------------------------------------------------------------------------
# WYSIWYG designer: the browser renders the label as a 1-bit bitmap at the
# tape's exact dot height, so what's on screen is exactly what gets printed.
# ---------------------------------------------------------------------------

def get_tape_info():
    info = subprocess.run(
        [PTOUCH, "--info"], capture_output=True, text=True, timeout=10
    )
    out = info.stdout + info.stderr
    px = re.search(r"maximum printing width for this tape is (\d+)px", out)
    mm = re.search(r"media width = (\d+) mm", out)
    media = re.search(r"media type = 0x[0-9a-f]+ \(([^)]*)\)", out)
    err = re.search(r"error = (0x[0-9a-f]+)", out)
    return {
        "connected": px is not None,
        "height_px": int(px.group(1)) if px else None,
        "width_mm": int(mm.group(1)) if mm else None,
        "media": media.group(1) if media else None,
        "error": err.group(1) if err else None,
    }


def load_designs():
    try:
        with open(DESIGNS_FILE) as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError):
        data = {}
    data.setdefault("saved", [])
    data.setdefault("history", [])
    return data


def store_designs(data):
    tmp = DESIGNS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, DESIGNS_FILE)


@app.route("/")
def designer():
    return send_from_directory(app.static_folder, "editor.html")


@app.route("/api/tape")
def api_tape():
    if print_lock.locked():
        return jsonify({"busy": True}), 409
    try:
        return jsonify(get_tape_info())
    except Exception as e:
        return jsonify({"connected": False, "message": str(e)})


@app.route("/api/print", methods=["POST"])
def api_print():
    body = request.get_json(force=True)
    try:
        png = base64.b64decode(body["png"].split(",", 1)[-1])
        img = Image.open(io.BytesIO(png)).convert("L").point(lambda v: 255 if v >= 128 else 0).convert("1")
    except Exception as e:
        return jsonify({"ok": False, "message": f"Bad image from the designer: {e}"}), 400

    copies = max(1, min(20, int(body.get("copies", 1))))
    if not print_lock.acquire(blocking=False):
        return jsonify({"ok": False, "message": "Another label is printing, try again in a moment."}), 409
    tmp_png = None
    try:
        tape_px = get_tape_height_px()
        if not tape_px:
            return jsonify({"ok": False, "message": "Can't read the tape from the printer. Is it on and connected?"})
        if img.height != tape_px:
            return jsonify({"ok": False, "tape_px": tape_px, "message":
                f"The design is {img.height}px tall but the loaded tape prints {tape_px}px. The tape has changed, so re-check the preview and print again."})
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False, dir="/tmp")
        tmp_png = tmp.name
        img.save(tmp_png, "PNG")
        cmd = [PTOUCH, f"--image={tmp_png}"]
        if copies > 1:
            cmd.append(f"--copies={copies}")
        if body.get("cutmark"):
            cmd.append("--cutmark")
        ok, detail, attempts_log = run_with_retries(cmd)
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "message": "Timed out talking to the printer."})
    finally:
        print_lock.release()
        if tmp_png and os.path.exists(tmp_png):
            os.remove(tmp_png)

    if ok and body.get("design") is not None:
        with designs_lock:
            data = load_designs()
            data["history"].insert(0, {
                "id": uuid.uuid4().hex[:12], "ts": int(time.time()),
                "name": (body.get("name") or "Label")[:80],
                "design": body["design"], "thumb": body.get("thumb"),
                "copies": copies,
            })
            del data["history"][HISTORY_MAX:]
            store_designs(data)

    msg = "Printed" + (f" {copies} copies" if copies > 1 else "")
    if ok and len(attempts_log) > 1:
        msg += f" (took {len(attempts_log)} attempts, the printer connection is flaky)"
    return jsonify({"ok": ok, "attempts": len(attempts_log),
                    "message": msg if ok else "Print failed after retries:\n" + "\n".join(attempts_log) + "\n\n" + detail})


@app.route("/api/designs", methods=["GET", "POST"])
def api_designs():
    with designs_lock:
        data = load_designs()
        if request.method == "POST":
            body = request.get_json(force=True)
            entry = {"id": uuid.uuid4().hex[:12], "ts": int(time.time()),
                     "name": (body.get("name") or "Untitled")[:80],
                     "design": body["design"], "thumb": body.get("thumb")}
            data["saved"] = [d for d in data["saved"] if d["name"] != entry["name"]]
            data["saved"].insert(0, entry)
            store_designs(data)
    return jsonify(data)


@app.route("/api/designs/<kind>/<item_id>", methods=["DELETE"])
def api_design_delete(kind, item_id):
    if kind not in ("saved", "history"):
        return jsonify({"ok": False}), 404
    with designs_lock:
        data = load_designs()
        data[kind] = [d for d in data[kind] if d["id"] != item_id]
        store_designs(data)
    return jsonify(data)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050)
