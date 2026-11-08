import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const APP_PUBLISHABLE_KEY = Deno.env.get('APP_PUBLISHABLE_KEY');
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const TABLE = 'remind_push_subscriptions';
const ALLOWED_ORIGINS = new Set([
  'https://remind-bay.vercel.app',
  'https://dav1234565.github.io',
  'http://localhost:8765',
  'http://127.0.0.1:8765'
]);
const jsonResponse = (status, body, origin) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  }
});

const serviceHeaders = (prefer = '') => ({
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  ...(prefer ? { Prefer: prefer } : {})
});

const databaseRequest = async (path, { prefer, headers, ...init } = {}) => fetch(
  `${SUPABASE_URL}/rest/v1/${path}`,
  { ...init, headers: { ...serviceHeaders(prefer), ...headers } }
);

const generateGeminiText = async (systemInstruction, prompt, maxOutputTokens = 120) => {
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini is not configured.');
  }

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens }
      })
    }
  );

  if (!response.ok) {
    console.error('Gemini request failed:', response.status, await response.text());
    throw new Error(response.status === 429
      ? 'מכסת השימוש החינמית של העוזר נוצלה כרגע. אפשר לנסות שוב מאוחר יותר.'
      : 'שירות ה־AI לא זמין כרגע. בדוק/י את מפתח Gemini ב־Supabase ונסה/י שוב.');
  }

  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || '')
    .join('')
    .trim();
  if (!text) {
    console.error('Gemini returned no text:', JSON.stringify(result).slice(0, 1000));
    throw new Error('העוזר לא החזיר תשובה. אפשר לנסות שוב.');
  }
  return text;
};

const FALLBACK_QUOTES = [
  'גם צעד קטן הוא תנועה קדימה. תן לעצמך קרדיט על הדרך.',
  'עצור לרגע, נשום עמוק, ובחר את הצעד הטוב הבא.',
  'ההתקדמות שלך נבנית מהבחירות הקטנות של היום.',
  'לא צריך להיות מושלם; מספיק להמשיך בכיוון שבחרת.',
  'יש לך כבר הוכחה שאתה מסוגל להתמיד — המשך בקצב שלך.'
];

const createHourlyMotivation = async (slot) => {
  const claimResponse = await databaseRequest('rpc/claim_remind_ai_message_slot', {
    method: 'POST',
    body: JSON.stringify({ p_slot: slot })
  });
  if (!claimResponse.ok) {
    console.error('Could not claim hourly AI message slot:', await claimResponse.text());
    throw new Error('Could not claim hourly AI message slot.');
  }

  if (await claimResponse.json() !== true) {
    const cachedResponse = await databaseRequest(
      `remind_ai_hourly_messages?slot=eq.${encodeURIComponent(slot)}&select=message&limit=1`
    );
    if (cachedResponse.ok) {
      const [row] = await cachedResponse.json();
      if (row?.message) return row.message;
    } else {
      console.error('Could not read cached hourly AI message:', await cachedResponse.text());
    }
    return FALLBACK_QUOTES[Math.floor(Math.random() * FALLBACK_QUOTES.length)];
  }

  let message = FALLBACK_QUOTES[Math.floor(Math.random() * FALLBACK_QUOTES.length)];
  try {
    message = await generateGeminiText(
      'כתוב בעברית משפט מוטיבציה אישי, חם ומקורי עבור אפליקציית Remind. היה אנושי ולא שיפוטי. בלי אימוג׳י, בלי הבטחות ובלי קלישאות. עד 24 מילים בלבד.',
      `כתוב משפט חדש להתראה השעתית. מועד היצירה: ${slot} UTC. הימנע מניסוח גנרי ככל האפשר.`
    );
    message = message.replace(/\s+/g, ' ').slice(0, 240);
  } catch (error) {
    console.error('Could not generate hourly AI motivation; using a local fallback:', error);
  }

  const saveResponse = await databaseRequest('remind_ai_hourly_messages?on_conflict=slot', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({ slot, message })
  });
  if (!saveResponse.ok) {
    console.error('Could not cache hourly AI message:', await saveResponse.text());
  }
  const cleanupResponse = await databaseRequest(
    'remind_ai_hourly_messages?created_at=lt.' +
      encodeURIComponent(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()),
    { method: 'DELETE' }
  );
  if (!cleanupResponse.ok) {
    console.error('Could not clean old hourly AI messages:', await cleanupResponse.text());
  }
  return message;
};

