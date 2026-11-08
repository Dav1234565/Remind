import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const APP_PUBLISHABLE_KEY = Deno.env.get('APP_PUBLISHABLE_KEY');
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');
const TABLE = 'remind_push_subscriptions';
const ALLOWED_ORIGINS = new Set([
  'https://remind-bay.vercel.app',
  'https://dav1234565.github.io',
  'http://localhost:8765',
  'http://127.0.0.1:8765'
]);
const QUOTES = [
  'כל רגע הוא הזדמנות חדשה להתקדם לעבר המטרות שלך!',
  'אתה עושה עבודה מדהימה, תמשיך ככה!',
  'הצעדים הקטנים שאתה עושה כל יום יוצרים את השינוי הגדול.',
  'קח רגע לנשום עמוק, אתה בדרך הנכונה!',
  'היום הזה מלא בפוטנציאל, תפיק ממנו את המיטב!',
  'התמדה היא המפתח להצלחה. תהיה גאה בדרך שלך!'
];

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
    const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    const body = `עברו ${hoursPassed} שעות ו-${minutesPassed} דקות מהיום.\n` +
      `נשארו עוד ${hoursLeft} שעות ו-${minutesLeft} דקות עד סוף היום.\n\n💬 ${quote}`;

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
