/**
 * GradeNext AutoPost  (Google Apps Script, free, runs 24/7 on Google's servers)
 * ---------------------------------------------------------------------------------
 * Posts the approved videos from the inventory Tasks list to Instagram (Reel), Facebook Page (Reel)
 * and YouTube (Short or long video) at their scheduled date/time (San Francisco time), with the caption
 * and hashtags edited in the inventory. Storage = one JSON file in Google Drive (no Vercel).
 *
 * Web API (POST text/plain JSON, every write needs the edit PIN):
 *   {action:'list'}                                   -> {items:[...]}
 *   {action:'upsert', pin, item:{id, k, title, fileId, coverId, date:'YYYY-MM-DD', time:'HH:MM',
 *                                caption, hashtags, platforms:{ig:true,fb:true,yt:true}, ytKind:'short'|'video', approved}}
 *   {action:'move',   pin, id, date, time}           (double-click edit / drag in Tasks)
 *   {action:'edit',   pin, id, caption, hashtags, platforms, title}   (pencil editor)
 *   {action:'postNow',pin, id}                        (manual "post now")
 *   {action:'status'}                                 -> last runs + token health
 * Timer: runDue() every 5 minutes posts everything that is due, approved and not posted yet.
 */
var TZ = 'America/Los_Angeles';
var GRAPH = 'https://graph.facebook.com/v21.0';
var P = PropertiesService.getScriptProperties();   // secrets live here, never in the code:
// EDIT_PIN, META_PAGE_TOKEN, META_PAGE_ID, IG_USER_ID, YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN, QUEUE_FILE_ID

/* ---------------- storage (Drive JSON) ---------------- */
function queueFile_() {
  var id = P.getProperty('QUEUE_FILE_ID');
  if (id) return DriveApp.getFileById(id);
  var f = DriveApp.createFile('gradenext-autopost-queue.json', JSON.stringify({ items: [], log: [] }), 'application/json');
  P.setProperty('QUEUE_FILE_ID', f.getId()); return f;
}
function load_() { return JSON.parse(queueFile_().getBlob().getDataAsString() || '{"items":[],"log":[]}'); }
function save_(q) { q.log = (q.log || []).slice(-300); queueFile_().setContent(JSON.stringify(q)); }
function log_(q, id, msg) { q.log = q.log || []; q.log.push({ at: new Date().toISOString(), id: id, msg: String(msg).slice(0, 500) }); }