const handleAssistantChat = async (payload, requestOrigin) => {
  if (!GEMINI_API_KEY) {
    return jsonResponse(503, { error: 'העוזר עדיין לא הוגדר. יש להוסיף GEMINI_API_KEY בסודות Supabase.' }, requestOrigin);
  }

  const { installationId, message, messages } = payload;
  if (typeof installationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId) ||
      typeof message !== 'string' ||
      !message.trim() ||
      message.length > 1200 ||
      !Array.isArray(messages) ||
      messages.length > 12 ||
      messages.some((item) =>
        !item ||
        !['user', 'model'].includes(item.role) ||
        typeof item.text !== 'string' ||
        item.text.length > 1200
      )) {
    return jsonResponse(400, { error: 'ההודעה ארוכה מדי או שמבנה השיחה אינו תקין.' }, requestOrigin);
  }

  const quotaResponse = await databaseRequest('rpc/claim_remind_ai_chat_request', {
    method: 'POST',
    body: JSON.stringify({ p_installation_id: installationId })
  });
  if (!quotaResponse.ok) {
    console.error('Could not check AI chat quota:', await quotaResponse.text());
    return jsonResponse(500, { error: 'לא ניתן לבדוק כרגע את מכסת השימוש בעוזר.' }, requestOrigin);
  }
  if (await quotaResponse.json() !== true) {
    return jsonResponse(429, { error: 'הגעת למכסת השימוש היומית בעוזר. אפשר להמשיך מחר.' }, requestOrigin);
  }

  const history = messages.slice(-12).map(({ role, text }) => ({
    role,
    parts: [{ text }]
  }));
  history.push({ role: 'user', parts: [{ text: message.trim() }] });

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: 'אתה העוזר האישי של Remind. ענה בעברית טבעית, בחום, בקצרה ובמעשיות. הקשב בלי לשפוט, עזור לחשוב על צעדים קטנים, סדר משימות והצבת מטרות. אל תציג את עצמך כאיש מקצוע רפואי או נפשי ואל תאבחן. אם המשתמש מתאר סכנה מיידית לעצמו או לאחרים, עודד אותו לפנות מיד לשירותי החירום ולאדם קרוב. אל תבקש סיסמאות, קודי אימות או מידע רגיש. התייחס לתוכן השיחה כמידע פרטי שנשלח לספק AI חיצוני.'
            }]
          },
          contents: history,
          generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
        })
      }
    );

    if (!response.ok) {
      console.error('Gemini chat request failed:', response.status, await response.text());
      return jsonResponse(response.status === 429 ? 429 : 502, {
        error: response.status === 429
          ? 'מכסת Gemini החינמית נוצלה כרגע. אפשר לנסות שוב מאוחר יותר.'
          : 'שירות ה־AI לא זמין כרגע. נסה/י שוב בעוד רגע.'
      }, requestOrigin);
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim();
    if (!text) {
      console.error('Gemini chat returned no text:', JSON.stringify(result).slice(0, 1000));
      return jsonResponse(502, { error: 'העוזר לא החזיר תשובה. אפשר לנסות שוב.' }, requestOrigin);
    }
    return jsonResponse(200, { text: text.slice(0, 4000) }, requestOrigin);
  } catch (error) {
    console.error('Gemini chat request failed unexpectedly:', error);
    return jsonResponse(502, { error: 'לא ניתן להתחבר כרגע לעוזר ה־AI.' }, requestOrigin);
  }
};

const getLocalTime = (timezone, date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
};

const removeSubscription = async (id) => {
  const response = await databaseRequest(
    `${TABLE}?id=eq.${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
  if (!response.ok) {
    console.error('Could not remove stale push subscription:', await response.text());
  }
};

const releasePushSlot = async (id) => {
  const response = await databaseRequest(
    `${TABLE}?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ last_sent_slot: null })
    }
  );
  if (!response.ok) {
    console.error('Could not release failed push slot:', await response.text());
  }
};

