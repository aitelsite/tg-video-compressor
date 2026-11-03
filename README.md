# ربات فشرده‌سازی ویدیو تلگرام

معماری: Telegram → Cloudflare Worker (وب‌هوک و صف) → GitHub Actions (FFmpeg) → Telegram از طریق Pyrofork/MTProto.

## فایل‌ها
- `worker/index.js` و `worker/wrangler.toml`: وب‌هوک
- `compress.py`: دانلود، فشرده‌سازی و ارسال
- `.github/workflows/compress.yml`: اجرای job

## تنظیمات GitHub
در Settings → Secrets and variables → Actions این Repository Secrets را بسازید:
- `API_ID`
- `API_HASH`
- `BOT_TOKEN`

## تنظیمات Cloudflare Worker
Secrets:
- `BOT_TOKEN`
- `GH_TOKEN` (Fine-grained token فقط برای همین مخزن؛ Actions: Read and write)
- `WEBHOOK_SECRET`
- `ALLOWED_IDS` (شناسه عددی کاربران مجاز، جداشده با فاصله یا کاما؛ خالی یعنی همه)

Variable:
- `REPO=aitelsite/tg-video-compressor`

پس از استقرار Worker، وب‌هوک را با Telegram `setWebhook` ثبت کنید و `secret_token` را برابر `WEBHOOK_SECRET` قرار دهید. با `getWebhookInfo` وضعیت را بررسی کنید.

## استفاده
ویدیو را ارسال کنید یا لینک مستقیم بدهید. برای ارتفاع می‌توانید در کپشن/متن از `480`، `720`، `1080` یا `small` استفاده کنید.

## محدودیت‌ها
سهمیه و محدودیت‌های GitHub Actions و تلگرام برقرار است. رایگان یا نامحدود بودن پردازش فایل‌های حجیم تضمین نمی‌شود؛ فضای دیسک Runner و زمان اجرا محدود است و فایل‌های بزرگ ممکن است به دلیل کمبود فضا/زمان یا محدودیت‌های MTProto ارسال نشوند.

## امنیت
هیچ توکن یا کلید محرمانه‌ای را در کد، لاگ، commit یا README قرار ندهید. در صورت افشای کلید، آن را فوراً تعویض کنید.