/* ---------------- web API ---------------- */
function doGet(e) {   // Nov 14: only used as the YouTube sign-in return page (Kuldeep sir connects the GradeNext channel once)
  var p = (e && e.parameter) || {};
  if (p.state === 'gnyt' && p.code) return ytCallback_(p.code);
  if (p.state === 'gnyt' && p.error) return page_('YouTube was not connected', 'Google said: ' + p.error + '. Please open the link again and press Allow.', false);
  return page_('GradeNext AutoPost', 'Running.', true);
}
function page_(h, t, ok) {
  return HtmlService.createHtmlOutput('<div style="font:600 18px system-ui,sans-serif;max-width:520px;margin:80px auto;text-align:center;color:#1b1b1f">' +
    '<div style="width:72px;height:72px;border-radius:50%;margin:0 auto 18px;display:grid;place-items:center;background:' + (ok ? '#3FBF75' : '#F87171') + ';color:#fff;font-size:38px">' + (ok ? '&#10003;' : '!') + '</div>' +
    '<h1 style="font-size:26px;margin:0 0 10px">' + h + '</h1><p style="color:#555;font-weight:500">' + t + '</p></div>').setTitle(h);
}
function ytCallback_(code) {   // swap the sign-in code for a permanent token, then make sure it is the GradeNext channel
  try {
    var r = fetch_('https://oauth2.googleapis.com/token', { method: 'post', payload: { code: code, client_id: P.getProperty('YT_CLIENT_ID'), client_secret: P.getProperty('YT_CLIENT_SECRET'),
      redirect_uri: ScriptApp.getService().getUrl(), grant_type: 'authorization_code' } });
    if (!r.refresh_token) return page_('Almost', 'Google did not give a lasting key. Please open the link again (it must ask you to Allow).', false);
    var ch = JSON.parse(UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + r.access_token }, muteHttpExceptions: true }).getContentText());
    var it = (ch.items || [])[0];
    if (!it || it.id !== YT_CHANNEL) return page_('Wrong channel', 'You picked ' + (it ? it.snippet.title : 'no channel') + '. Please open the link again and choose <b>GradeNext</b>.', false);
    P.setProperty('YT_REFRESH_TOKEN', r.refresh_token);
    try { MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'GradeNext: YouTube auto-post is connected', 'The GradeNext channel was connected at ' + new Date() + '. Approved videos now post to YouTube automatically.'); } catch (e) {}
    return page_('YouTube connected', 'GradeNext channel is linked. Approved videos will now post to YouTube automatically. You can close this page.', true);
  } catch (e) { return page_('Not connected', String(e.message || e).slice(0, 200) + '<br>Please open the link again.', false); }
}
function doPost(e) {
  var b = {}; try { b = JSON.parse(e.postData.contents); } catch (x) { return json_({ error: 'bad json' }); }
  if (b.action === 'list') return json_({ items: load_().items });
  if (b.action === 'status') return json_(status_());
  if (String(b.pin || '') !== P.getProperty('EDIT_PIN')) return json_({ error: 'pin' });
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var q = load_(), it = find_(q, b.id || (b.item && b.item.id));
    if (b.action === 'upsert') {
      var n = b.item; if (!/^[a-z0-9-]{2,20}$/.test(n.id || '')) return json_({ error: 'id' });
      if (!it) { it = { id: n.id, status: 'scheduled', done: {} }; q.items.push(it); }
      ['k', 'title', 'fileId', 'coverId', 'ytCoverId', 'date', 'time', 'caption', 'hashtags', 'ytKind', 'approved', 'platforms'].forEach(function (f) { if (f in n) it[f] = n[f]; });
    } else if (b.action === 'move') {
      if (!it) return json_({ error: 'not found' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) return json_({ error: 'date/time' });
      it.date = b.date; it.time = b.time; if (it.status === 'failed') it.status = 'scheduled';
    } else if (b.action === 'edit') {
      if (!it) return json_({ error: 'not found' });
      ['caption', 'hashtags', 'title', 'platforms'].forEach(function (f) { if (f in b) it[f] = b[f]; });
    } else if (b.action === 'postNow') {
      if (!it) return json_({ error: 'not found' }); save_(q); lock.releaseLock(); postItem_(it.id); return json_({ item: find_(load_(), it.id) });
    } else return json_({ error: 'action' });
    save_(q); return json_({ item: it });
  } finally { try { lock.releaseLock(); } catch (x) {} }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function find_(q, id) { for (var i = 0; i < q.items.length; i++) if (q.items[i].id === id) return q.items[i]; return null; }

/* ---------------- scheduler ---------------- */
function dueMs_(it) {   // date + time are San Francisco wall-clock time
  var off = Utilities.formatDate(new Date(it.date + 'T12:00:00Z'), TZ, 'XXX');   // -07:00 / -08:00 (handles daylight saving)
  return new Date(it.date + 'T' + it.time + ':00' + off).getTime();
}
function runDue() {   // every 5 min, 24/7 on Google's servers. One run at a time (lock) so nothing can ever post twice.
  var lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return;
  try {
    try { syncSite_(); } catch (e) { Logger.log('site sync failed: ' + e.message); }
    try { if (Date.now() - Number(P.getProperty('VIEWS_AT') || 0) > 55 * 60e3) syncViews_(); } catch (e) { Logger.log('views sync failed: ' + e.message); }
    try { notifyRemakes_(); } catch (e) { Logger.log('remake mail failed: ' + e.message); }
    try { repostFb_(); } catch (e) { Logger.log('fb repost failed: ' + e.message); }
    try { ytBacklog_(); } catch (e) { Logger.log('yt backlog: ' + e.message); }
    try { repostFbDue_(); } catch (e) { Logger.log('fb repost failed: ' + e.message); }
    var q = load_(), now = Date.now(), t0 = Date.now();
    q.items.filter(function (it) { return due_(it, now); })
      .sort(function (a, b) { return dueMs_(a) - dueMs_(b); })
      .forEach(function (it) { if (Date.now() - t0 < 150000) { postItem_(it.id); report_(it.id); } });   // Apps Script runs max 6 min: the rest posts on the next run
  } finally { lock.releaseLock(); }
}
/* Nov 13: the 7 Facebook reels posted while the Meta app was still in test mode (hidden, 0 views) are posted again, one per day at a
   good time for US parents (weekday 7 PM PT, weekend 10 AM PT). The plan is in REPOST_PLAN below; done ones are kept in Script Property FB_REPOST_DONE. */
var REPOST_PLAN = [['e-x08', '2026-11-12', '19:00'], ['e-x09', '2026-11-13', '19:00'], ['e-sh1', '2026-11-14', '10:00'], ['e-x10', '2026-11-15', '10:00'],
                   ['e-x04', '2026-11-16', '19:00'], ['e-x22', '2026-11-17', '19:00'], ['e-x20', '2026-11-18', '19:00']];
function repostFbDue_() {
  if (!P.getProperty('META_PAGE_TOKEN')) return;
  var done = JSON.parse(P.getProperty('FB_REPOST_DONE') || '{}'), now = Date.now();
  REPOST_PLAN.forEach(function (r) {
    if (done[r[0]]) return; var ms = dueMs_({ date: r[1], time: r[2] }); if (now < ms || now - ms > 6 * 3600e3) return;   // only inside its own 6-hour window
    var q = load_(), it = find_(q, r[0]); if (!it || !it.fileId) { done[r[0]] = 'missing'; return; }
    done[r[0]] = 'posting'; P.setProperty('FB_REPOST_DONE', JSON.stringify(done));   // never twice, even if this run is cut off
    var text = (it.caption || '') + (it.hashtags ? '\n\n' + it.hashtags : '');
    try { var url = postFB_(it, text); done[r[0]] = url; it.done = it.done || {}; it.done.fb = url; it.repSig = ''; log_(q, r[0], 'fb REPOSTED ' + url); save_(q); report_(r[0]); }
    catch (e) { done[r[0]] = 'failed: ' + e.message.slice(0, 150); MailApp.sendEmail(P.getProperty('ALERT_MAIL') || Session.getEffectiveUser().getEmail(), 'GradeNext: Facebook repost failed ' + r[0], e.message); }
    P.setProperty('FB_REPOST_DONE', JSON.stringify(done));
  });
}
/* Nov 13 (Aryan's go): repost on Facebook the 7 reels that were hidden while the Meta app was still in test mode (0 views).
   Best IG performers first, one at a time, 09:00 and 12:00 PT (9 AM is our best time on the Analysis numbers). Old reels are kept. */
var FB_REPOST_ = [['e-x08', '2026-11-13', '09:00'], ['e-x09', '2026-11-13', '12:00'], ['e-x10', '2026-11-14', '09:00'], ['e-x04', '2026-11-14', '12:00'],
                  ['e-x22', '2026-11-15', '09:00'], ['e-sh1', '2026-11-15', '12:00'], ['e-x20', '2026-11-16', '09:00']];
function repostFb_() {
  if (!P.getProperty('META_PAGE_TOKEN')) return;
  var done = JSON.parse(P.getProperty('FB_REPOST_DONE') || '{}'), now = Date.now();
  for (var i = 0; i < FB_REPOST_.length; i++) {
    var r = FB_REPOST_[i]; if (done[r[0]]) continue;
    var ms = dueMs_({ date: r[1], time: r[2] }); if (now < ms) break;
    if (now - ms > 36 * 3600e3) { done[r[0]] = 'skipped: too late'; continue; }
    var q = load_(), it = find_(q, r[0]); if (!it || !it.fileId || !it.coverId) { done[r[0]] = 'skipped: no video/cover'; continue; }
    try {
      var url = postFB_(it, (it.caption || '') + (it.hashtags ? '\n\n' + it.hashtags : ''));
      done[r[0]] = url; it.done = it.done || {}; it.oldFb = it.done.fb || ''; it.done.fb = url; it.repSig = ''; log_(q, r[0], 'fb REPOSTED ' + url + ' (old hidden reel ' + it.oldFb + ')'); save_(q);
      P.setProperty('FB_REPOST_DONE', JSON.stringify(done)); report_(r[0]);
    } catch (e) { var n = (done['_err_' + r[0]] || 0) + 1; done['_err_' + r[0]] = n; if (n >= 3) { done[r[0]] = 'failed: ' + e.message; MailApp.sendEmail(P.getProperty('ALERT_MAIL') || Session.getEffectiveUser().getEmail(), 'GradeNext: Facebook repost failed ' + r[0], e.message); } }
    break;   // one repost per run
  }
  P.setProperty('FB_REPOST_DONE', JSON.stringify(done));
}
/* Nov 13: team re-uploads (re-edit / record again) -> one e-mail to Aryan saying if the video is posted, in the queue or waiting, and its Remade number. */
function notifyRemakes_() {
  var pin = P.getProperty('EDIT_PIN'); if (!pin) return;
  var r = UrlFetchApp.fetch(SITE + '/api/remake?pending=1', { headers: { 'x-pin': pin }, muteHttpExceptions: true }); if (r.getResponseCode() !== 200) return;
  var list = JSON.parse(r.getContentText()).list || []; if (!list.length) return;
  var body = list.map(function (x) { return '• ' + x.id + (x.who ? ' (' + x.who + ')' : '') + ': ' + x.msg + (x.file ? '\n  file: ' + x.file : ''); }).join('\n\n');
  MailApp.sendEmail(P.getProperty('ALERT_MAIL') || Session.getEffectiveUser().getEmail(), 'GradeNext: ' + list.length + ' video' + (list.length > 1 ? 's' : '') + ' re-edited / recorded again', body + '\n\n' + SITE + '/#approval');
  UrlFetchApp.fetch(SITE + '/api/remake', { method: 'post', contentType: 'application/json', headers: { 'x-pin': pin }, payload: JSON.stringify({ sent: list.map(function (x) { return x.at; }) }), muteHttpExceptions: true });
}
function due_(it, now) {
  if (!it.approved || it.auto === false || !it.date || !it.time) return false;
  if (!(it.status === 'scheduled' || it.status === 'partial' || (it.nowReq && it.nowReq !== it.nowDone))) return false;
  if (!wanted_(it).some(function (p) { return !(it.done || {})[p]; })) return false;
  if (it.nowReq && it.nowReq !== it.nowDone) { it.nowDone = it.nowReq; var q = load_(), x = find_(q, it.id); x.nowDone = it.nowReq; if (x.status === 'missed' || x.status === 'failed') x.status = 'scheduled'; x.tries = 0; save_(q); return true; }
  return dueMs_(it) <= now;
}
/* ---------------- inventory website = the boss ----------------
   Every run reads the website: ap/data.json (videos, covers, captions, plan), /api/plan (dates, times, platforms, caption edits,
   auto on/off, post-now, posted ticks) and /api/approve (Dr. Shahid's approvals). Approved + due = posted. Results go back to the
   Tasks tab (ticks + links + status) with the edit PIN (Script Property EDIT_PIN). */
var SITE = 'https://gradenext-inventory.vercel.app';
var PLACE_ = '191974150831236';   // Facebook place "Bay Area" (San Leandro, CA) = the location Dr. Shahid uses on GradeNext posts (Aryan, Nov 6)
function getJ_(u) { return JSON.parse(UrlFetchApp.fetch(u + (u.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { muteHttpExceptions: false }).getContentText()); }
function syncSite_() {
  var d = getJ_(SITE + '/ap/data.json'), ov = getJ_(SITE + '/api/plan').ov || {}, ap = getJ_(SITE + '/api/approve').ap || {};
  var q = load_(), now = Date.now(), ch = false;
  d.plan.forEach(function (row) {
    var c = d.cards[row.k]; if (!c || !c.fileId) return;
    var o = ov[row.id] || {}, it = find_(q, row.id);
    if (!it) { it = { id: row.id, status: 'scheduled', done: {}, tries: 0 }; q.items.push(it); }
    var pl = o.pl || row.pl || ['ig', 'fb', 'yt'], cap = c.cap || [];
    var before = JSON.stringify(it);
    it.k = row.k; it.title = o.ytTitle || c.title; it.date = o.date || row.date; it.time = o.time || row.time;
    it.platforms = { ig: pl.indexOf('ig') >= 0, fb: pl.indexOf('fb') >= 0, yt: pl.indexOf('yt') >= 0 };
    it.caption = typeof o.cap === 'string' && o.cap ? o.cap : [cap[0] || '', cap[1] || ''].filter(Boolean).join('\n\n');
    it.hashtags = typeof o.tags === 'string' && o.tags ? o.tags : (cap[2] || '');
    it.ytKind = c.wide ? 'video' : 'short'; it.approved = (ap[row.k] || {}).st === 'ok'; it.auto = o.auto !== 'off';
    if (o.now) it.nowReq = o.now;
    if (o.cover) it.coverUrl = SITE + o.cover; else if (c.cover) it.coverUrl = SITE + '/' + c.cover;   // a cover changed in the pencil popup wins
    var posted = Object.keys(it.done || {}).length > 0;
    if (!posted && it.fileId !== c.fileId) { it.fileId = c.fileId; }
    [row.done || {}, o.done || {}].forEach(function (dn) { Object.keys(dn).forEach(function (p) { if (dn[p] && dn[p] !== 'skip') { it.done = it.done || {}; if (!it.done[p]) it.done[p] = dn[p]; } }); });   // posted by hand = never again
    if (it.status === 'posting' && now - (it.postStart || 0) > 15 * 60e3) it.status = 'partial';   // a run was cut off: try again
    var left = ['ig', 'fb', 'yt'].filter(function (p) { return it.platforms[p] && !(it.done || {})[p]; }), leftReady = left.filter(ready_);
    if (!left.length) it.status = 'posted';
    else if (!leftReady.length && Object.keys(it.done || {}).length) it.status = 'partial';   // only a not-connected platform (YouTube) is left
    else if (it.status === 'posted') it.status = 'partial';
    if ((it.status === 'scheduled' || it.status === 'partial') && leftReady.length && it.approved && it.auto && now - dueMs_(it) > 24 * 3600e3 && !(it.nowReq && it.nowReq !== it.nowDone)) it.status = 'missed';   // never surprise-post old ones
    if (it.status === 'missed' && (now - dueMs_(it) <= 24 * 3600e3 || !leftReady.length)) it.status = leftReady.length ? 'scheduled' : (Object.keys(it.done || {}).length ? 'partial' : 'scheduled');   // date moved forward again
    if (JSON.stringify(it) !== before) ch = true;
  });
  try { if (findPosted_(q, d, ov)) ch = true; } catch (e) { Logger.log('find posted failed: ' + e.message); }
  try { if (slots_(q, d, ap)) ch = true; } catch (e) { Logger.log('slots failed: ' + e.message); }
  if (ch) save_(q);
  q.items.forEach(function (it) { if (/^e-/.test(it.id)) report_(it.id, true); });
}
/* Slots (Aryan, Nov 7): every day has 2 posting slots, San Francisco time:
   A = face reels (Main reel, Motivational, Dr. Shahid reel ...)  at SLOT_A
   B = Website or Blog video                                       at SLOT_B
   Approved videos fill the free slots in the order they were approved: first approved -> today's slot (if its time is still ahead),
   next -> tomorrow, and so on. Posted videos keep their day. Not-approved videos take no slot; when their time is over they move to the next day.
   New dates go back to the Tasks tab (/api/plan), so the website always shows the real posting day. */
var SLOT_A = '09:00', SLOT_B = '18:30';
function slotCat_(c, it) {
  if (!c) return '';   // max 2 videos a day: every video takes one of the 2 slots (YouTube-only long videos count as face = A)
  return (c.s === 'web' || c.s === 'blog') ? 'B' : 'A';
}
function slots_(q, d, ap) {
  var pin = P.getProperty('EDIT_PIN'), now = Date.now(), used = {}, cand = [], ch = false;
  q.items.forEach(function (it) {
    if (!/^e-/.test(it.id) || !it.k || !it.date) return;
    var done0 = Object.keys(it.done || {}).length > 0 || ['posting', 'posted', 'partial'].indexOf(it.status) >= 0;
    var canPost = wanted_(it).length > 0;   // at least one connected platform (YouTube-only videos wait until YouTube is connected)
    if (it.approved && !canPost && !done0 && dueMs_(it) < now) { var c0 = slotCat_(d.cards[it.k], it); if (c0) used[c0 + it.date] = 1; return; }   // approved but its platform (YouTube) is not connected yet: it keeps its slot day, nothing posts it
    if (!it.approved && !done0 && it.time && dueMs_(it) < now) {   // time is over and Dr. Shahid has not approved it: move it to tomorrow, same time (Aryan, Nov 7)
      var tom = Utilities.formatDate(new Date(now + 86400e3), TZ, 'yyyy-MM-dd');
      if (dueMs_({ date: Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd'), time: it.time }) > now) tom = Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd');
      var r0 = pin ? UrlFetchApp.fetch(SITE + '/api/plan', { method: 'post', contentType: 'application/json', headers: { 'x-pin': pin }, payload: JSON.stringify({ id: it.id, patch: { date: tom } }), muteHttpExceptions: true }) : null;
      if (r0 && r0.getResponseCode() === 200) { log_(q, it.id, 'not approved, moved ' + it.date + ' -> ' + tom); it.date = tom; if (it.status === 'missed') it.status = 'scheduled'; ch = true; }
    }
    var cat = slotCat_(d.cards[it.k], it); if (!cat) return;
    var posted = Object.keys(it.done || {}).length > 0 || ['posting', 'posted', 'partial', 'failed', 'missed'].indexOf(it.status) >= 0;
    if (posted) { used[cat + it.date] = 1; return; }
    if (it.approved && it.auto !== false && it.status === 'scheduled' && !(it.nowReq && it.nowReq !== it.nowDone)) cand.push({ it: it, cat: cat, at: (ap[it.k] || {}).at || '' });
  });
  cand.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : dueMs_(a.it) - dueMs_(b.it); });
  var day0 = new Date(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + 'T12:00:00Z').getTime();
  cand.forEach(function (x) {
    var tm = x.cat === 'A' ? SLOT_A : SLOT_B;
    for (var i = 0; i < 120; i++) {
      var day = Utilities.formatDate(new Date(day0 + i * 86400e3), 'UTC', 'yyyy-MM-dd'); if (used[x.cat + day]) continue;
      var ms = dueMs_({ date: day, time: tm }), mine = x.it.date === day && x.it.time === tm;
      if (ms > now + 3 * 60e3 || (mine && now - ms < 12 * 3600e3)) {   // still ahead, or it is this video's own slot that is being posted right now
        used[x.cat + day] = 1;
        if (!mine) {
          var r = pin ? UrlFetchApp.fetch(SITE + '/api/plan', { method: 'post', contentType: 'application/json', headers: { 'x-pin': pin }, payload: JSON.stringify({ id: x.it.id, patch: { date: day, time: tm } }), muteHttpExceptions: true }) : null;
          if (r && r.getResponseCode() === 200) { log_(q, x.it.id, 'slot ' + x.it.date + ' ' + x.it.time + ' -> ' + day + ' ' + tm); x.it.date = day; x.it.time = tm; ch = true; }
        }
        break;
      }
    }
  });
  return ch;
}
/* Views: every hour, read Instagram + Facebook views of every posted video from the Meta API and send them to the website (Analysis). */
function shortcode_(u) { var m = /instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/.exec(u || ''); return m ? m[1] : ''; }
function fbVid_(u) { var m = /facebook\.com\/(?:reel\/|.*\/videos\/|watch\/?\?v=)(\d+)/.exec(u || ''); return m ? m[1] : ''; }
function metric_(id, list, tok, edge) {   // ask for each view metric and keep the biggest (Instagram's own count = all plays)
  var best = null;
  for (var i = 0; i < list.length; i++) {
    try { var r = fetch_(GRAPH + '/' + id + '/' + edge + '?metric=' + list[i] + '&access_token=' + tok); var d = (r.data || [])[0];
      if (d) { var v = d.values ? d.values[0].value : d.total_value ? d.total_value.value : d.value; if (typeof v === 'number' && (best === null || v > best)) best = v; } } catch (e) { P.setProperty('VIEWS_ERR_' + edge, list[i] + ': ' + e.message.slice(0, 200)); }
  }
  return best;
}
function syncViews_() {
  var tok = P.getProperty('META_PAGE_TOKEN'), ig = P.getProperty('IG_USER_ID'), pin = P.getProperty('EDIT_PIN'); if (!tok || !pin) return;
  var d = getJ_(SITE + '/ap/data.json'), ov = getJ_(SITE + '/api/plan').ov || {}, links = {};
  Object.keys(d.cards).forEach(function (k) { var l = d.cards[k].links; if (l && typeof l === 'object') links[k] = { ig: l.ig, fb: l.fb }; });
  d.plan.forEach(function (row) { var dn = (ov[row.id] || {}).done || {}; links[row.k] = links[row.k] || {}; if (/^https/.test(dn.ig || '')) links[row.k].ig = dn.ig; if (/^https/.test(dn.fb || '')) links[row.k].fb = dn.fb; });
  var media = {}, when = {}, url = GRAPH + '/' + ig + '/media?fields=id,permalink,timestamp&limit=100&access_token=' + tok;
  for (var n = 0; url && n < 5; n++) { var r = fetch_(url); (r.data || []).forEach(function (m) { media[shortcode_(m.permalink)] = m.id; when[shortcode_(m.permalink)] = m.timestamp; }); url = r.paging && r.paging.next; }
  var out = {}, t0 = Date.now();
  Object.keys(links).forEach(function (k) {
    if (Date.now() - t0 > 240000) return;
    var o = {}, sc = shortcode_(links[k].ig), fv = fbVid_(links[k].fb);
    if (sc && when[sc]) o.d = Utilities.formatDate(new Date(String(when[sc]).replace(/\+0000$/, 'Z')), TZ, 'yyyy-MM-dd');   // posted date (San Francisco)
    if (sc && media[sc]) { var a = metric_(media[sc], ['ig_reels_aggregated_all_plays_count', 'views', 'plays'], tok, 'insights'); if (a !== null) o.ig = a; }
    if (fv) { var b = metric_(fv, ['fb_reels_total_plays', 'blue_reels_play_count', 'total_video_views'], tok, 'video_insights'); if (b !== null) o.fb = b; }
    if (fv && !o.d) { try { var ct = fetch_(GRAPH + '/' + fv + '?fields=created_time&access_token=' + tok).created_time; if (ct) o.d = Utilities.formatDate(new Date(String(ct).replace(/\+0000$/, 'Z')), TZ, 'yyyy-MM-dd'); } catch (e) {} }
    if (Object.keys(o).length) out[k] = o;
  });
  try { var Y = ytViews_(); Object.keys(Y).forEach(function (k) { out[k] = out[k] || {}; out[k].yt = Y[k]; }); } catch (e) { Logger.log('yt views: ' + e.message); }   // Nov 14: YouTube views too
  var res = UrlFetchApp.fetch(SITE + '/api/stats', { method: 'post', contentType: 'application/json', headers: { 'x-pin': pin }, payload: JSON.stringify({ v: out }), muteHttpExceptions: true });
  P.setProperty('VIEWS_AT', String(Date.now())); Logger.log('views sent for ' + Object.keys(out).length + ' videos: ' + res.getContentText().slice(0, 100));
  return out;
}
function checkViews() { P.deleteProperty('VIEWS_AT'); var o = syncViews_(); Logger.log(JSON.stringify(o)); Logger.log('IG error: ' + P.getProperty('VIEWS_ERR_insights') + ' | FB error: ' + P.getProperty('VIEWS_ERR_video_insights')); }
/* Ticks come only from the real posts: read the latest Instagram + Facebook reels of GradeNext and match them to the tasks by the
   first caption line (title). Found = tick + link (also when posted by hand). Not found = no tick. */
var norm_ = function (t) { return String(t || '').split('\n')[0].toLowerCase().replace(/[^a-z0-9%$]+/g, ' ').trim(); };
function findPosted_(q, d, ov) {
  var tok = P.getProperty('META_PAGE_TOKEN'), ig = P.getProperty('IG_USER_ID'), page = P.getProperty('META_PAGE_ID'); if (!tok) return false;
  var igm = (fetch_(GRAPH + '/' + ig + '/media?fields=caption,permalink,timestamp&limit=30&access_token=' + tok).data || []);
  var fbm = []; try { fbm = fetch_(GRAPH + '/' + page + '/video_reels?fields=id,description,permalink_url,created_time&limit=30&access_token=' + tok).data || []; } catch (e) { Logger.log('fb reels list: ' + e.message); }
  var ch = false;
  q.items.forEach(function (it) {
    if (!/^e-/.test(it.id) || !it.k) return;
    var c = d.cards[it.k] || {}, keys = [norm_(c.title), norm_((c.cap || [])[0]), norm_(it.caption)].filter(function (x) { return x.length > 6; });
    var since = dueMs_(it) - 5 * 86400e3;
    var hit = function (txt, when) { var n = norm_(txt); return n && keys.indexOf(n) >= 0 && new Date(when).getTime() >= since; };
    var mine = false;
    if (!(it.done || {}).ig) igm.forEach(function (m) { if (!(it.done || {}).ig && hit(m.caption, m.timestamp)) { it.done = it.done || {}; it.done.ig = m.permalink; ch = mine = true; } });
    if (!(it.done || {}).fb) fbm.forEach(function (m) { if (!(it.done || {}).fb && hit(m.description, m.created_time)) { it.done = it.done || {}; it.done.fb = /^http/.test(m.permalink_url || '') ? (m.permalink_url.indexOf('http') === 0 ? m.permalink_url : 'https://www.facebook.com' + m.permalink_url) : 'https://www.facebook.com/reel/' + m.id; ch = mine = true; } });
    if (mine) { var left = ['ig', 'fb', 'yt'].filter(function (p) { return (it.platforms || {})[p] && !(it.done || {})[p] && ready_(p); }); if (!left.length && it.status !== 'posted') it.status = Object.keys(it.done).length >= ['ig', 'fb', 'yt'].filter(function (p) { return (it.platforms || {})[p]; }).length ? 'posted' : 'partial'; }
  });
  return ch;
}
function report_(id, quiet) {   // write status + ticks + links back to the Tasks tab (only when something changed)
  var pin = P.getProperty('EDIT_PIN'); if (!pin) return;
  var q = load_(), it = find_(q, id); if (!it || !/^e-/.test(id)) return;
  var st = !it.approved ? 'waiting' : it.auto === false ? '' : it.status, w = waitingFor_(it);
  var err = (it.lastError || '') + (w.length && st !== 'waiting' ? (it.lastError ? ' | ' : '') + w.join('+').replace('yt', 'YouTube').replace('ig', 'Instagram').replace('fb', 'Facebook') + ' not connected yet' : '');
  var sig = JSON.stringify([st, err, it.done || {}]); if (sig === it.repSig) return;
  var patch = { apSt: st, apErr: err.slice(0, 290), done: {} };
  Object.keys(it.done || {}).forEach(function (p) { if (/^https:/.test(it.done[p])) patch.done[p] = it.done[p]; });
  var r = UrlFetchApp.fetch(SITE + '/api/plan', { method: 'post', contentType: 'application/json', headers: { 'x-pin': pin }, payload: JSON.stringify({ id: id, patch: patch }), muteHttpExceptions: true });
  if (r.getResponseCode() === 200) { it.repSig = sig; save_(q); }
}
function ready_(pl) { return pl === 'yt' ? !!P.getProperty('YT_REFRESH_TOKEN') : !!P.getProperty('META_PAGE_TOKEN'); }   // platform connected?
function wanted_(it) { var p = it.platforms || { ig: true, fb: true, yt: true }; return ['ig', 'fb', 'yt'].filter(function (x) { return p[x] !== false && ready_(x); }); }
function waitingFor_(it) { var p = it.platforms || { ig: true, fb: true, yt: true }; return ['ig', 'fb', 'yt'].filter(function (x) { return p[x] !== false && !ready_(x) && !(it.done || {})[x]; }); }
function postItem_(id) {
  var q = load_(), it = find_(q, id); if (!it) return;
  if (it.coverUrl && it.coverSrc !== it.coverUrl) { try { it.coverId = coverFromUrl_(it.coverUrl, (it.k || id) + ' cover.jpg'); it.coverSrc = it.coverUrl; it.ytCoverId = it.coverId; } catch (e) { it.coverId = ''; } }
  if (!it.coverId) { it.status = 'failed'; it.lastError = 'no cover image: strict rule, never post without the cover'; save_(q); return; }
  it.status = 'posting'; it.postStart = Date.now(); save_(q);
  var text = (it.caption || '') + (it.hashtags ? '\n\n' + it.hashtags : ''), errs = [];
  wanted_(it).forEach(function (pl) {
    if (it.done && it.done[pl]) return;   // already posted there: never twice
    try {
      var url = pl === 'ig' ? postIG_(it, text) : pl === 'fb' ? postFB_(it, text) : postYT_(it, text);
      it.done = it.done || {}; it.done[pl] = url; log_(q, id, pl + ' posted ' + url); var fq = load_(), fx = find_(fq, id); fx.done = it.done; save_(fq);   // saved at once: a cut-off run can never post it twice
    } catch (e) { errs.push(pl + ': ' + e.message); log_(q, id, pl + ' FAILED ' + e.message); }
  });
  var left = wanted_(it).filter(function (pl) { return !(it.done || {})[pl]; });
  it.status = left.length === 0 ? 'posted' : (Object.keys(it.done || {}).length ? 'partial' : 'failed');
  it.tries = (it.tries || 0) + (errs.length ? 1 : 0); if (it.tries >= 3 && left.length) it.status = 'failed';
  it.lastError = errs.join(' | '); it.postedAt = new Date().toISOString();
  var fresh = load_(); var j = fresh.items.map(function (x) { return x.id; }).indexOf(id); fresh.items[j] = it; fresh.log = q.log; save_(fresh);
  if (it.warns && it.warns.length) MailApp.sendEmail(P.getProperty('ALERT_MAIL') || Session.getEffectiveUser().getEmail(), 'GradeNext auto-post: check the cover of ' + (it.title || id), it.warns.join('\n'));
  if (errs.length && it.status === 'failed') MailApp.sendEmail(P.getProperty('ALERT_MAIL') || Session.getEffectiveUser().getEmail(), 'GradeNext auto-post failed: ' + (it.title || id), it.lastError);
}
function publicVideoUrl_(fileId) {   // Meta downloads the video itself: file must be "anyone with the link"
  DriveApp.getFileById(fileId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.usercontent.google.com/download?export=download&confirm=t&id=' + fileId;
}
function fetch_(url, opt) {
  opt = opt || {}; opt.muteHttpExceptions = true; var r = UrlFetchApp.fetch(url, opt), c = r.getResponseCode(), t = r.getContentText();
  var j = {}; try { j = JSON.parse(t); } catch (x) {}
  if (c >= 300 || j.error) throw new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + c + ' ' + t.slice(0, 200)));
  return j;
}
/* ---- Instagram Reel: create container -> wait until FINISHED -> publish ---- */
function postIG_(it, text) {
  var tok = P.getProperty('META_PAGE_TOKEN'), ig = P.getProperty('IG_USER_ID');
  var pay = { media_type: 'REELS', video_url: publicVideoUrl_(it.fileId), caption: text, share_to_feed: 'true', cover_url: publicVideoUrl_(it.coverId), access_token: tok };   // strict: cover + Dr. Shahid's city
  if (PLACE_) pay.location_id = PLACE_;
  var c; try { c = fetch_(GRAPH + '/' + ig + '/media', { method: 'post', payload: pay }); }
  catch (e) { if (!pay.location_id) throw e; delete pay.location_id; c = fetch_(GRAPH + '/' + ig + '/media', { method: 'post', payload: pay }); warn_(it, 'instagram location not accepted: ' + e.message); }
  for (var i = 0; i < 40; i++) {   // up to ~4 min while Instagram processes the video
    Utilities.sleep(6000); var s = fetch_(GRAPH + '/' + c.id + '?fields=status_code,status&access_token=' + tok);
    if (s.status_code === 'FINISHED') break; if (s.status_code === 'ERROR') throw new Error('instagram processing: ' + s.status);
  }
  var m = fetch_(GRAPH + '/' + ig + '/media_publish', { method: 'post', payload: { creation_id: c.id, access_token: tok } });
  var p = fetch_(GRAPH + '/' + m.id + '?fields=permalink&access_token=' + tok); return p.permalink;
}
/* ---- Facebook Page Reel: start -> upload by URL -> finish (publish) ---- */
function postFB_(it, text) {
  var tok = P.getProperty('META_PAGE_TOKEN'), page = P.getProperty('META_PAGE_ID');
  var s = fetch_(GRAPH + '/' + page + '/video_reels', { method: 'post', payload: { upload_phase: 'start', access_token: tok } });
  fetch_(s.upload_url || ('https://rupload.facebook.com/video-upload/v21.0/' + s.video_id), { method: 'post', headers: { Authorization: 'OAuth ' + tok, file_url: publicVideoUrl_(it.fileId) } });
  var fin = { upload_phase: 'finish', video_id: s.video_id, video_state: 'PUBLISHED', description: text, access_token: tok };
  if (PLACE_) fin.place = PLACE_;
  try { fetch_(GRAPH + '/' + page + '/video_reels', { method: 'post', payload: fin }); }
  catch (e) { if (!fin.place) throw e; delete fin.place; fetch_(GRAPH + '/' + page + '/video_reels', { method: 'post', payload: fin }); warn_(it, 'facebook location not accepted: ' + e.message); }
  try { fetch_(GRAPH + '/' + s.video_id + '/thumbnails', { method: 'post', payload: { source: DriveApp.getFileById(it.coverId).getBlob(), is_preferred: 'true', access_token: tok } }); }
  catch (e) { warn_(it, 'facebook cover: ' + e.message); }
  return 'https://www.facebook.com/reel/' + s.video_id;
}
/* One-time YouTube setup (Nov 13): Script Properties YT_CLIENT_ID + YT_CLIENT_SECRET (from the Google Cloud OAuth client) and
   YT_AUTH_CODE (the "code=" from the sign-in link, where the GradeNext channel was picked). Run connectYouTube():
   it swaps the code for a permanent refresh token, checks it is the GradeNext channel, and deletes the code. */
var YT_CHANNEL = 'UCYYqF7G1xmjTcZCfRt5U05Q';   // GradeNext (brand channel) - posts only ever go here
function connectYouTube() {
  var code = (P.getProperty('YT_AUTH_CODE') || '').trim();
  if (code) {
    code = decodeURIComponent(code.replace(/^.*[?&]code=/, '').replace(/&.*$/, ''));
    var r = fetch_('https://oauth2.googleapis.com/token', { method: 'post', payload: { code: code, client_id: P.getProperty('YT_CLIENT_ID'), client_secret: P.getProperty('YT_CLIENT_SECRET'),
      redirect_uri: 'https://developers.google.com/oauthplayground', grant_type: 'authorization_code' } });
    P.deleteProperty('YT_AUTH_CODE');
    if (!r.refresh_token) throw new Error('No refresh token returned - open the sign-in link again (it must ask for consent).');
    P.setProperty('YT_REFRESH_TOKEN', r.refresh_token);
  }
  var ch = JSON.parse(UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + ytToken_() }, muteHttpExceptions: true }).getContentText());
  var it = (ch.items || [])[0];
  if (!it || it.id !== YT_CHANNEL) { P.deleteProperty('YT_REFRESH_TOKEN'); throw new Error('Wrong channel: ' + (it ? it.snippet.title + ' ' + it.id : JSON.stringify(ch).slice(0, 200)) + ' - sign in again and pick GradeNext (' + YT_CHANNEL + ').'); }
  Logger.log('YouTube ready: ' + it.snippet.title + ' (' + it.id + ')');
}
/* ---- YouTube: resumable upload with the channel's own refresh token (works for Brand channels) ---- */
function ytToken_() {
  var r = fetch_('https://oauth2.googleapis.com/token', { method: 'post', payload: { client_id: P.getProperty('YT_CLIENT_ID'), client_secret: P.getProperty('YT_CLIENT_SECRET'),
    refresh_token: P.getProperty('YT_REFRESH_TOKEN'), grant_type: 'refresh_token' } });
  return r.access_token;
}
function postYT_(it, text) {
  var tok = ytToken_(), file = DriveApp.getFileById(it.fileId), size = file.getSize(), short = it.ytKind !== 'video';
  var title = (it.title || 'GradeNext').slice(0, 95) + (short && !/#shorts/i.test(it.title || '') ? ' #shorts' : '');
  var meta = { snippet: { title: title, description: text, tags: (it.hashtags || '').split(/\s+/).filter(Boolean).map(function (h) { return h.replace('#', ''); }), categoryId: '27' },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    recordingDetails: { locationDescription: 'San Francisco, California', location: { latitude: 37.7749, longitude: -122.4194, altitude: 0 } } };   // strict: Dr. Shahid's location
  var init = UrlFetchApp.fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,recordingDetails', { method: 'post', muteHttpExceptions: true,
    contentType: 'application/json; charset=UTF-8', headers: { Authorization: 'Bearer ' + tok, 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) }, payload: JSON.stringify(meta) });
  if (init.getResponseCode() >= 300) throw new Error('youtube init ' + init.getContentText().slice(0, 200));
  var loc = init.getHeaders()['Location'] || init.getHeaders()['location'], v = null, CH = 32 * 1024 * 1024;   // 32 MB pieces: any video size works
  for (var a = 0; a < size && !v; a += CH) {
    var b = Math.min(size, a + CH) - 1;
    var part = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + it.fileId + '?alt=media', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + a + '-' + b } }).getBlob().getBytes();
    var up = UrlFetchApp.fetch(loc, { method: 'put', muteHttpExceptions: true, contentType: 'video/mp4', payload: part, headers: { Authorization: 'Bearer ' + tok, 'Content-Range': 'bytes ' + a + '-' + b + '/' + size } });
    var c = up.getResponseCode(); if (c === 200 || c === 201) v = JSON.parse(up.getContentText()); else if (c !== 308) throw new Error('youtube upload ' + c + ' ' + up.getContentText().slice(0, 160));
  }
  if (!v) throw new Error('youtube upload did not finish');
  var th = UrlFetchApp.fetch('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=' + v.id, { method: 'post', contentType: 'image/jpeg',   // strict: always try, report failures
    payload: DriveApp.getFileById(it.ytCoverId || it.coverId).getBlob().getBytes(), headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true });   // YouTube needs a JPG under 2 MB (ytCoverId)
  if (th.getResponseCode() >= 300) warn_(it, 'youtube thumbnail' + (short ? ' (Short: set the cover by hand in the YouTube app)' : '') + ': ' + th.getContentText().slice(0, 160));
  return short ? 'https://www.youtube.com/shorts/' + v.id : 'https://www.youtube.com/watch?v=' + v.id;
}
function warn_(it, msg) { (it.warns = it.warns || []).push(new Date().toISOString() + ' ' + msg); }   // saved with the item; shown + mailed after posting
/* One-time Meta setup: Aryan pastes the long-lived token from Meta's Access Token Debugger into Script Property META_USER_TOKEN,
   then runs setupMeta(). It stores a never-expiring Page token + the Instagram id, and deletes the user token. */