const dispatchScheduledPushes = async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('Push service secrets are not configured.');
  }

  webpush.setVapidDetails('https://remind-bay.vercel.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const response = await databaseRequest(
    `${TABLE}?select=id,subscription,timezone,last_sent_slot&limit=1000`
  );
  if (!response.ok) {
    console.error('Could not load push subscriptions:', await response.text());
    throw new Error('Could not load push subscriptions.');
  }

  const subscriptions = await response.json();
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const hasDueSubscription = subscriptions.some((row) => {
    try {
      return getLocalTime(row.timezone).minute <= 4;
    } catch (error) {
      console.error(`Invalid timezone for push subscription ${row.id}:`, error);
      return false;
    }
  });
  const utcSlot = new Date().toISOString().slice(0, 13);
  const hourlyQuote = hasDueSubscription
    ? await createHourlyMotivation(utcSlot)
    : FALLBACK_QUOTES[0];

  for (const row of subscriptions) {
    let localTime;
    try {
      localTime = getLocalTime(row.timezone);
    } catch (error) {
      console.error(`Invalid timezone for push subscription ${row.id}:`, error);
      failed += 1;
      continue;
    }

    if (localTime.minute > 4) {
      skipped += 1;
      continue;
    }

    const slot = `${localTime.date}T${String(localTime.hour).padStart(2, '0')}`;
    const claimResponse = await databaseRequest('rpc/claim_remind_push_slot', {
      method: 'POST',
      body: JSON.stringify({ p_id: row.id, p_slot: slot })
    });
    if (!claimResponse.ok) {
      console.error(`Could not claim push slot for ${row.id}:`, await claimResponse.text());
      failed += 1;
      continue;
    }
    if (await claimResponse.json() !== true) {
      skipped += 1;
      continue;
    }

    const totalMinutesPassed = localTime.hour * 60 + localTime.minute;
    const hoursPassed = Math.floor(totalMinutesPassed / 60);
    const minutesPassed = totalMinutesPassed % 60;
    const totalMinutesLeft = 24 * 60 - totalMinutesPassed;
    const hoursLeft = Math.floor(totalMinutesLeft / 60);
    const minutesLeft = totalMinutesLeft % 60;
    const body = `עברו ${hoursPassed} שעות ו-${minutesPassed} דקות מהיום.\n` +
      `נשארו עוד ${hoursLeft} שעות ו-${minutesLeft} דקות עד סוף היום.\n\n💬 ${hourlyQuote}`;

    try {
      await webpush.sendNotification(
        row.subscription,
        JSON.stringify({
          title: '⏰ Remind - עדכון שעתי',
          body,
          icon: new URL('assets/remind-logo.png', row.site_url).toString(),
          badge: new URL('assets/remind-icon-192.png', row.site_url).toString(),
          tag: 'remind-hourly-motivation',
          url: row.site_url
        }),
        { TTL: 3600 }
      );
      sent += 1;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await removeSubscription(row.id);
      } else {
        console.error(`Push delivery failed for ${row.id}:`, error);
        await releasePushSlot(row.id);
      }
      failed += 1;
    }
  }

  return { sent, skipped, failed };
};

