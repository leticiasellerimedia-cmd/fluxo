// Utilitários de fuso horário e datas compartilhados entre servidor e navegador.
// Datas de calendário são strings 'YYYY-MM-DD' no fuso da empresa; instantes são ISO UTC.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TZ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const cache = {};
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n) => String(n).padStart(2, '0');

  function fmt(tz) {
    if (!cache[tz]) {
      cache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
      });
    }
    return cache[tz];
  }

  function parts(ts, tz) {
    const o = {};
    for (const p of fmt(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, ss: +o.second, wd: WD.indexOf(o.weekday) };
  }

  function offset(ts, tz) {
    const p = parts(ts, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ts / 1000) * 1000;
  }

  // Converte data + hora locais (no fuso informado) para ISO UTC.
  function toUtc(dateStr, timeStr, tz) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    let ts = guess - offset(guess, tz);
    ts = guess - offset(ts, tz);
    return new Date(ts).toISOString();
  }

  const ms = (v) => (typeof v === 'number' ? v : Date.parse(v));
  function localDate(ts, tz) { const p = parts(ms(ts), tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
  function localTime(ts, tz) { const p = parts(ms(ts), tz); return `${pad(p.hh)}:${pad(p.mm)}`; }
  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function addMonthsClamped(dateStr, n, dayOfMonth) {
    const [y, m] = dateStr.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(dayOfMonth, last));
    return target.toISOString().slice(0, 10);
  }
  function weekday(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  function diffDays(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function dayRange(dateStr, tz) { return [toUtc(dateStr, '00:00', tz), toUtc(addDays(dateStr, 1), '00:00', tz)]; }
  function startOfWeek(dateStr) { return addDays(dateStr, -weekday(dateStr)); } // domingo, padrão americano
  function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
  function isTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }

  return { pad, parts, toUtc, localDate, localTime, addDays, addMonthsClamped, weekday, diffDays, dayRange, startOfWeek, isDate, isTime };
});