function setupMeta() {
  var ut = P.getProperty('META_USER_TOKEN'); if (!ut) throw new Error('Add Script Property META_USER_TOKEN first');
  var pages = fetch_(GRAPH + '/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=' + ut).data || [];
  var pg = pages.filter(function (x) { return x.name === 'GradeNext'; })[0] || pages[0]; if (!pg) throw new Error('no Page found');
  P.setProperty('META_PAGE_ID', pg.id); P.setProperty('META_PAGE_TOKEN', pg.access_token);
  if (pg.instagram_business_account) P.setProperty('IG_USER_ID', pg.instagram_business_account.id);
  P.deleteProperty('META_USER_TOKEN');
  var d = fetch_(GRAPH + '/debug_token?input_token=' + pg.access_token + '&access_token=' + pg.access_token).data || {};
  Logger.log('Meta ready: page ' + pg.name + ', instagram ' + (pg.instagram_business_account || {}).id + ', token expires: ' + (d.expires_at ? new Date(d.expires_at * 1000) : 'never'));
}
/* ---------------- Meta test with the "15% tip" video (x32) ----------------
   1) checkTestX32(): read-only. Shows exactly what will be posted + San Francisco time + location check + latest real posts. Posts NOTHING.
   2) goTestX32(): only on Aryan's "go". Schedules x32 for Instagram + Facebook 5 minutes from now (San Francisco time) and starts the 5-minute timer. */