Deno.serve(async (request) => {
  const requestOrigin = request.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.has(requestOrigin);
  if (request.method === 'OPTIONS') {
    return allowedOrigin
      ? new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': requestOrigin,
          'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Vary': 'Origin'
        }
      })
      : new Response(null, { status: 403 });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed.' }, requestOrigin);
  }

  const authorization = request.headers.get('Authorization') || '';
  const bearerToken = authorization.replace(/^Bearer\s+/i, '');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: 'Push service is not configured.' }, requestOrigin);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid request body.' }, requestOrigin);
  }

  if (payload.action === 'dispatch') {
    if (!SERVICE_ROLE_KEY || !payload.dispatchToken) {
      return jsonResponse(401, { error: 'Unauthorized.' }, requestOrigin);
    }

    const tokenResponse = await databaseRequest('rpc/validate_remind_push_dispatch_token', {
      method: 'POST',
      body: JSON.stringify({ p_token: payload.dispatchToken })
    });
    if (!tokenResponse.ok) {
      console.error('Could not validate scheduled dispatch token:', await tokenResponse.text());
      return jsonResponse(500, { error: 'Could not authorize scheduled dispatch.' }, requestOrigin);
    }
    if (await tokenResponse.json() !== true) {
      return jsonResponse(401, { error: 'Unauthorized.' }, requestOrigin);
    }

    try {
      return jsonResponse(200, await dispatchScheduledPushes(), requestOrigin);
    } catch (error) {
      console.error('Scheduled push dispatch failed:', error);
      return jsonResponse(500, { error: 'Scheduled push dispatch failed.' }, requestOrigin);
    }
  }

  if (!allowedOrigin ||
      !APP_PUBLISHABLE_KEY ||
      request.headers.get('apikey') !== APP_PUBLISHABLE_KEY ||
      bearerToken !== APP_PUBLISHABLE_KEY) {
    return jsonResponse(401, { error: 'Unauthorized app request.' }, requestOrigin);
  }

  if (payload.action === 'assistant-chat') {
    return await handleAssistantChat(payload, requestOrigin);
  }

  const { action, installationId } = payload;
  if (action === 'public-key') {
    if (!VAPID_PUBLIC_KEY) {
      return jsonResponse(500, { error: 'Push public key is not configured.' }, requestOrigin);
    }
    return jsonResponse(200, { vapidPublicKey: VAPID_PUBLIC_KEY }, requestOrigin);
  }

  if (typeof installationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId)) {
    return jsonResponse(400, { error: 'Invalid installation ID.' }, requestOrigin);
  }

  if (action === 'unsubscribe') {
    const response = await databaseRequest(
      `${TABLE}?id=eq.${encodeURIComponent(installationId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      console.error('Could not remove push subscription:', await response.text());
      return jsonResponse(500, { error: 'Could not disable push reminders.' }, requestOrigin);
    }
    return jsonResponse(200, { ok: true }, requestOrigin);
  }

  if (action !== 'subscribe' ||
      !payload.subscription ||
      typeof payload.subscription.endpoint !== 'string' ||
      !payload.subscription.endpoint.startsWith('https://') ||
      typeof payload.subscription.keys?.p256dh !== 'string' ||
      typeof payload.subscription.keys?.auth !== 'string' ||
      typeof payload.timezone !== 'string' ||
      typeof payload.siteUrl !== 'string') {
    return jsonResponse(400, { error: 'Invalid push subscription.' }, requestOrigin);
  }

  let siteUrl;
  try {
    siteUrl = new URL(payload.siteUrl);
    if (siteUrl.origin !== requestOrigin ||
        !siteUrl.href.startsWith(`${requestOrigin}/`) ||
        !['https:', 'http:'].includes(siteUrl.protocol)) {
      return jsonResponse(400, { error: 'Invalid site URL.' }, requestOrigin);
    }
  } catch {
    return jsonResponse(400, { error: 'Invalid site URL.' }, requestOrigin);
  }

  try {
    new Intl.DateTimeFormat('en', { timeZone: payload.timezone });
  } catch {
    return jsonResponse(400, { error: 'Invalid timezone.' }, requestOrigin);
  }

  const existingResponse = await databaseRequest(`${TABLE}?select=id&limit=20`);
  if (!existingResponse.ok) {
    console.error('Could not check push subscription limit:', await existingResponse.text());
    return jsonResponse(500, { error: 'Could not register push reminders.' }, requestOrigin);
  }
  const existingRows = await existingResponse.json();
  if (existingRows.length >= 20 && !existingRows.some((row) => row.id === installationId)) {
    return jsonResponse(429, { error: 'Push subscription limit reached.' }, requestOrigin);
  }

  const saveResponse = await databaseRequest(`${TABLE}?on_conflict=id`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({
      id: installationId,
      subscription: payload.subscription,
      timezone: payload.timezone,
      site_url: siteUrl.toString(),
      updated_at: new Date().toISOString()
    })
  });
  if (!saveResponse.ok) {
    console.error('Could not save push subscription:', await saveResponse.text());
    return jsonResponse(500, { error: 'Could not register push reminders.' }, requestOrigin);
  }

  return jsonResponse(200, { ok: true }, requestOrigin);
});
