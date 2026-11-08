# הגדרת התראות Push גם כשהאתר סגור

הדפדפן לא יכול לתזמן התראות בעצמו כשהאתר סגור. ההגדרה הזו משתמשת ב־Supabase Edge Function וב־`pg_cron`, ושולחת Push פעם בשעה לפי אזור הזמן של המכשיר. אין צורך באימייל או בהתחברות משתמש.

## 1. יצירת מפתחות VAPID

צור/י זוג מפתחות פרטי במחשב שלך:

```sh
npx --yes web-push generate-vapid-keys
```

שמור/י את המפתח הפרטי אצלך בלבד. אל תכניס/י אותו לקובץ HTML, ל־Git או לצ'אט.

## 2. פריסת מסד הנתונים והפונקציה

התקן/י את Supabase CLI והתחבר/י לחשבון, ואז הרץ/י משורש הפרויקט:

```sh
supabase link --project-ref lguuxrwjwwzxkhydjryo
supabase db push
supabase functions deploy remind-push
```

הקובץ `index.html` מכיל את מפתח ה־publishable הציבורי של הפרויקט. מפתח VAPID הציבורי נשלף מהפונקציה בזמן הפעלת ההתראות; אין צורך להכניס אותו לקוד הדפדפן.

הגדר/י את סודות הפונקציה ב־Supabase (המפתח הפרטי אינו נכנס לקוד):

```sh
supabase secrets set --project-ref lguuxrwjwwzxkhydjryo \
  APP_PUBLISHABLE_KEY='sb_publishable_mOtrogkoIlfugUNztuFyYA_yN7T-av8' \
  VAPID_PUBLIC_KEY='המפתח-הציבורי' \
  VAPID_PRIVATE_KEY='המפתח-הפרטי'
```

## 3. הפעלת תזמון שעתי

ב־Supabase Dashboard יש להפעיל את ההרחבות `pg_cron` ו־`pg_net`, ולהוסיף ב־Vault שני סודות:

- `remind_project_url` — `https://lguuxrwjwwzxkhydjryo.supabase.co`
- `remind_service_role_key` — מפתח ה־`service_role` של הפרויקט. יש לשמור אותו ב־Vault בלבד, לעולם לא בקוד הדפדפן.

לאחר מכן הרץ/י ב־SQL Editor:

```sql
select cron.unschedule(jobid)
from cron.job
where jobname = 'remind-push-every-minute';

select cron.schedule(
  'remind-push-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'remind_project_url'
    ) || '/functions/v1/remind-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'remind_service_role_key'
      )
    ),
    body := jsonb_build_object('action', 'dispatch')
  );
  $$
);
```

הפונקציה בודקת את השעה המקומית ושולחת לכל התקנה לכל היותר התראה אחת בתחילת כל שעה. כדי לקבל התראות, יש להפעיל אותן בהגדרות Remind ולאשר את בקשת הדפדפן. ב־iPhone יש להוסיף את האתר למסך הבית ולאפשר התראות עבורו.

הקישור להפעלת התראות מוגבל בדפדפן ל־Vercel ול־GitHub Pages שמוגדרים בפונקציה. אם האתר פורסם בכתובת אחרת, יש להוסיף את ה־origin שלה ל־`ALLOWED_ORIGINS` ולפרוס מחדש.
