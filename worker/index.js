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
  return raw.split(/[ ,\n\t]+/).filter(Boolean).includes(String(id));
}

function requestedHeight(text) {
  const match = String(text || "").match(/(?:^|\s)(240|360|480|540|720|1080|small)(?:\s|$)/i);
  return match ? match[1].toLowerCase() : "";
}

function findUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[),.!?]+$/, "") : "";
}

async function dispatch(env, eventType, payload) {
  return fetch("https://api.github.com/repos/" + env.REPO + "/dispatches", {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + env.GH_TOKEN,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tg-video-compressor-worker",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload })
  });
}

async function handleCallback(update, env) {
  const callback = update.callback_query;
  if (!callback) return false;
  if (!callback.from || !isAllowed(callback.from.id, env.ALLOWED_IDS)) return true;

  const match = String(callback.data || "").match(/^c:([-0-9]+):([0-9]+)$/);
  const callbackChatId = callback.message && callback.message.chat
    ? String(callback.message.chat.id) : "";
  if (!match || callbackChatId !== match[1]) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id, text: "درخواست لغو معتبر نیست."
    });
    return true;
  }

  const chatId = match[1];
  const messageId = match[2];
  const statusMessageId = String(callback.message.message_id);
  const response = await dispatch(env, "cancel", {
    chat_id: chatId,
    message_id: messageId,
    status_message_id: statusMessageId
  });

  if (!response.ok) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id, text: "ثبت لغو انجام نشد؛ دوباره تلاش کنید."
    });
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: statusMessageId,
      text: "⚠️ ثبت لغو درخواست انجام نشد. لطفاً کمی بعد دوباره تلاش کنید.",
      reply_markup: { inline_keyboard: [] }
    });
    return true;
  }

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id, text: "درخواست لغو ارسال شد."
  });
  await telegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: statusMessageId,
    text: "⏳ درخواست لغو ویدیو در حال انجام است…",
    reply_markup: { inline_keyboard: [] }
  });
  return true;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!env.WEBHOOK_SECRET || supplied !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

    let update;
    try { update = await request.json(); } catch { return json({ ok: false }, 400); }

    try {
      if (await handleCallback(update, env)) return json({ ok: true });

      const msg = update.message || update.edited_message;
      if (!msg || !msg.chat || !msg.from) return json({ ok: true });
      const chatId = msg.chat.id;
      if (!isAllowed(msg.from.id, env.ALLOWED_IDS)) return json({ ok: true });

      const text = msg.text || msg.caption || "";
      if (msg.text && /^\/start(?:@\w+)?(?:\s|$)/i.test(msg.text)) {
        await telegram(env, "sendMessage", { chat_id: chatId,
          text: "سلام! 🎬\nویدیو را ارسال کنید یا لینک مستقیم فایل را بفرستید.\n\nبرای تعیین ارتفاع، در متن یا کپشن بنویسید: 240، 360، 480، 540، 720، 1080 یا small.\n\nبرای لغو هر ویدیو از دکمه «لغو ویدیو» زیر پیام وضعیت همان درخواست استفاده کنید.\nبرای راهنما /help را بفرستید." });
        return json({ ok: true });
      }
      if (msg.text && /^\/help(?:@\w+)?(?:\s|$)/i.test(msg.text)) {
        await telegram(env, "sendMessage", { chat_id: chatId,
          text: "📘 راهنمای ربات فشرده‌ساز\n\n• ویدیو یا فایل ویدیویی را ارسال کنید.\n• لینک مستقیم ویدیو هم قابل قبول است.\n• برای انتخاب ارتفاع، یکی از این اعداد را در کپشن بنویسید: 240، 360، 480، 540، 720 یا 1080.\n• برای خروجی کوچک‌تر، small را بنویسید.\n• برای لغو، دکمه «❌ لغو ویدیو» زیر پیام وضعیت همان ویدیو را بزنید.\n• فقط درخواست‌های حساب‌های مجاز پردازش می‌شوند." });
        return json({ ok: true });
      }
      if (msg.text && /^\/cancel(?:@\w+)?(?:\s|$)/i.test(msg.text)) {
        await telegram(env, "sendMessage", { chat_id: chatId,
          text: "برای لغو، دکمه «❌ لغو ویدیو» زیر پیام وضعیت همان ویدیو را بزنید؛ هر درخواست دکمه جداگانه دارد." });
        return json({ ok: true });
      }

      const isVideo = Boolean(msg.video) || Boolean(msg.document && String(msg.document.mime_type || "").startsWith("video/"));
      const url = findUrl(text);
      if (!isVideo && !url) {
        await telegram(env, "sendMessage", { chat_id: chatId, text: "لطفاً یک ویدیو، فایل ویدیویی یا لینک مستقیم ویدیو ارسال کنید. برای راهنما /help را بفرستید." });
        return json({ ok: true });
      }

      const height = requestedHeight(text);
      const statusMessage = await telegram(env, "sendMessage", {
        chat_id: chatId,
        text: "در صف قرار گرفت ⏳\nپس از آماده‌شدن، ویدیوی فشرده‌شده همین‌جا ارسال می‌شود.",
        reply_markup: {
          inline_keyboard: [[{
            text: "❌ لغو ویدیو",
            callback_data: "c:" + String(chatId) + ":" + String(msg.message_id)
          }]]
        }
      });

      const payload = {
        chat_id: String(chatId),
        message_id: String(msg.message_id),
        status_message_id: String(statusMessage.message_id),
        url,
        height: height === "small" ? "" : height,
        small: height === "small" ? "1" : "0"
      };
      const response = await dispatch(env, "compress", payload);
      if (!response.ok) {
        console.error("GitHub dispatch failed:", response.status);
        await telegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: statusMessage.message_id,
          text: "❌ ثبت درخواست انجام نشد. لطفاً کمی بعد دوباره تلاش کنید.",
          reply_markup: { inline_keyboard: [] }
        });
      }
    } catch (error) {
      console.error("Webhook error:", String(error).slice(0, 250));
    }
    return json({ ok: true });
  }
};