var X32 = { id: 'x32', k: 'x32', title: '15% tip on $40, in 3 seconds', fileId: '1SR6D6-Ph3TT5odIaxxn32WN0qCPMDN80',
  coverUrl: 'https://gradenext-inventory.vercel.app/media/x32_cover.jpg',
  caption: "15% tip on $40, in 3 seconds\n\nA mental-math trick your kid will use for life.\nDon't just memorize Math. Understand it with GradeNext. Free 14-day trial, link in bio.\nSave this for homework night. Send this to someone who always grabs a calculator.",
  hashtags: '#gradenext #mentalmath #percentages #mathforkids #mathtricks', ytKind: 'short', platforms: { ig: true, fb: true, yt: false }, approved: true };
var SF_PLACE = '114952118516947';   // Facebook place "San Francisco, California" (verified on facebook.com/places, Nov 6)
function coverFromUrl_(url, name) { return DriveApp.createFile(UrlFetchApp.fetch(url).getBlob().getAs('image/jpeg').setName(name)).getId(); }
function checkTestX32() {
  var tok = P.getProperty('META_PAGE_TOKEN'), ig = P.getProperty('IG_USER_ID'), page = P.getProperty('META_PAGE_ID'), L = [];
  var me = fetch_(GRAPH + '/' + page + '?fields=name&access_token=' + tok); L.push('Page: ' + me.name + ' | Instagram id: ' + ig);
  try { var pl = fetch_(GRAPH + '/' + SF_PLACE + '?fields=name,location&access_token=' + tok); L.push('Location: ' + pl.name + ' ' + JSON.stringify(pl.location || {})); }
  catch (e) { L.push('Location check failed: ' + e.message); }
  var when = new Date(Date.now() + 5 * 60000);
  L.push('Would post at: ' + Utilities.formatDate(when, TZ, 'EEE MMM d yyyy, h:mm a') + ' San Francisco time (' + TZ + ')');
  L.push('Video file: ' + DriveApp.getFileById(X32.fileId).getName() + ' (' + Math.round(DriveApp.getFileById(X32.fileId).getSize() / 1e6) + ' MB)');
  L.push('Cover: ' + X32.coverUrl);
  L.push('Caption + hashtags:\n' + X32.caption + '\n\n' + X32.hashtags);
  var recent = fetch_(GRAPH + '/' + ig + '/media?fields=caption,timestamp,permalink&limit=5&access_token=' + tok).data || [];
  L.push('Latest real Instagram posts:'); recent.forEach(function (m) { L.push('  ' + m.timestamp + ' ' + (m.caption || '').split('\n')[0].slice(0, 60) + ' ' + m.permalink); });
  L.push(recent.some(function (m) { return /15% tip/i.test(m.caption || ''); }) ? 'WARNING: a 15% tip post already exists on Instagram' : 'OK: 15% tip is not on Instagram yet');
  Logger.log(L.join('\n')); return L.join('\n');
}
function goTestX32() {
  var it = JSON.parse(JSON.stringify(X32)); it.coverId = coverFromUrl_(it.coverUrl, 'x32 cover.jpg'); delete it.coverUrl;
  var when = new Date(Date.now() + 5 * 60000); it.date = Utilities.formatDate(when, TZ, 'yyyy-MM-dd'); it.time = Utilities.formatDate(when, TZ, 'HH:mm');
  P.setProperty('IG_LOCATION_ID', SF_PLACE); P.setProperty('FB_PLACE_ID', SF_PLACE);
  var q = load_(), old = find_(q, it.id); if (old && old.done && Object.keys(old.done).length) throw new Error('x32 already posted: ' + JSON.stringify(old.done));
  q.items = q.items.filter(function (x) { return x.id !== it.id; }); it.status = 'scheduled'; it.done = {}; q.items.push(it); save_(q);
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runDue'; })) ScriptApp.newTrigger('runDue').timeBased().everyMinutes(5).create();
  Logger.log('Scheduled x32 for ' + it.date + ' ' + it.time + ' San Francisco time (Instagram + Facebook). The timer posts it within 5 minutes after that.');
}
/* ---------------- health ---------------- */
function status_() {
  var out = { now: new Date().toISOString(), ok: {} };
  try { fetch_(GRAPH + '/me?access_token=' + P.getProperty('META_PAGE_TOKEN')); out.ok.meta = true; } catch (e) { out.ok.meta = e.message; }
  try { ytToken_(); out.ok.youtube = true; } catch (e) { out.ok.youtube = e.message; }
  out.log = (load_().log || []).slice(-20); return out;
}
function setupTrigger() {   // run once
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'runDue') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runDue').timeBased().everyMinutes(5).create();
}
/* Nov 7: the website's storage was moved (old data unreadable). Run once: sends every task's real status, ticks and links back to the site. */
function resyncSite() { var q = load_(); q.items.forEach(function (it) { delete it.repSig; }); save_(q); syncSite_(); Logger.log('resynced ' + load_().items.length + ' items'); }

