import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from pyrogram import Client

MAX_INPUT = 4 * 1024**3
MAX_OUTPUT = 2 * 1024**3
CHAT = int(os.environ["CHAT"])
MSG = int(os.environ.get("MSG") or 0)
URL = os.environ.get("URL", "").strip()
HEIGHT = os.environ.get("HEIGHT", "").strip()
SMALL = os.environ.get("SMALL", "0") == "1"
BOT_TOKEN = os.environ["BOT_TOKEN"]
API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]


def run(args):
    subprocess.run(args, check=True)


def probe(path):
    result = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=width,height", "-of", "json", str(path)
    ], text=True, capture_output=True)
    if result.returncode != 0:
        detail = (result.stderr or "").strip()
        raise RuntimeError(
            "فایل دریافت‌شده ویدیوی معتبر نیست یا ناقص دانلود شده است."
            + (f" جزئیات: {detail[:300]}" if detail else "")
        )
    try:
        data = json.loads(result.stdout)
        stream = next(s for s in data.get("streams", []) if "width" in s)
        return max(1, int(float(data.get("format", {}).get("duration", 1)))), int(stream["width"]), int(stream["height"])
    except (ValueError, KeyError, StopIteration, TypeError):
        raise RuntimeError("فایل ورودی فاقد اطلاعات معتبر ویدیویی است.")


def download_url(url, target):
    if not url.startswith(("http://", "https://")):
        raise RuntimeError("لینک دانلود معتبر نیست.")

    # yt-dlp appends the real media extension; do not assume it wrote target.
    template = str(target) + ".%(ext)s"
    subprocess.run([
        sys.executable, "-m", "yt_dlp", "--no-playlist",
        "--max-filesize", str(MAX_INPUT), "-o", template, url
    ])
    candidates = sorted(
        (p for p in target.parent.glob(target.name + ".*")
         if p.is_file() and not p.name.endswith((".part", ".ytdl"))),
        key=lambda p: p.stat().st_size if p.exists() else 0,
        reverse=True
    )
    for candidate in candidates:
        if candidate.stat().st_size and candidate.stat().st_size <= MAX_INPUT:
            try:
                probe(candidate)
                return candidate
            except Exception:
                candidate.unlink(missing_ok=True)

    # Fallback is only for direct downloadable URLs.
    target.unlink(missing_ok=True)
    run(["curl", "-fL", "--retry", "2", "--connect-timeout", "20",
         "--max-time", "3600", "--max-filesize", str(MAX_INPUT),
         "-o", str(target), url])
    if not target.exists() or not target.stat().st_size:
        raise RuntimeError("دانلود ویدیو ناموفق بود.")
    if target.stat().st_size > MAX_INPUT:
        raise RuntimeError("حجم فایل از سقف تنظیم‌شده بیشتر است.")
    probe(target)
    return target


