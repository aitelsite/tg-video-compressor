const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8" }
});

async function telegram(env, method, body) {
  const response = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || "Telegram API error");
  return result.result;
}

function isAllowed(id, raw) {
  if (!raw || !raw.trim()) return true;
  return raw.split(/[ ,\\n\\t]+/).filter(Boolean).includes(String(id));
}

function requestedHeight(text) {
  const match = String(text || "").match(/(?:^|\\s)(240|360|480|540|720|1080|small)(?:\\s|$)/i);
  return match ? match[1].toLowerCase() : "";
}

function findUrl(text) {
  const match = String(text || "").match(/https?:\\/\\/[^\\s<>"']+/i);
  return match ? match[0].replace(/[),.!?]+$/, "") : "";
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!env.WEBHOOK_SECRET || supplied !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

    let update;
    try { update = await request.json(); } catch { return json({ ok: false }, 400); }
    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat || !msg.from) return json({ ok: true });

    const chatId = msg.chat.id;
    try {
      if (!isAllowed(msg.from.id, env.ALLOWED_IDS)) {
        await telegram(env, "sendMessage", { chat_id: chatId, text: "شما اجازه استفاده از این ربات را ندارید." });
        return json({ ok: true });
      }

      const text = msg.text || msg.caption || "";
      if (msg.text && /^\\/start(?:@\\w+)?(?:\\s|$)/i.test(msg.text)) {
        await telegram(env, "sendMessage", { chat_id: chatId,
          text: "سلام! 🎬\\nویدیو را ارسال کنید یا لینک مستقیم فایل را بفرستید.\\n\\nبرای تعیین ارتفاع، در متن یا کپشن بنویسید: 480، 720، 1080 یا small.\\n\\nدرخواست شما در صف پردازش قرار می‌گیرد و فایل نهایی همین‌جا ارسال می‌شود." });
        return json({ ok: true });
      }

      const isVideo = Boolean(msg.video) || Boolean(msg.document && String(msg.document.mime_type || "").startsWith("video/"));
      const url = findUrl(text);
      if (!isVideo && !url) {
        await telegram(env, "sendMessage", { chat_id: chatId, text: "لطفاً یک ویدیو، فایل ویدیویی یا لینک مستقیم ویدیو ارسال کنید." });
        return json({ ok: true });
      }

      const height = requestedHeight(text);
      const payload = {
        chat_id: String(chatId), message_id: String(msg.message_id),
        url, height: height === "small" ? "" : height,
        small: height === "small" ? "1" : "0"
      };
      const response = await fetch("https://api.github.com/repos/" + env.REPO + "/dispatches", {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": "Bearer " + env.GH_TOKEN,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "tg-video-compressor-worker",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ event_type: "compress", client_payload: payload })
      });
      if (!response.ok) {
        console.error("GitHub dispatch failed:", response.status);
        await telegram(env, "sendMessage", { chat_id: chatId, text: "ثبت درخواست انجام نشد. لطفاً کمی بعد دوباره تلاش کنید." });
        return json({ ok: true });
      }
      await telegram(env, "sendMessage", { chat_id: chatId, text: "در صف قرار گرفت ⏳\\nپس از آماده‌شدن، ویدیوی فشرده‌شده همین‌جا ارسال می‌شود." });
    } catch (error) {
      console.error("Webhook error:", String(error).slice(0, 250));
    }
    return json({ ok: true });
  }
};