/* Check (Nov 14): upload one approved video to YouTube as PRIVATE, confirm it worked, then delete it. Nothing public. */
function testYT() {
  var q = load_(), c = q.items.filter(function (x) { return x.fileId; }).slice(-12).map(function (x) { try { return [x, DriveApp.getFileById(x.fileId).getSize()]; } catch (e) { return null; } }).filter(String).sort(function (a, b) { return a[1] - b[1]; })[0];
  var it = c[0], tok = ytToken_(), blob = DriveApp.getFileById(it.fileId).getBlob();
  var init = UrlFetchApp.fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'post', muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + tok, 'X-Upload-Content-Type': 'video/mp4' }, payload: JSON.stringify({ snippet: { title: 'Pulse test - deleting', description: 'auto test' }, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } }) });
  if (init.getResponseCode() >= 300) throw new Error('init ' + init.getContentText().slice(0, 300));
  var up = UrlFetchApp.fetch(init.getHeaders()['Location'], { method: 'put', contentType: 'video/mp4', payload: blob.getBytes(), muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + tok } });
  var v = JSON.parse(up.getContentText()); Logger.log('upload ' + up.getResponseCode() + ' id=' + v.id + ' channel=' + (v.snippet && v.snippet.channelId) + ' size=' + c[1]);
  var del = UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/videos?id=' + v.id, { method: 'delete', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + tok } });
  Logger.log('delete ' + del.getResponseCode());
  var due = q.items.filter(function (x) { return x.platforms && x.platforms.yt && !(x.done && x.done.yt); }).map(function (x) { return x.id + ' ' + x.date + ' ' + x.time + (x.approved ? ' approved' : ' waiting'); });
  Logger.log('YouTube still to post: ' + due.length + '\n' + due.slice(0, 25).join('\n'));
}