async def main():
    work = Path(tempfile.mkdtemp(prefix="tg-compress-"))
    source = work / "input_video"
    output = work / "compressed.mp4"
    app = Client("compress-session", api_id=API_ID, api_hash=API_HASH,
                 bot_token=BOT_TOKEN, in_memory=True)
    status = None
    last_progress = 0.0

    async def upload_progress(current, total):
        nonlocal last_progress
        now = time.monotonic()
        if status and (now - last_progress >= 5 or current >= total):
            last_progress = now
            try:
                pct = int(current * 100 / total) if total else 0
                await status.edit_text(f"در حال ارسال ویدیو… {pct}٪")
            except Exception:
                pass

    try:
        await app.start()
        status = await app.send_message(CHAT, "در حال آماده‌سازی ویدیو… ⏳")
        if URL:
            await status.edit_text("در حال دانلود ویدیو… ⬇️")
            source = download_url(URL, source)
        else:
            await status.edit_text("در حال دریافت ویدیو از تلگرام… ⬇️")
            message = await app.get_messages(CHAT, MSG)
            if not message:
                raise RuntimeError("پیام ویدیویی در تلگرام پیدا نشد.")

            media = message.video or message.document
            if not media or (message.document and not str(media.mime_type or "").startswith("video/")):
                raise RuntimeError("پیام انتخاب‌شده فایل ویدیویی ندارد.")

            expected_size = int(getattr(media, "file_size", 0) or 0)
            last_error = "دانلود ناقص بود."
            for attempt in range(1, 4):
                candidate = work / f"telegram_video_{attempt}"
                try:
                    downloaded = await app.download_media(
                        message, file_name=str(candidate)
                    )
                    if not downloaded:
                        raise RuntimeError("تلگرام فایلی برنگرداند.")
                    candidate_path = Path(downloaded)
                    if not candidate_path.exists() or not candidate_path.is_file():
                        raise RuntimeError("فایل دانلودشده در مسیر مورد انتظار وجود ندارد.")
                    actual_size = candidate_path.stat().st_size
                    if actual_size <= 0:
                        raise RuntimeError("فایل دانلودشده خالی است.")
                    if expected_size and actual_size != expected_size:
                        raise RuntimeError(
                            f"دانلود کامل نیست؛ اندازه دریافت‌شده {actual_size} از {expected_size} بایت است."
                        )
                    probe(candidate_path)
                    source = candidate_path
                    break
                except Exception as exc:
                    last_error = str(exc)
                    for partial in work.glob(candidate.name + "*"):
                        if partial.is_file():
                            partial.unlink(missing_ok=True)
                    if attempt == 3:
                        raise RuntimeError(
                            "دریافت کامل ویدیو از تلگرام پس از ۳ تلاش ناموفق بود. "
                            + last_error[:350]
                        )
                    await asyncio.sleep(attempt * 2)

        original_size = source.stat().st_size
        if not original_size:
            raise RuntimeError("فایل ویدیو خالی است.")
        if original_size > MAX_INPUT:
            raise RuntimeError("حجم ویدیو از سقف ۴ گیگابایت بیشتر است.")

        duration, _, _ = probe(source)
        target_height = int(HEIGHT) if HEIGHT.isdigit() else 720
        target_height = max(240, min(1080, target_height))
        small_mode = SMALL or HEIGHT.lower() == "small"
        vf = f"scale=-2:'min({target_height},ih)'"

        await status.edit_text("در حال فشرده‌سازی ویدیو… 🎞")
        run(["ffmpeg", "-y", "-i", str(source), "-map", "0:v:0", "-map", "0:a?",
             "-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
             "-vf", vf, "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
             str(output)])

        if small_mode or output.stat().st_size >= MAX_OUTPUT:
            output.unlink(missing_ok=True)
            total_bitrate = max(300_000, int((MAX_OUTPUT * 8 * 0.85) / duration))
            video_bitrate = max(180_000, total_bitrate - 96_000)
            run(["ffmpeg", "-y", "-i", str(source), "-map", "0:v:0", "-map", "0:a?",
                 "-c:v", "libx264", "-b:v", str(video_bitrate),
                 "-maxrate", str(video_bitrate), "-bufsize", str(video_bitrate * 2),
                 "-preset", "veryfast", "-vf", vf, "-c:a", "aac", "-b:a", "96k",
                 "-movflags", "+faststart", str(output)])

        if not output.exists() or not output.stat().st_size:
            raise RuntimeError("خروجی فشرده‌سازی ساخته نشد.")
        compressed_size = output.stat().st_size
        if compressed_size >= MAX_OUTPUT:
            raise RuntimeError("حجم خروجی هنوز برای ارسال بیش از حد مجاز است؛ ارتفاع کمتر یا حالت small را امتحان کنید.")

        out_duration, out_width, out_height = probe(output)
        reduction = max(0, round((1 - compressed_size / original_size) * 100))
        caption = (
            "✅ فشرده‌سازی انجام شد\n"
            f"حجم اولیه: {original_size / 1024**2:.1f} مگابایت\n"
            f"حجم نهایی: {compressed_size / 1024**2:.1f} مگابایت\n"
            f"کاهش حجم: {reduction}٪"
        )
        await status.edit_text("در حال ارسال ویدیوی فشرده‌شده… ⬆️")
        await app.send_video(CHAT, str(output), caption=caption,
                             duration=out_duration, width=out_width,
                             height=out_height, supports_streaming=True,
                             progress=upload_progress)
        try:
            await status.delete()
        except Exception:
            pass
    except Exception as exc:
        detail = str(exc).replace(BOT_TOKEN, "[مخفی]")
        print("Processing failed:", detail[:500])
        if status:
            try:
                await status.edit_text("❌ پردازش انجام نشد.\n" + detail[:700])
            except Exception:
                pass
        raise
    finally:
        try:
            await app.stop()
        except Exception:
            pass
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
