/**
 * עוזר קורס הקופונים – שרת ביניים חינמי (Google Apps Script) ל-Gemini API.
 * הגדרות (Project Settings → Script properties):
 *   GEMINI_API_KEY  – מפתח מ-Google AI Studio (חובה)
 *   KB_URL          – כתובת מאגר הידע (ברירת מחדל: מוגדר למטה)
 *   MODEL           – שם המודל (ברירת מחדל: gemini-flash-latest)
 *   PER_MIN, PER_DAY – מגבלות שימוש (ברירת מחדל: 12 לדקה, 600 ליום)
 */
const DEFAULT_KB_URL = 'https://evyatarc3.github.io/coupons/kb.md';
const DEFAULT_MODEL = 'gemini-flash-latest';
const FALLBACK_MODEL = 'gemini-flash-lite-latest';

const SYSTEM = `את/ה "העוזר של קורס הקופונים" – העוזר הרשמי של קורס השתתפות במחקר (קופונים) במחלקה לפסיכולוגיה, אוניברסיטת אריאל, ושל מערכת SONA (arieluniversity.sona-systems.com).
קהל: סטודנטים, עוזרי מחקר ומנהלי מעבדות.

כללים:
1. עונים רק לפי "מאגר הידע" שלמטה. לא ממציאים כללים, מספרים, מועדים, חריגים, שמות או קישורים. אם התשובה לא במאגר – אומרים זאת בקצרה ומפנים לאביתר כהן, evyatarco@ariel.ac.il, עם תזכורת לציין שם מלא ות.ז.
2. אין לך גישה ל-SONA, לציונים או לרשומות אישיות. לא מאשרים, לא בודקים ולא מבטיחים דבר – מסבירים איך לבדוק או למי לפנות.
3. עונים בעברית (אלא אם כתבו בשפה אחרת), בקצרה: משפט תשובה, ואז צעדים ממוספרים אם יש הליך. שמות כפתורים ומסכים של SONA כותבים באנגלית בדיוק כמו במאגר (My Schedule/Credits, Reassign, Uncredited Timeslots וכו').
4. לשון פנייה כוללנית (נרשמ/ת) או רבים.
5. אם לא ברור אם הפונה סטודנט/ית או חוקר/ת והתשובה שונה – שואלים שאלה אחת קצרה.
6. לא מבקשים להקליד בצ'אט ת.ז., טלפון או מידע רפואי. פרטים מזהים כותבים רק במייל לאביתר.
7. מספר הטלפון של אביתר ניתן רק לעוזרי מחקר ומנהלי מעבדות, לא לסטודנטים.
8. כשצריך לפנות למישהו – מציעים נוסח מייל קצר לפי התבניות שבמאגר, עם [שם מלא] ו-[ת.ז.] למילוי.
9. לא עוזרים לעקוף נהלים (קופונים בלי השתתפות, הרשמה בלי עמידה בתנאי סף, תשובות לא כנות לשאלון המקדים, מתן קופונים מעבר למוגדר).
10. קופון נספר רק אם אושר וגם משויך לקורס פסיכולוגיה. קופונים ממתינים לא נספרים. לא מבטיחים מתי יוזן "עבר".
11. לחוקרים: תמיד להזכיר ללחוץ Update Sign-Ups (או Process Changes) – בלי זה שום דבר לא נשמר.
12. אל תשתמש/י בכותרות או טבלאות גדולות; טקסט פשוט, הדגשה ב-**כוכביות** ורשימות בלבד.`;

function doGet() {
  return json_({ ok: true });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const msgs = (req.messages || []).slice(-8).map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: String(m.text || '').slice(0, 1200) }],
    })).filter(m => m.parts[0].text.trim());
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json_({ error: 'bad_request' });
    if (!rateOk_()) return json_({ error: 'busy' });

    const props = PropertiesService.getScriptProperties();
    const key = props.getProperty('GEMINI_API_KEY');
    if (!key) return json_({ error: 'no_key' });

    const audience = req.audience === 'staff' ? 'עוזר/ת מחקר או מנהל/ת מעבדה' : 'סטודנט/ית (כנראה)';
    const sys = SYSTEM + '\n\nהפונה נמצא/ת כעת בלשונית: ' + audience + '\n\n# מאגר הידע\n' + getKB_();

    const models = [props.getProperty('MODEL') || DEFAULT_MODEL, FALLBACK_MODEL];
    for (const model of models) {
      const res = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
        {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          headers: { 'x-goog-api-key': key },
          payload: JSON.stringify({
            systemInstruction: { parts: [{ text: sys }] },
            contents: msgs,
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
          }),
        });
      const code = res.getResponseCode();
      if (code === 200) {
        const j = JSON.parse(res.getContentText());
        const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
        const text = parts.map(p => p.text || '').join('').trim();
        if (text) return json_({ text: text });
      }
      if ([404, 429, 500, 503].indexOf(code) < 0) break; // try the fallback model only on these
    }
    return json_({ error: 'unavailable' });
  } catch (err) {
    return json_({ error: 'server' });
  }
}

function getKB_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('kb');
  if (hit) return hit;
  const url = PropertiesService.getScriptProperties().getProperty('KB_URL') || DEFAULT_KB_URL;
  const kb = UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText('UTF-8');
  try { cache.put('kb', kb, 3600); } catch (e) { /* too large for cache – fine */ }
  return kb;
}

function rateOk_() {
  const props = PropertiesService.getScriptProperties();
  const perMin = +(props.getProperty('PER_MIN') || 12), perDay = +(props.getProperty('PER_DAY') || 600);
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cache = CacheService.getScriptCache();
    const now = new Date();
    const mk = 'm' + Math.floor(now.getTime() / 60000);
    const m = +(cache.get(mk) || 0);
    const today = Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyyMMdd');
    let d = props.getProperty('DAY') === today ? +(props.getProperty('DAY_COUNT') || 0) : 0;
    if (m >= perMin || d >= perDay) return false;
    cache.put(mk, String(m + 1), 120);
    props.setProperties({ DAY: today, DAY_COUNT: String(d + 1) });
    return true;
  } finally {
    lock.releaseLock();
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** בדיקה ידנית מהעורך: Run → testAssistant */
function testAssistant() {
  const r = doPost({ postData: { contents: JSON.stringify({ audience: 'students', messages: [{ role: 'user', text: 'כמה קופונים צריך לצבור?' }] }) } });
  Logger.log(r.getContent());
}
