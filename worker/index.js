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

const DEFAULT_SETTINGS = { height: "720", mode: "normal" };

function modeLabel(mode) {
  return mode === "smaller" ? "کاهش حجم بیشتر"
    : mode === "quality" ? "حفظ کیفیت" : "معمولی";
}

async function getSettings(env, chatId) {
  const id = env.USER_SETTINGS.idFromName(String(chatId));
  const value = await env.USER_SETTINGS.get(id).readSettings();
  return {
    height: ["240", "360", "480", "540", "720", "1080"].includes(String(value?.height)) ? String(value.height) : DEFAULT_SETTINGS.height,
    mode: ["normal", "smaller", "quality"].includes(String(value?.mode)) ? value.mode : DEFAULT_SETTINGS.mode
  };
}

async function saveSettings(env, chatId, settings) {
  const id = env.USER_SETTINGS.idFromName(String(chatId));
  return env.USER_SETTINGS.get(id).writeSettings(settings);
}

function mainKeyboard(settings) {
  return { inline_keyboard: [
    [{ text: "🎚 انتخاب کیفیت خروجی (" + settings.height + ")", callback_data: "menu:quality" }],
    [{ text: "📦 حالت فشرده‌سازی (" + modeLabel(settings.mode) + ")", callback_data: "menu:mode" }],
    [{ text: "▶️ شروع", callback_data: "menu:start" }]
  ] };
}

function qualityKeyboard() {
  return { inline_keyboard: [
    [
      { text: "240", callback_data: "height:240" },
      { text: "360", callback_data: "height:360" },
      { text: "480", callback_data: "height:480" }
    ],
    [
      { text: "540", callback_data: "height:540" },
      { text: "720", callback_data: "height:720" },
      { text: "1080", callback_data: "height:1080" }
    ],
    [{ text: "↩️ بازگشت", callback_data: "menu:home" }]
  ] };
}

function modeKeyboard() {
  return { inline_keyboard: [
    [{ text: "⚖️ معمولی", callback_data: "mode:normal" }],
    [{ text: "📦 کاهش حجم بیشتر", callback_data: "mode:smaller" }],
    [{ text: "✨ حفظ کیفیت", callback_data: "mode:quality" }],
    [{ text: "↩️ بازگشت", callback_data: "menu:home" }]
  ] };
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

  const callbackChatId = callback.message && callback.message.chat
    ? String(callback.message.chat.id) : "";
  const statusMessageId = callback.message ? String(callback.message.message_id) : "";
  const data = String(callback.data || "");

  if (!callbackChatId || !statusMessageId) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id, text: "این دکمه معتبر نیست."
    });
    return true;
  }

  if (data.startsWith("c:")) {
    const match = data.match(/^c:([-0-9]+):([0-9]+)$/);
    if (!match || callbackChatId !== match[1]) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id, text: "درخواست لغو معتبر نیست."
      });
      return true;
    }

    const chatId = match[1];
    const messageId = match[2];
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

  const chatId = callbackChatId;
  const messageId = Number(statusMessageId);
  let settings;
  try {
    settings = await getSettings(env, chatId);
  } catch (error) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id, text: "دریافت تنظیمات ممکن نشد."
    });
    return true;
  }

  let text;
  let replyMarkup;
  if (data === "menu:quality") {
    text = "🎚 کیفیت خروجی را انتخاب کنید:";
    replyMarkup = qualityKeyboard();
  } else if (data === "menu:mode") {
    text = "📦 حالت فشرده‌سازی را انتخاب کنید:";
    replyMarkup = modeKeyboard();
  } else if (data === "menu:start" || data === "menu:home") {
    text = "سلام! 🎬\nویدیو را ارسال کنید یا لینک مستقیم فایل را بفرستید.\n\nتنظیمات فعلی: کیفیت " +
      settings.height + "p | حالت " + modeLabel(settings.mode) +
      "\n\nبرای راهنما /help را بفرستید.";
    replyMarkup = mainKeyboard(settings);
  } else if (/^height:(240|360|480|540|720|1080)$/.test(data)) {
    settings.height = data.split(":")[1];
    await saveSettings(env, chatId, settings);
    text = "✅ کیفیت خروجی روی " + settings.height + "p ذخیره شد.\nویدیوهای بعدی با این کیفیت پردازش می‌شوند.";
    replyMarkup = mainKeyboard(settings);
  } else if (/^mode:(normal|smaller|quality)$/.test(data)) {
    settings.mode = data.split(":")[1];
    await saveSettings(env, chatId, settings);
    text = "✅ حالت فشرده‌سازی روی «" + modeLabel(settings.mode) + "» ذخیره شد.";
    replyMarkup = mainKeyboard(settings);
  } else {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id, text: "گزینه ناشناخته است."
    });
    return true;
  }

  await telegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup
  });
  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id, text: "انجام شد."
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
        const settings = await getSettings(env, chatId);
        await telegram(env, "sendMessage", {
          chat_id: chatId,
          text: "سلام! 🎬\nویدیو را ارسال کنید یا لینک مستقیم فایل را بفرستید.\n\nتنظیمات فعلی: کیفیت " +
            settings.height + "p | حالت " + modeLabel(settings.mode) +
            "\n\nبرای راهنما /help را بفرستید.",
          reply_markup: mainKeyboard(settings)
        });
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

      const settings = await getSettings(env, chatId);
      const requested = requestedHeight(text);
      const height = requested === "small" ? "" : (requested || settings.height);
      const small = requested === "small" ? "1" : "0";
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
        height,
        small,
        mode: settings.mode
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