/* ---------------- YouTube catch-up (Nov 14, channel connected by Kuldeep sir) ----------------
   ytChannel_(): every video on the GradeNext channel (incl. private / scheduled).  ytFix(): ticks = what is really on YouTube.
   ytBacklog_(): approved videos that never reached YouTube go up 2 a day (09:00 and 15:00 San Francisco) until none are left. */
var YT_SKIP = ['e-x08'];   // Dr. Shahid's own draft in Studio: never upload again
function ytNorm_(s) { return String(s || '').toLowerCase().replace(/#\w+/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function ytChannel_() {
  var h = { Authorization: 'Bearer ' + ytToken_() }, get = function (u) { return JSON.parse(UrlFetchApp.fetch(u, { headers: h, muteHttpExceptions: true }).getContentText()); };
  var up = get('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true').items[0].contentDetails.relatedPlaylists.uploads, ids = [], tok = '';
  for (var n = 0; n < 10; n++) { var p = get('https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=' + up + (tok ? '&pageToken=' + tok : '')); (p.items || []).forEach(function (i) { ids.push(i.contentDetails.videoId); }); tok = p.nextPageToken; if (!tok) break; }
  var out = [];
  for (var i = 0; i < ids.length; i += 50) get('https://www.googleapis.com/youtube/v3/videos?part=snippet,status,statistics&id=' + ids.slice(i, i + 50).join(',')).items.forEach(function (x) {
    out.push({ id: x.id, title: x.snippet.title, n: ytNorm_(x.snippet.title), status: x.status.privacyStatus, publishAt: x.status.publishAt || '', views: +((x.statistics || {}).viewCount || 0) }); });
  return out;
}
function ytMatch_(it, ch) { var id = String((it.done || {}).yt || '').match(/(?:shorts\/|v=)([\w-]{11})/); if (id) { var a = ch.filter(function (c) { return c.id === id[1]; })[0]; if (a) return a; }
  var t = ytNorm_(it.title); return t ? ch.filter(function (c) { return c.n === t || c.n.indexOf(t) === 0 || t.indexOf(c.n) === 0 && c.n.length > 12; })[0] : null; }
function ytUrl_(c, it) { return (it.ytKind === 'video' ? 'https://www.youtube.com/watch?v=' : 'https://www.youtube.com/shorts/') + c.id; }
function ytFix() {   // run any time: makes every YouTube tick match the real channel
  var q = load_(), ch = ytChannel_(), n = 0, rep = [];
  q.items.forEach(function (it) { if (!it.fileId) return; var c = ytMatch_(it, ch), cur = (it.done || {}).yt || '';
    if (c && cur !== ytUrl_(c, it)) { it.done = it.done || {}; it.done.yt = ytUrl_(c, it); n++; rep.push(it.id); log_(q, it.id, 'yt found on channel ' + it.done.yt + ' (' + c.status + ')'); }
    else if (!c && cur) { delete it.done.yt; n++; rep.push(it.id); log_(q, it.id, 'yt tick removed: not on the channel'); } });
  save_(q); rep.forEach(function (id) { try { report_(id); } catch (e) {} });
  Logger.log('channel videos: ' + ch.length + ' | fixed ticks: ' + n + ' ' + rep.join(' ')); return ch;
}
function ytViews_() { var q = load_(), ch = ytChannel_(), o = {}; q.items.forEach(function (it) { var c = ytMatch_(it, ch); if (c && it.k) o[it.k] = c.views; }); return o; }
function ytBacklog_() {
  if (!P.getProperty('YT_REFRESH_TOKEN')) return;
  var now = new Date(), day = Utilities.formatDate(now, TZ, 'yyyy-MM-dd'), hm = Utilities.formatDate(now, TZ, 'HH:mm'), slot = hm >= '15:00' ? 'b' : hm >= '09:00' ? 'a' : '';
  if (!slot || P.getProperty('YT_BACKLOG_' + slot) === day) return;
  var q = load_(), ch = ytChannel_();
  var todo = q.items.filter(function (it) { var pl = it.platforms || {}; return it.approved && it.fileId && pl.yt !== false && YT_SKIP.indexOf(it.id) < 0 && !(it.done || {}).yt && it.date && it.date < day && (it.status === 'posted' || it.status === 'partial' || it.status === 'missed'); })
    .sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
  P.setProperty('YT_BACKLOG_' + slot, day);
  for (var i = 0; i < todo.length; i++) { var it = todo[i], c = ytMatch_(it, ch);
    if (c) { it.done = it.done || {}; it.done.yt = ytUrl_(c, it); log_(q, it.id, 'yt already on channel ' + it.done.yt); save_(q); report_(it.id); continue; }
    var url = postYT_(it, (it.caption || '') + (it.hashtags ? '\n\n' + it.hashtags : ''));
    var fq = load_(), fx = find_(fq, it.id); fx.done = fx.done || {}; fx.done.yt = url; log_(fq, it.id, 'yt backlog posted ' + url); save_(fq); report_(it.id);
    return;   // one per slot
  }
}
function ytBacklogList() { var q = load_(), day = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); Logger.log(q.items.filter(function (it) { var pl = it.platforms || {}; return it.approved && it.fileId && pl.yt !== false && YT_SKIP.indexOf(it.id) < 0 && !(it.done || {}).yt && it.date < day; }).map(function (it) { return it.id + ' ' + it.date + ' ' + it.status; }).join('\n')); }

function fbRepostStatus() { Logger.log(P.getProperty('FB_REPOST_DONE')); var q = load_(); FB_REPOST_.forEach(function (r) { var it = find_(q, r[0]); Logger.log(r[0] + ' ' + r[1] + ' ' + r[2] + ' fb=' + (it && it.done && it.done.fb) + ' old=' + (it && it.oldFb)); }); }
